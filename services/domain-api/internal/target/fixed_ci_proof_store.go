package target

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type fixedCIProofAuthority struct{}

// Only startup constructs this capability. It does not grant the generic Store
// or any caller-supplied Principal permission to promote a receipt.
type FixedCIProofVerifier struct {
	store   *Store
	profile FixedCIProofTrustProfile
}

func NewFixedCIProofVerifier(store *Store, profile FixedCIProofTrustProfile) (*FixedCIProofVerifier, error) {
	if err := profile.validate(); err != nil {
		return nil, err
	}
	return &FixedCIProofVerifier{store: store, profile: profile}, nil
}

func fixedCIProofMismatch() error {
	return &Error{Status: 409, Code: "FIXED_CI_PROOF_CONTEXT_MISMATCH", Message: "Fixed CI proof context is unavailable or changed"}
}

func (verifier *FixedCIProofVerifier) Record(ctx context.Context, workspaceID, key string, input FixedCIProofInput) (AgentLifecycleResult, error) {
	if verifier == nil || verifier.store == nil {
		return AgentLifecycleResult{}, forbidden("FIXED_CI_PROOF_DISABLED", "Fixed CI proof is not configured")
	}
	if err := input.validate(workspaceID, key); err != nil {
		return AgentLifecycleResult{}, err
	}
	p := verifier.profile
	verifiedAt, _ := time.Parse(time.RFC3339Nano, input.CI.VerifiedAt)
	now := time.Now()
	if workspaceID != p.WorkspaceID || input.TargetID != p.TargetID || input.TargetRevisionID != p.TargetRevisionID || input.GraphRevisionID != p.GraphRevisionID || input.CI.TestedCommit != p.WorkflowExecutionSHA || verifiedAt.After(now.Add(time.Minute)) || verifiedAt.Before(now.Add(-time.Duration(p.MaxAgeMS)*time.Millisecond)) {
		return AgentLifecycleResult{}, fixedCIProofMismatch()
	}
	meta := agentCommandMeta{WorkspaceID: workspaceID, Principal: Principal{Type: "service", ID: fixedCIProofPrincipalID}, CommandType: fixedCIProofCommand, IdempotencyKey: key,
		RequestHash: proofHash(map[string]any{"input": input, "trustProfileSha256": p.SHA256()})}
	var command AgentLifecycleCommand[RecordIntegrationRunInput]
	var proof *validatedCriterionProof
	tx, replay, err := verifier.store.beginLifecycleCommandWithAdmission(ctx, meta, true, func(tx pgx.Tx) error {
		var err error
		command, proof, err = verifier.admit(ctx, tx, meta, input)
		return err
	})
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return verifier.store.recordIntegrationRun(ctx, tx, command, proof)
}

func (verifier *FixedCIProofVerifier) admit(ctx context.Context, tx pgx.Tx, meta agentCommandMeta, input FixedCIProofInput) (AgentLifecycleCommand[RecordIntegrationRunInput], *validatedCriterionProof, error) {
	return verifier.admitForRequirement(ctx, tx, meta, input, "fixed_ci")
}

// Shared domain/source checks; only the two closed verifier capabilities call it.
func (verifier *FixedCIProofVerifier) admitForRequirement(ctx context.Context, tx pgx.Tx, meta agentCommandMeta, input FixedCIProofInput, kind string) (AgentLifecycleCommand[RecordIntegrationRunInput], *validatedCriterionProof, error) {
	var command AgentLifecycleCommand[RecordIntegrationRunInput]
	p := verifier.profile
	verifiedAt, _ := time.Parse(time.RFC3339Nano, input.CI.VerifiedAt)
	if now := time.Now(); verifiedAt.After(now.Add(time.Minute)) || verifiedAt.Before(now.Add(-time.Duration(p.MaxAgeMS)*time.Millisecond)) {
		return command, nil, fixedCIProofMismatch()
	}
	var raw []byte
	err := tx.QueryRow(ctx, `select revision.acceptance_criteria
		from verrail_targets target
		join companies workspace on workspace.id=target.workspace_id and workspace.status='active'
		join verrail_target_revisions revision on revision.id=target.active_target_revision_id and revision.workspace_id=target.workspace_id and revision.target_id=target.id
		join verrail_work_graphs graph on graph.workspace_id=target.workspace_id and graph.target_id=target.id and graph.status!='canceled'
		join verrail_graph_revisions gr on gr.id=graph.active_graph_revision_id and gr.workspace_id=target.workspace_id and gr.work_graph_id=graph.id and gr.target_id=target.id and gr.target_revision_id=revision.id and gr.status='active'
		join verrail_github_repo_bindings binding on binding.workspace_id=target.workspace_id and binding.id=$5 and binding.connection_id=$6 and binding.repo_owner||'/'||binding.repo_name=$7
		join tool_connections connection on connection.id=binding.connection_id and connection.company_id=target.workspace_id and connection.enabled and connection.status='active' and connection.auth_kind in ('oauth','api_key')
		where target.workspace_id=$1 and target.id=$2 and revision.id=$3 and gr.id=$4 and target.status!='canceled'
		for share of target,workspace,graph,gr,connection,binding`, p.WorkspaceID, p.TargetID, p.TargetRevisionID, p.GraphRevisionID, p.BindingID, p.ConnectionID, p.Repository).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return command, nil, fixedCIProofMismatch()
	}
	if err != nil {
		return command, nil, err
	}
	var criteria []AcceptanceCriterion
	if err := json.Unmarshal(raw, &criteria); err != nil {
		return command, nil, err
	}
	var contract *CriterionProofContract
	var requirement *CriterionProofRequirement
	for _, criterion := range criteria {
		if criterion.ID == input.CriterionKey {
			contract = criterion.ProofContract
		}
	}
	if contract != nil {
		if err := ValidateCriterionProofContract(contract); err != nil {
			return command, nil, err
		}
		for _, candidate := range contract.AllOf {
			if candidate.ID == input.RequirementID {
				copy := candidate
				requirement = &copy
			}
		}
	}
	if requirement == nil || requirement.Kind != "independent_verification" || requirement.Phase != "pre_acceptance" ||
		(kind == "fixed_ci" && !fixedCIAssertionsSupported(requirement.Assertions)) ||
		(kind != "fixed_ci" && (kind == "" || deliveryProofKindForAssertions(requirement.Assertions) != kind)) {
		return command, nil, forbidden("FIXED_CI_PROOF_UNSUPPORTED_REQUIREMENT", "Fixed CI cannot verify this requirement")
	}
	var valid bool
	err = tx.QueryRow(ctx, `select claim.target_id=$3 and claim.target_revision_id=$4 and claim.criterion_key=$5
		and node.target_id=$3 and node.graph_revision_id=$6 and node.kind='integration_task'
		and (node.status in ('ready','running') or node.status in ('completed','blocked') and exists(
		select 1 from verrail_criterion_proofs proof join verrail_integration_runs integration on integration.id=proof.integration_run_id and integration.workspace_id=proof.workspace_id
		where proof.workspace_id=$1 and integration.work_node_id=node.id and proof.target_revision_id=$4 and proof.graph_revision_id=$6 and proof.criterion_key=$5 and proof.requirement_id=$8 and proof.submission_id is null and proof.effect_receipt_id is null))
		from verrail_claims claim join verrail_work_nodes node on node.id=$7 and node.workspace_id=claim.workspace_id
		where claim.workspace_id=$1 and claim.id=$2 for update of node`, p.WorkspaceID, input.ClaimID, p.TargetID, p.TargetRevisionID, input.CriterionKey, p.GraphRevisionID, input.WorkNodeID, input.RequirementID).Scan(&valid)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !valid {
		return command, nil, fixedCIProofMismatch()
	}
	if err != nil {
		return command, nil, err
	}
	objectHash, err := validateFixedCISource(ctx, tx, p, input)
	if err != nil {
		return command, nil, err
	}
	coverage := map[string]any{"contractHash": proofHash(contract), "requirementId": requirement.ID, "assertions": requirement.Assertions,
		"targetRevisionId": p.TargetRevisionID, "graphRevisionId": p.GraphRevisionID, "commitRef": input.CI.TestedCommit,
		"verifiedAt": input.CI.VerifiedAt, "providerRunId": input.CI.ProviderRunID, "providerAttempt": input.CI.ProviderAttempt}
	reference := "https://github.com/" + p.Repository + "/actions/runs/" + input.CI.ProviderRunID + "/attempts/" + strconv.FormatInt(input.CI.ProviderAttempt, 10)
	command = AgentLifecycleCommand[RecordIntegrationRunInput]{WorkspaceID: meta.WorkspaceID, Principal: meta.Principal, CommandType: meta.CommandType, IdempotencyKey: meta.IdempotencyKey, RequestHash: meta.RequestHash,
		Input: RecordIntegrationRunInput{TargetID: p.TargetID, TargetRevisionID: p.TargetRevisionID, GraphRevisionID: p.GraphRevisionID, ClaimID: input.ClaimID, WorkNodeID: input.WorkNodeID,
			ConnectorVersion: FixedCIProofVerifierVersion, ConnectionID: p.ConnectionID, Provider: "github", ExternalRef: reference, CommitRef: input.CI.TestedCommit, CriterionKey: input.CriterionKey,
			EnvironmentRef: "github:" + p.Repository + ":" + input.CI.TestedCommit, Conclusion: "success", ObjectHash: objectHash, Reference: reference,
			ProofContext:    &CriterionProofContext{RequirementID: input.RequirementID},
			ProviderReceipt: map[string]any{"kind": "verrail.fixed-ci-proof", "schemaVersion": 1, "verifierVersion": FixedCIProofVerifierVersion, "trustProfileSha256": p.SHA256(), "trustProfile": p, "input": input, "criterionProof": coverage}}}
	if err := ValidateRecordIntegrationRunInput(&command.Input); err != nil {
		return command, nil, err
	}
	proof, err := validateIntegrationProof(ctx, tx, command)
	if err != nil {
		return command, nil, err
	}
	if kind == "fixed_ci" {
		proof.fixedCIVerifier = &fixedCIProofAuthority{}
	}
	return command, proof, nil
}

type fixedCINativeArtifact struct {
	Ordinal        int    `json:"ordinal"`
	Path           string `json:"path"`
	Type           string `json:"type"`
	Kind           string `json:"kind"`
	Title          string `json:"title"`
	ContentHash    string `json:"contentHash"`
	ContentRef     string `json:"contentRef"`
	SourceSnapshot struct {
		SchemaVersion       int    `json:"schemaVersion"`
		Format              string `json:"format"`
		ScopeVersion        int    `json:"scopeVersion"`
		SnapshotTree        string `json:"snapshotTree"`
		SourceContentSHA256 string `json:"sourceContentSha256"`
	} `json:"sourceSnapshot"`
}

func validateFixedCISource(ctx context.Context, tx pgx.Tx, p FixedCIProofTrustProfile, input FixedCIProofInput) (string, error) {
	var raw []byte
	var title, contentHash, contentRef, sourceNodeID, deploymentID, agentVersionID string
	var fence int64
	err := tx.QueryRow(ctx, `select artifact.title,revision.content_hash,revision.content_ref,run.work_node_id,attempt.deployment_revision_id,attempt.agent_version_id,attempt.fencing_token,event.payload
		from verrail_artifact_revisions revision
		join verrail_artifacts artifact on artifact.id=revision.artifact_id and artifact.workspace_id=revision.workspace_id and artifact.target_id=$3 and artifact.kind='code_change' and artifact.created_by_principal_type='service' and artifact.created_by_principal_id=$9
		join verrail_runs run on run.id=revision.source_run_id and run.workspace_id=revision.workspace_id and run.id=$4 and run.work_node_id=revision.source_work_node_id and run.target_id=$3 and run.target_revision_id=$7 and run.graph_revision_id=$8 and run.status='succeeded' and run.kind='agent'
		join verrail_work_nodes node on node.id=run.work_node_id and node.workspace_id=run.workspace_id and node.target_id=run.target_id and node.graph_revision_id=run.graph_revision_id and node.kind='agent_task' and node.status='completed'
		join verrail_run_attempts attempt on attempt.id=$5 and attempt.run_id=run.id and attempt.workspace_id=run.workspace_id and attempt.status='succeeded' and attempt.executor_principal_type='service' and attempt.executor_principal_id=$9 and attempt.runtime_profile='host_trusted' and attempt.attempt_number=run.attempt_count and attempt.deployment_revision_id=run.deployment_revision_id and attempt.agent_version_id=run.agent_version_id
		join verrail_run_events event on event.id=$6 and event.workspace_id=run.workspace_id and event.run_id=run.id and event.run_attempt_id=attempt.id and event.event_type='succeeded' and event.fencing_token=attempt.fencing_token and event.cursor=attempt.last_event_cursor and event.content_hash=$10
		where revision.workspace_id=$1 and revision.id=$2 and revision.revision_number=1 and revision.created_by_principal_type='service' and revision.created_by_principal_id=$9
		and not exists(select 1 from verrail_run_attempts newer where newer.workspace_id=run.workspace_id and newer.run_id=run.id and newer.attempt_number>attempt.attempt_number)
		for share of run,attempt`, p.WorkspaceID, input.ArtifactRevisionID, p.TargetID, input.Source.RunID, input.Source.RunAttemptID, input.Source.RunEventID, p.TargetRevisionID, p.GraphRevisionID, fixedCINativeExecutor, input.Source.RunEventContentHash).Scan(&title, &contentHash, &contentRef, &sourceNodeID, &deploymentID, &agentVersionID, &fence, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fixedCIProofMismatch()
	}
	if err != nil {
		return "", err
	}
	var event struct {
		Artifacts     []fixedCINativeArtifact `json:"artifacts"`
		OutputReceipt struct {
			SchemaVersion    int    `json:"schemaVersion"`
			Kind             string `json:"kind"`
			Phase            string `json:"phase"`
			SHA256           string `json:"sha256"`
			SourceStatus     string `json:"sourceStatus"`
			CollectionStatus string `json:"collectionStatus"`
			FinalizedAt      string `json:"finalizedAt"`
			Identity         struct {
				WorkspaceID          string `json:"workspaceId"`
				RunID                string `json:"runId"`
				AttemptID            string `json:"attemptId"`
				DeploymentRevisionID string `json:"deploymentRevisionId"`
				AgentVersionID       string `json:"agentVersionId"`
				HeartbeatRunID       string `json:"heartbeatRunId"`
				AgentID              string `json:"agentId"`
			} `json:"identity"`
			ExecutionFacts *struct {
				HeartbeatStatus string  `json:"heartbeatStatus"`
				HeartbeatRunID  string  `json:"heartbeatRunId"`
				AgentID         string  `json:"agentId"`
				ExitCode        *int    `json:"exitCode"`
				ErrorCode       *string `json:"errorCode"`
			} `json:"executionFacts"`
			SourceAfter struct {
				SchemaVersion int    `json:"schemaVersion"`
				Status        string `json:"status"`
				Manifest      struct {
					ContentSHA256 string `json:"contentSha256"`
				} `json:"manifest"`
			} `json:"sourceAfter"`
			Artifacts []fixedCINativeArtifact `json:"artifacts"`
		} `json:"outputReceipt"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return "", fixedCIProofMismatch()
	}
	r := event.OutputReceipt
	identity := r.Identity
	_, timeErr := time.Parse(time.RFC3339Nano, r.FinalizedAt)
	if r.SchemaVersion != 2 || r.Kind != "verrail.native-output-receipt" || r.Phase != "after_adapter_return" || r.SHA256 != input.Source.OutputReceiptSHA256 || r.SourceStatus != "stable" || r.CollectionStatus != "collected" || timeErr != nil || identity.WorkspaceID != p.WorkspaceID || identity.RunID != input.Source.RunID || identity.AttemptID != input.Source.RunAttemptID || identity.DeploymentRevisionID != deploymentID || identity.AgentVersionID != agentVersionID || identity.HeartbeatRunID == "" || identity.AgentID == "" || r.ExecutionFacts == nil || r.ExecutionFacts.HeartbeatStatus != "succeeded" || r.ExecutionFacts.HeartbeatRunID != identity.HeartbeatRunID || r.ExecutionFacts.AgentID != identity.AgentID || r.ExecutionFacts.ExitCode != nil && *r.ExecutionFacts.ExitCode != 0 || r.ExecutionFacts.ErrorCode != nil || r.SourceAfter.SchemaVersion != 2 || r.SourceAfter.Status != "captured" || r.SourceAfter.Manifest.ContentSHA256 != input.Mapping.SourceContentSHA256 || len(r.Artifacts) != len(event.Artifacts) || input.Source.ArtifactOrdinal >= len(r.Artifacts) {
		return "", fixedCIProofMismatch()
	}
	ordinal := input.Source.ArtifactOrdinal
	if len(r.Artifacts) > 10 {
		return "", fixedCIProofMismatch()
	}
	var eventFields, receiptFields map[string]json.RawMessage
	var executionFacts map[string]json.RawMessage
	if json.Unmarshal(raw, &eventFields) != nil || json.Unmarshal(eventFields["outputReceipt"], &receiptFields) != nil || json.Unmarshal(receiptFields["executionFacts"], &executionFacts) != nil || len(executionFacts) == 0 || len(receiptFields["beforeSource"]) == 0 || proofHash(eventFields["sourceObservation"]) != proofHash(receiptFields["beforeSource"]) {
		return "", fixedCIProofMismatch()
	}
	for key, value := range executionFacts {
		if _, exists := eventFields[key]; !exists || proofHash(value) != proofHash(eventFields[key]) {
			return "", fixedCIProofMismatch()
		}
	}
	selected, registered := r.Artifacts[ordinal], event.Artifacts[ordinal]
	matches := 0
	for index, artifact := range r.Artifacts {
		registered := event.Artifacts[index]
		if artifact.Ordinal != index || registered.Kind != artifact.Kind || registered.Title != artifact.Title || registered.ContentHash != artifact.ContentHash || registered.ContentRef != artifact.ContentRef {
			return "", fixedCIProofMismatch()
		}
		if artifact.Title == title && artifact.Kind == "code_change" && artifact.ContentHash == contentHash && artifact.ContentRef == contentRef {
			matches++
		}
	}
	if selected.Path != "source-"+strconv.Itoa(ordinal)+".bundle" || selected.SourceSnapshot.Format != "git_bundle" || selected.SourceSnapshot.ScopeVersion != 2 {
		return "", fixedCIProofMismatch()
	}
	if matches != 1 || selected.Ordinal != ordinal || selected.Type != "source_snapshot" || selected.Kind != "code_change" || selected.Title != title || selected.ContentHash != contentHash || selected.ContentRef != contentRef || contentRef != "storage:"+p.WorkspaceID+"/verrail/run-artifacts/sha256/"+contentHash || selected.SourceSnapshot.SchemaVersion != 1 || selected.SourceSnapshot.SnapshotTree != input.Mapping.SourceSnapshotTreeSHA || selected.SourceSnapshot.SourceContentSHA256 != input.Mapping.SourceContentSHA256 || registered.Kind != selected.Kind || registered.Title != selected.Title || registered.ContentHash != selected.ContentHash || registered.ContentRef != selected.ContentRef {
		return "", fixedCIProofMismatch()
	}
	var auditCount int
	err = tx.QueryRow(ctx, `select count(*) from verrail_audit_events where workspace_id=$1 and principal_type='service' and principal_id=$2 and event_type=$3 and aggregate_type='artifact_revision' and aggregate_id=$4
		and payload->>'schemaVersion'='1' and payload->>'resourceType'='artifact_revision' and payload->>'resourceId'=aggregate_id::text
		and payload->>'runId'=$5 and payload->>'runAttemptId'=$6 and payload->>'workNodeId'=$7 and payload->>'fencingToken'=$8 and payload->>'contentHash'=$9`, p.WorkspaceID, fixedCINativeExecutor, assuranceArtifactRevisionAddedEvent, input.ArtifactRevisionID, input.Source.RunID, input.Source.RunAttemptID, sourceNodeID, strconv.FormatInt(fence, 10), contentHash).Scan(&auditCount)
	if err != nil {
		return "", err
	}
	if auditCount != 1 {
		return "", fixedCIProofMismatch()
	}
	return contentHash, nil
}
