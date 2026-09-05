package target

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// StoreOption configures optional Store collaborators; tests swap the GitHub
// client for a fake via WithGitHubClient while the default store keeps the
// real thin REST wrapper.
type StoreOption func(*Store)

func WithGitHubClient(client GitHubClient) StoreOption {
	return func(store *Store) { store.github = client }
}

// connectorConclusionVerdict maps an integration run conclusion onto the
// VerificationResult verdict it asserts. The second return is false for
// neutral runs, which produce evidence only.
func connectorConclusionVerdict(conclusion string) (string, bool) {
	switch conclusion {
	case "success":
		return "passed", true
	case "failure":
		return "failed", true
	default:
		return "", false
	}
}

func (store *Store) RecordIntegrationRun(ctx context.Context, command AgentLifecycleCommand[RecordIntegrationRunInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginCandidateCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := assertAssuranceTarget(ctx, tx, command.WorkspaceID, command.Input.TargetID); err != nil {
		return AgentLifecycleResult{}, err
	}
	var activeTargetRevisionID string
	if err := tx.QueryRow(ctx, `select active_target_revision_id from verrail_targets where id=$1 and workspace_id=$2`, command.Input.TargetID, command.WorkspaceID).Scan(&activeTargetRevisionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if activeTargetRevisionID != command.Input.TargetRevisionID {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "INTEGRATION_TARGET_REVISION_MISMATCH", Message: "IntegrationRun must bind the active TargetRevision"}
	}
	var claimTargetID, claimTargetRevisionID, criterionKey string
	if err := tx.QueryRow(ctx, `select target_id,target_revision_id,criterion_key from verrail_claims where id=$1 and workspace_id=$2`, command.Input.ClaimID, command.WorkspaceID).Scan(&claimTargetID, &claimTargetRevisionID, &criterionKey); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, connectorNotFound("Claim")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if claimTargetID != command.Input.TargetID || claimTargetRevisionID != command.Input.TargetRevisionID || criterionKey != command.Input.CriterionKey {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "INTEGRATION_CLAIM_BINDING_MISMATCH", Message: "IntegrationRun Claim must match the TargetRevision and criterion"}
	}
	var nodeTargetID, nodeGraphRevisionID, nodeKind, nodeStatus, graphTargetRevisionID, activeGraphRevisionID string
	if err := tx.QueryRow(ctx, `
		select node.target_id,node.graph_revision_id,node.kind,node.status,revision.target_revision_id,graph.active_graph_revision_id
		from verrail_work_nodes node
		join verrail_graph_revisions revision on revision.id=node.graph_revision_id and revision.workspace_id=node.workspace_id
		join verrail_work_graphs graph on graph.id=revision.work_graph_id and graph.workspace_id=revision.workspace_id
		where node.id=$1 and node.workspace_id=$2
		for update of node
	`, command.Input.WorkNodeID, command.WorkspaceID).Scan(&nodeTargetID, &nodeGraphRevisionID, &nodeKind, &nodeStatus, &graphTargetRevisionID, &activeGraphRevisionID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, connectorNotFound("WorkNode")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if nodeKind != "integration_task" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "INTEGRATION_NODE_KIND_MISMATCH", Message: "IntegrationRun requires an IntegrationTask WorkNode"}
	}
	if nodeTargetID != command.Input.TargetID || nodeGraphRevisionID != command.Input.GraphRevisionID || graphTargetRevisionID != command.Input.TargetRevisionID || activeGraphRevisionID != command.Input.GraphRevisionID {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "INTEGRATION_GRAPH_BINDING_MISMATCH", Message: "IntegrationRun must bind the active GraphRevision and TargetRevision"}
	}
	if nodeStatus != "ready" && nodeStatus != "running" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "INTEGRATION_NODE_NOT_ACTIVE", Message: "IntegrationTask WorkNode is not ready or running"}
	}
	var connectionExists bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from tool_connections where id=$1 and company_id=$2 and enabled and status='active')`, command.Input.ConnectionID, command.WorkspaceID).Scan(&connectionExists); err != nil {
		return AgentLifecycleResult{}, err
	}
	if !connectionExists {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "INTEGRATION_CONNECTION_NOT_ACTIVE", Message: "IntegrationRun Connection is not active in this Workspace"}
	}
	providerReceipt, err := json.Marshal(command.Input.ProviderReceipt)
	if err != nil {
		return AgentLifecycleResult{}, validation("Invalid providerReceipt")
	}
	// CI evidence is written first so the run can bind it: kind ci_result,
	// service producer, high trust (spec.md product contract item 1).
	evidenceID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_evidence(id,workspace_id,target_id,claim_id,kind,producer_principal_type,producer_principal_id,object_hash,reference,trust_level,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,'ci_result','service',$5,$6,$7,'high',$8,$9)`, evidenceID, command.WorkspaceID, command.Input.TargetID, command.Input.ClaimID, connectorProducerPrincipalID, command.Input.ObjectHash, command.Input.Reference, command.Principal.Type, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert integration run Evidence: %w", err)
	}
	var verificationResultID *string
	if verdict, ok := connectorConclusionVerdict(command.Input.Conclusion); ok {
		// Identical verification payloads deduplicate by result hash, mirroring
		// the assurance path (unique (claim_id, result_hash)).
		resultHash, err := verificationResultHash(command.Input.ClaimID, verdict, connectorVerifierVersion, []string{evidenceID}, nil)
		if err != nil {
			return AgentLifecycleResult{}, err
		}
		var existingResultID string
		err = tx.QueryRow(ctx, `select id from verrail_verification_results where claim_id=$1 and result_hash=$2`, command.Input.ClaimID, resultHash).Scan(&existingResultID)
		switch {
		case err == nil:
			verificationResultID = &existingResultID
		case errors.Is(err, pgx.ErrNoRows):
			resultID, _ := NewUUID()
			if _, err := tx.Exec(ctx, `insert into verrail_verification_results(id,workspace_id,target_id,claim_id,verdict,verifier_version,evidence_ids,waiver_reference,result_hash,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7::uuid[],null,$8,$9,$10)`, resultID, command.WorkspaceID, command.Input.TargetID, command.Input.ClaimID, verdict, connectorVerifierVersion, []string{evidenceID}, resultHash, command.Principal.Type, command.Principal.ID); err != nil {
				return AgentLifecycleResult{}, fmt.Errorf("insert integration run VerificationResult: %w", err)
			}
			if nextStatus, ok := claimStatusForVerdict(verdict); ok {
				if _, err := tx.Exec(ctx, `update verrail_claims set status=$1,updated_at=now() where id=$2`, nextStatus, command.Input.ClaimID); err != nil {
					return AgentLifecycleResult{}, fmt.Errorf("update Claim status: %w", err)
				}
			}
			verificationResultID = &resultID
		default:
			return AgentLifecycleResult{}, err
		}
	}
	runID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `
		insert into verrail_integration_runs(
			id,workspace_id,target_id,target_revision_id,graph_revision_id,claim_id,work_node_id,
			connector_version,connection_id,provider,external_ref,commit_ref,criterion_key,environment_ref,
			conclusion,evidence_id,verification_result_id,provider_receipt,idempotency_key,
			created_by_principal_type,created_by_principal_id
		) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21)
	`, runID, command.WorkspaceID, command.Input.TargetID, command.Input.TargetRevisionID, command.Input.GraphRevisionID, command.Input.ClaimID, command.Input.WorkNodeID, command.Input.ConnectorVersion, command.Input.ConnectionID, command.Input.Provider, command.Input.ExternalRef, command.Input.CommitRef, command.Input.CriterionKey, command.Input.EnvironmentRef, command.Input.Conclusion, evidenceID, verificationResultID, providerReceipt, command.IdempotencyKey, command.Principal.Type, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert IntegrationRun: %w", err)
	}
	attemptStatus := "neutral"
	if command.Input.Conclusion == "success" {
		attemptStatus = "succeeded"
	} else if command.Input.Conclusion == "failure" {
		attemptStatus = "failed"
	}
	attemptID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_integration_attempts(id,workspace_id,integration_run_id,attempt_number,connector_version,connection_id,provider_ref,idempotency_key,provider_receipt,status) values($1,$2,$3,1,$4,$5,$6,$7,$8::jsonb,$9)`, attemptID, command.WorkspaceID, runID, command.Input.ConnectorVersion, command.Input.ConnectionID, command.Input.ExternalRef, command.IdempotencyKey, providerReceipt, attemptStatus); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert IntegrationAttempt: %w", err)
	}
	nextNodeStatus := "completed"
	if command.Input.Conclusion == "failure" {
		nextNodeStatus = "blocked"
	}
	if _, err := tx.Exec(ctx, `update verrail_work_nodes set status=$1,updated_at=now() where id=$2`, nextNodeStatus, command.Input.WorkNodeID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("update IntegrationTask status: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceIntegrationRun, ResourceID: runID}
	if err := finishAgentCommand(ctx, tx, meta, result, connectorIntegrationRunRecordedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) RecordHumanWorkResult(ctx context.Context, command AgentLifecycleCommand[RecordHumanWorkResultInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := assertAssuranceTarget(ctx, tx, command.WorkspaceID, command.Input.TargetID); err != nil {
		return AgentLifecycleResult{}, err
	}
	var activeTargetRevisionID string
	if err := tx.QueryRow(ctx, `select active_target_revision_id from verrail_targets where id=$1 and workspace_id=$2`, command.Input.TargetID, command.WorkspaceID).Scan(&activeTargetRevisionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	if activeTargetRevisionID != command.Input.TargetRevisionID {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "HUMAN_WORK_TARGET_REVISION_MISMATCH", Message: "HumanWorkResult must bind the active TargetRevision"}
	}
	var nodeTargetID, nodeGraphRevisionID, nodeKind, nodeStatus, graphTargetRevisionID, activeGraphRevisionID string
	if err := tx.QueryRow(ctx, `
		select node.target_id,node.graph_revision_id,node.kind,node.status,revision.target_revision_id,graph.active_graph_revision_id
		from verrail_work_nodes node
		join verrail_graph_revisions revision on revision.id=node.graph_revision_id and revision.workspace_id=node.workspace_id
		join verrail_work_graphs graph on graph.id=revision.work_graph_id and graph.workspace_id=revision.workspace_id
		where node.id=$1 and node.workspace_id=$2
		for update of node
	`, command.Input.WorkNodeID, command.WorkspaceID).Scan(&nodeTargetID, &nodeGraphRevisionID, &nodeKind, &nodeStatus, &graphTargetRevisionID, &activeGraphRevisionID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, connectorNotFound("WorkNode")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if nodeKind != "human_task" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "HUMAN_WORK_NODE_KIND_MISMATCH", Message: "HumanWorkResult requires a HumanTask WorkNode"}
	}
	if nodeTargetID != command.Input.TargetID || nodeGraphRevisionID != command.Input.GraphRevisionID || graphTargetRevisionID != command.Input.TargetRevisionID || activeGraphRevisionID != command.Input.GraphRevisionID {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "HUMAN_WORK_GRAPH_BINDING_MISMATCH", Message: "HumanWorkResult must bind the active GraphRevision and TargetRevision"}
	}
	if nodeStatus != "ready" && nodeStatus != "running" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "HUMAN_WORK_NODE_NOT_ACTIVE", Message: "HumanTask WorkNode is not ready or running"}
	}
	if command.Input.ArtifactRevisionID != nil {
		var artifactTargetID string
		if err := tx.QueryRow(ctx, `
			select artifact.target_id
			from verrail_artifact_revisions revision
			join verrail_artifacts artifact on artifact.id=revision.artifact_id and artifact.workspace_id=revision.workspace_id
			where revision.id=$1 and revision.workspace_id=$2
		`, *command.Input.ArtifactRevisionID, command.WorkspaceID).Scan(&artifactTargetID); errors.Is(err, pgx.ErrNoRows) {
			return AgentLifecycleResult{}, connectorNotFound("ArtifactRevision")
		} else if err != nil {
			return AgentLifecycleResult{}, err
		}
		if artifactTargetID != command.Input.TargetID {
			return AgentLifecycleResult{}, &Error{Status: 409, Code: "HUMAN_WORK_ARTIFACT_MISMATCH", Message: "HumanWorkResult ArtifactRevision must belong to the Target"}
		}
	}
	resultHash, err := humanWorkResultHash(command.Input)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	resultJSON, err := json.Marshal(command.Input.Result)
	if err != nil {
		return AgentLifecycleResult{}, validation("Invalid HumanWorkResult result")
	}
	resultID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `
		insert into verrail_human_work_results(
			id,workspace_id,target_id,target_revision_id,graph_revision_id,work_node_id,
			submitted_by_principal_type,submitted_by_principal_id,input_hash,result,
			artifact_revision_id,attachment_hashes,result_hash,idempotency_key
		) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::text[],$13,$14)
	`, resultID, command.WorkspaceID, command.Input.TargetID, command.Input.TargetRevisionID, command.Input.GraphRevisionID, command.Input.WorkNodeID, command.Principal.Type, command.Principal.ID, command.Input.InputHash, resultJSON, command.Input.ArtifactRevisionID, command.Input.AttachmentHashes, resultHash, command.IdempotencyKey); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert HumanWorkResult: %w", err)
	}
	if _, err := tx.Exec(ctx, `update verrail_work_nodes set status='completed',updated_at=now() where id=$1`, command.Input.WorkNodeID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("complete HumanTask: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceHumanWorkResult, ResourceID: resultID}
	if err := finishAgentCommand(ctx, tx, meta, result, connectorHumanWorkResultRecordedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) RequestPullRequestAction(ctx context.Context, command AgentLifecycleCommand[RequestPullRequestActionInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginCandidateCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := assertAssuranceTarget(ctx, tx, command.WorkspaceID, command.Input.TargetID); err != nil {
		return AgentLifecycleResult{}, err
	}
	var submissionTargetID, submissionRevisionID string
	var expectedCommitRef *string
	if err := tx.QueryRow(ctx, `select target_id,target_revision_id,commit_ref from verrail_submissions where id=$1 and workspace_id=$2`, command.Input.SubmissionID, command.WorkspaceID).Scan(&submissionTargetID, &submissionRevisionID, &expectedCommitRef); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, connectorNotFound("Submission")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if submissionTargetID != command.Input.TargetID {
		return AgentLifecycleResult{}, validation("Submission does not belong to the given Target")
	}
	// The submission must be the latest for the target (order created_at desc,
	// id desc); anything else has been superseded (invariant 10).
	var latestSubmissionID string
	if err := tx.QueryRow(ctx, `select id from verrail_submissions where target_id=$1 order by created_at desc, id desc limit 1`, command.Input.TargetID).Scan(&latestSubmissionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	submissionIsLatest := latestSubmissionID == command.Input.SubmissionID
	if !submissionIsLatest {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "CONNECTOR_SUBMISSION_SUPERSEDED", Message: "The Submission is no longer the latest submission for this Target"}
	}
	// Derived acceptance validity mirrors the shared deriveAcceptanceValidity
	// rule: the submission is latest AND its revision is still the target's
	// active revision.
	var activeRevisionID string
	if err := tx.QueryRow(ctx, `select active_target_revision_id from verrail_targets where id=$1 and workspace_id=$2`, command.Input.TargetID, command.WorkspaceID).Scan(&activeRevisionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	validity, invalidReason := deriveAcceptanceValidity(submissionIsLatest, activeRevisionID == submissionRevisionID)
	if validity != "valid" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "ADJUDICATION_NOT_APPLICABLE", Message: "The derived acceptance for this Submission is " + validity + " (" + invalidReason + ")"}
	}
	paramsHash, err := pullRequestParamsHash(command.Input.Params)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	paramsJSON, err := json.Marshal(command.Input.Params)
	if err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("marshal pull request params: %w", err)
	}
	actionRequestID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_action_requests(id,workspace_id,target_id,submission_id,action_type,params,params_hash,expected_commit_ref,status,requested_by_principal_type,requested_by_principal_id) values($1,$2,$3,$4,'create_pull_request',$5,$6,$7,'pending_approval',$8,$9)`, actionRequestID, command.WorkspaceID, command.Input.TargetID, command.Input.SubmissionID, paramsJSON, paramsHash, expectedCommitRef, command.Principal.Type, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert ActionRequest: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceActionRequest, ResourceID: actionRequestID}
	if err := finishAgentCommand(ctx, tx, meta, result, connectorActionRequestCreatedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) ApproveAction(ctx context.Context, command AgentLifecycleCommand[ApproveActionInput]) (AgentLifecycleResult, error) {
	if command.ResourceID != "" && command.ResourceID != command.Input.ActionRequestID {
		return AgentLifecycleResult{}, validation("The action request in the path must match the request in the payload")
	}
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var requestStatus, requestTargetID, requestParamsHash, requesterType, requesterID string
	if err := tx.QueryRow(ctx, `select status,target_id,params_hash,requested_by_principal_type,requested_by_principal_id from verrail_action_requests where id=$1 and workspace_id=$2 for update`, command.Input.ActionRequestID, command.WorkspaceID).Scan(&requestStatus, &requestTargetID, &requestParamsHash, &requesterType, &requesterID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, connectorNotFound("ActionRequest")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	// Authority rule (mirrors RecordDeliveryReview after the P1 fix): the
	// approver is the authenticated human member recording the approval — the
	// wire field must equal the command principal so independence cannot be
	// self-attested on behalf of someone else.
	if command.Input.ApproverPrincipalID != command.Principal.ID {
		return AgentLifecycleResult{}, forbidden("CONNECTOR_APPROVER_FORBIDDEN", "The approver must be the authenticated member recording the approval")
	}
	// The approver must differ from the action requester when that requester
	// is a user (spec.md product contract item 2).
	if requesterType == "user" && requesterID == command.Input.ApproverPrincipalID {
		return AgentLifecycleResult{}, &Error{Status: 403, Code: "CONNECTOR_APPROVER_NOT_INDEPENDENT", Message: "The approver must differ from the action requester"}
	}
	// Parameter-bound approval: the digest the approver reviewed must match
	// the request's stored params hash.
	if command.Input.ParamsHash != requestParamsHash {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "CONNECTOR_PARAMS_HASH_MISMATCH", Message: "The approved params hash does not match the ActionRequest"}
	}
	if requestStatus != "pending_approval" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "CONNECTOR_ACTION_ALREADY_APPROVED", Message: "The ActionRequest has already left pending approval"}
	}
	// Unique (action_request_id) pre-check: a replay with a different
	// idempotency key is a conflict, not a second approval.
	var existingApprovalID string
	err = tx.QueryRow(ctx, `select id from verrail_action_approvals where action_request_id=$1`, command.Input.ActionRequestID).Scan(&existingApprovalID)
	if err == nil {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "CONNECTOR_ACTION_ALREADY_APPROVED", Message: "An approval already exists for this ActionRequest"}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, err
	}
	approvalID, _ := NewUUID()
	// on conflict do nothing keeps the transaction usable if a concurrent
	// approval won the race; the row is then read back as a replay.
	var insertedID string
	err = tx.QueryRow(ctx, `insert into verrail_action_approvals(id,workspace_id,action_request_id,approved_by_principal_type,approved_by_principal_id,params_hash) values($1,$2,$3,'user',$4,$5) on conflict (action_request_id) do nothing returning id`, approvalID, command.WorkspaceID, command.Input.ActionRequestID, command.Input.ApproverPrincipalID, command.Input.ParamsHash).Scan(&insertedID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.QueryRow(ctx, `select id from verrail_action_approvals where action_request_id=$1`, command.Input.ActionRequestID).Scan(&insertedID); err != nil {
			return AgentLifecycleResult{}, err
		}
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceActionApproval, ResourceID: insertedID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, connectorActionApprovedEvent); err != nil {
			return result, err
		}
		return result, nil
	}
	if err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert ActionApproval: %w", err)
	}
	if _, err := tx.Exec(ctx, `update verrail_action_requests set status='approved',updated_at=now() where id=$1`, command.Input.ActionRequestID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("update ActionRequest status: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceActionApproval, ResourceID: insertedID}
	if err := finishAgentCommand(ctx, tx, meta, result, connectorActionApprovedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) ExecuteAction(ctx context.Context, command AgentLifecycleCommand[ExecuteActionInput]) (AgentLifecycleResult, error) {
	return store.executeActionWithClient(ctx, command, "", store.github)
}

func (store *Store) ExecuteActionWithGitHubCredential(ctx context.Context, command AgentLifecycleCommand[ExecuteActionInput], connectionID, authorization string) (AgentLifecycleResult, error) {
	if err := ValidateGitHubCredentialTransport(connectionID, authorization); err != nil {
		return AgentLifecycleResult{}, err
	}
	return store.executeActionWithClient(ctx, command, connectionID, NewGitHubRESTClient("https://api.github.com", authorization))
}

type actionExecutionPreparation struct {
	TargetID          string
	ParamsHash        string
	Params            PullRequestParams
	ExpectedCommitRef *string
	Repo              string
	ProviderMarker    string
	CanCreate         bool
}

func (store *Store) prepareActionExecution(ctx context.Context, command AgentLifecycleCommand[ExecuteActionInput], expectedConnectionID string) (*actionExecutionPreparation, *AgentLifecycleResult, error) {
	if command.ResourceID != "" && command.ResourceID != command.Input.ActionRequestID {
		return nil, nil, validation("The action request in the path must match the request in the payload")
	}
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return nil, nil, err
	}
	if replay != nil {
		return nil, replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var requestStatus, requestTargetID, requestParamsHash, requestSubmissionID, requesterType, requesterID string
	var expectedCommitRef *string
	var storedMarker *string
	var canReclaimExecution bool
	var params PullRequestParams
	if err := tx.QueryRow(ctx, `
		select status,target_id,params_hash,params,submission_id,expected_commit_ref,provider_marker,
			(status <> 'executing' or execution_started_at is null or execution_started_at <= clock_timestamp() - interval '2 minutes'),
			requested_by_principal_type,requested_by_principal_id
		from verrail_action_requests
		where id=$1 and workspace_id=$2
		for update
	`, command.Input.ActionRequestID, command.WorkspaceID).Scan(&requestStatus, &requestTargetID, &requestParamsHash, &params, &requestSubmissionID, &expectedCommitRef, &storedMarker, &canReclaimExecution, &requesterType, &requesterID); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, connectorNotFound("ActionRequest")
	} else if err != nil {
		return nil, nil, err
	}
	if requestStatus == "executed" {
		var receiptID string
		if err := tx.QueryRow(ctx, `select id from verrail_effect_receipts where action_request_id=$1 and workspace_id=$2`, command.Input.ActionRequestID, command.WorkspaceID).Scan(&receiptID); err != nil {
			return nil, nil, err
		}
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceEffectReceipt, ResourceID: receiptID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, connectorActionExecutedEvent); err != nil {
			return nil, nil, err
		}
		return nil, &result, nil
	}
	if requestStatus != "approved" && requestStatus != "executing" && requestStatus != "unknown_effect" {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_ACTION_NOT_APPROVED", Message: "Only an approved or reconciling ActionRequest can be executed"}
	}
	actualParamsHash, err := pullRequestParamsHash(params)
	if err != nil {
		return nil, nil, err
	}
	if actualParamsHash != requestParamsHash {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_PARAMS_HASH_MISMATCH", Message: "The ActionRequest parameters changed after approval"}
	}
	var approvalParamsHash, approverType, approverID string
	if err := tx.QueryRow(ctx, `select params_hash,approved_by_principal_type,approved_by_principal_id from verrail_action_approvals where action_request_id=$1 and workspace_id=$2`, command.Input.ActionRequestID, command.WorkspaceID).Scan(&approvalParamsHash, &approverType, &approverID); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_ACTION_NOT_APPROVED", Message: "The ActionRequest approval is missing"}
	} else if err != nil {
		return nil, nil, err
	}
	if approvalParamsHash != requestParamsHash || approverType != "user" || (requesterType == "user" && requesterID == approverID) {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_APPROVAL_INVALID", Message: "The ActionRequest approval is no longer valid"}
	}
	// Execute-time re-check (target criterion 2): the submission must still be
	// the latest for the target and its revision must still be the target's
	// active revision — invariant 10 forbids a stale acceptance from
	// producing a governed external effect.
	var submissionRevisionID string
	var currentCommitRef *string
	if err := tx.QueryRow(ctx, `select target_revision_id,commit_ref from verrail_submissions where id=$1 and workspace_id=$2`, requestSubmissionID, command.WorkspaceID).Scan(&submissionRevisionID, &currentCommitRef); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, adjudicationNotFound("Submission")
	} else if err != nil {
		return nil, nil, err
	}
	var latestSubmissionID string
	if err := tx.QueryRow(ctx, `select id from verrail_submissions where target_id=$1 order by created_at desc, id desc limit 1`, requestTargetID).Scan(&latestSubmissionID); err != nil {
		return nil, nil, err
	}
	var activeRevisionID string
	if err := tx.QueryRow(ctx, `select active_target_revision_id from verrail_targets where id=$1 and workspace_id=$2`, requestTargetID, command.WorkspaceID).Scan(&activeRevisionID); err != nil {
		return nil, nil, err
	}
	validity, invalidReason := deriveAcceptanceValidity(latestSubmissionID == requestSubmissionID, activeRevisionID == submissionRevisionID)
	if validity != "valid" {
		if latestSubmissionID != requestSubmissionID {
			return nil, nil, &Error{Status: 409, Code: "CONNECTOR_SUBMISSION_SUPERSEDED", Message: "The Submission is no longer the latest submission for this Target"}
		}
		return nil, nil, &Error{Status: 409, Code: "ADJUDICATION_NOT_APPLICABLE", Message: "The derived acceptance for this Submission is " + validity + " (" + invalidReason + ")"}
	}
	if (expectedCommitRef == nil) != (currentCommitRef == nil) || (expectedCommitRef != nil && *expectedCommitRef != *currentCommitRef) {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_EXPECTED_COMMIT_CHANGED", Message: "The Submission commit binding changed after the ActionRequest was approved"}
	}
	var acceptanceExists bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from verrail_acceptances where submission_id=$1 and workspace_id=$2 and target_id=$3 and target_revision_id=$4)`, requestSubmissionID, command.WorkspaceID, requestTargetID, submissionRevisionID).Scan(&acceptanceExists); err != nil {
		return nil, nil, err
	}
	if !acceptanceExists {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_SUBMISSION_NOT_ACCEPTED", Message: "The Submission Acceptance is missing or invalid"}
	}
	// A GitHub connection must be bound for the workspace with a repo binding
	// and an enabled connection (409 CONNECTOR_NOT_BOUND when absent).
	var connectionID, repoOwner, repoName string
	if err := tx.QueryRow(ctx, `
		select binding.connection_id, binding.repo_owner, binding.repo_name
		from verrail_github_repo_bindings binding
		join tool_connections connection on connection.company_id = binding.workspace_id and connection.id = binding.connection_id
		where binding.workspace_id=$1 and connection.enabled and connection.status='active'
	`, command.WorkspaceID).Scan(&connectionID, &repoOwner, &repoName); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_NOT_BOUND", Message: "No active GitHub connection is bound for this Workspace"}
	} else if err != nil {
		return nil, nil, err
	}
	if expectedConnectionID != "" && connectionID != expectedConnectionID {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_CONNECTION_CHANGED", Message: "The GitHub connection binding changed before execution"}
	}
	marker := providerMarker(command.Input.ActionRequestID, requestParamsHash)
	if storedMarker != nil && *storedMarker != marker {
		return nil, nil, &Error{Status: 409, Code: "CONNECTOR_PROVIDER_MARKER_MISMATCH", Message: "The stored provider marker does not match the approved parameters"}
	}
	canCreate := canReclaimExecution
	if canCreate {
		if _, err := tx.Exec(ctx, `
			update verrail_action_requests
			set status='executing', provider_marker=$1, execution_attempt_count=execution_attempt_count+1,
				execution_started_at=now(), last_reconciled_at=now(), updated_at=now()
			where id=$2 and workspace_id=$3
		`, marker, command.Input.ActionRequestID, command.WorkspaceID); err != nil {
			return nil, nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return &actionExecutionPreparation{TargetID: requestTargetID, ParamsHash: requestParamsHash, Params: params, ExpectedCommitRef: expectedCommitRef, Repo: repoOwner + "/" + repoName, ProviderMarker: marker, CanCreate: canCreate}, nil, nil
}

func (store *Store) markActionUnknown(ctx context.Context, workspaceID, actionRequestID, marker string) {
	_, _ = store.pool.Exec(ctx, `update verrail_action_requests set status='unknown_effect',last_reconciled_at=now(),updated_at=now() where id=$1 and workspace_id=$2 and provider_marker=$3 and status='executing'`, actionRequestID, workspaceID, marker)
}

func (store *Store) markActionDefinitiveFailure(ctx context.Context, workspaceID, actionRequestID, marker string) {
	_, _ = store.pool.Exec(ctx, `update verrail_action_requests set status='approved',provider_marker=null,execution_started_at=null,last_reconciled_at=now(),updated_at=now() where id=$1 and workspace_id=$2 and provider_marker=$3 and status='executing'`, actionRequestID, workspaceID, marker)
}

func (store *Store) finalizeActionExecution(ctx context.Context, command AgentLifecycleCommand[ExecuteActionInput], prepared actionExecutionPreparation, externalObjectID, externalURL string) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	var marker *string
	if err := tx.QueryRow(ctx, `select status,provider_marker from verrail_action_requests where id=$1 and workspace_id=$2 for update`, command.Input.ActionRequestID, command.WorkspaceID).Scan(&status, &marker); err != nil {
		return AgentLifecycleResult{}, err
	}
	if status == "executed" {
		var receiptID string
		if err := tx.QueryRow(ctx, `select id from verrail_effect_receipts where action_request_id=$1 and workspace_id=$2`, command.Input.ActionRequestID, command.WorkspaceID).Scan(&receiptID); err != nil {
			return AgentLifecycleResult{}, err
		}
		result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceEffectReceipt, ResourceID: receiptID, Replayed: true}
		if err := finishAgentCommand(ctx, tx, meta, result, connectorActionExecutedEvent); err != nil {
			return result, err
		}
		return result, nil
	}
	if marker == nil || *marker != prepared.ProviderMarker || (status != "executing" && status != "unknown_effect") {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "CONNECTOR_EFFECT_STATE_CONFLICT", Message: "The ActionRequest effect state changed during reconciliation"}
	}
	effectHash, err := effectHash(command.Input.ActionRequestID, prepared.ParamsHash, externalObjectID)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	payload, err := json.Marshal(map[string]any{
		"actionRequestId":   command.Input.ActionRequestID,
		"paramsHash":        prepared.ParamsHash,
		"params":            prepared.Params,
		"providerMarker":    prepared.ProviderMarker,
		"expectedCommitRef": prepared.ExpectedCommitRef,
		"externalObjectId":  externalObjectID,
		"externalUrl":       externalURL,
	})
	if err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("marshal effect receipt payload: %w", err)
	}
	receiptID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_effect_receipts(id,workspace_id,target_id,action_request_id,action_type,provider,provider_marker,external_object_id,external_url,effect_hash,payload,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,'create_pull_request','github',$5,$6,$7,$8,$9::jsonb,'user',$10)`, receiptID, command.WorkspaceID, prepared.TargetID, command.Input.ActionRequestID, prepared.ProviderMarker, externalObjectID, externalURL, effectHash, payload, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert EffectReceipt: %w", err)
	}
	if _, err := tx.Exec(ctx, `update verrail_action_requests set status='executed',last_reconciled_at=now(),updated_at=now() where id=$1 and workspace_id=$2 and provider_marker=$3`, command.Input.ActionRequestID, command.WorkspaceID, prepared.ProviderMarker); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("update ActionRequest status: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceEffectReceipt, ResourceID: receiptID}
	if err := finishAgentCommand(ctx, tx, meta, result, connectorActionExecutedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) executeActionWithClient(ctx context.Context, command AgentLifecycleCommand[ExecuteActionInput], expectedConnectionID string, github GitHubClient) (AgentLifecycleResult, error) {
	prepared, replay, err := store.prepareActionExecution(ctx, command, expectedConnectionID)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}

	lookup, lookupErr := github.LookupPullRequest(ctx, prepared.Repo, prepared.Params, prepared.ProviderMarker)
	if lookupErr == nil && lookup.Status == PullRequestFound {
		result, err := store.finalizeActionExecution(ctx, command, *prepared, lookup.ExternalObjectID, lookup.ExternalURL)
		if err != nil {
			store.markActionUnknown(ctx, command.WorkspaceID, command.Input.ActionRequestID, prepared.ProviderMarker)
			return AgentLifecycleResult{}, connectorUnknownEffect("GitHub effect was found but its receipt could not be committed")
		}
		return result, nil
	}
	if lookupErr != nil || lookup.Status == PullRequestInconclusive {
		var domainErr *Error
		var providerErr *GitHubProviderError
		if (errors.As(lookupErr, &domainErr) && !domainErr.Retryable) || (errors.As(lookupErr, &providerErr) && !providerErr.Uncertain) {
			if prepared.CanCreate {
				store.markActionDefinitiveFailure(ctx, command.WorkspaceID, command.Input.ActionRequestID, prepared.ProviderMarker)
			}
			if domainErr != nil {
				return AgentLifecycleResult{}, domainErr
			}
			return AgentLifecycleResult{}, connectorUpstreamError(lookupErr.Error())
		}
		if prepared.CanCreate {
			store.markActionUnknown(ctx, command.WorkspaceID, command.Input.ActionRequestID, prepared.ProviderMarker)
		}
		return AgentLifecycleResult{}, connectorUnknownEffect("GitHub lookup was inconclusive; no create was attempted")
	}
	if !prepared.CanCreate {
		return AgentLifecycleResult{}, connectorUnknownEffect("Another execution is still reconciling this GitHub effect")
	}

	externalObjectID, externalURL, createErr := github.CreatePullRequest(ctx, prepared.Repo, prepared.Params, prepared.ProviderMarker)
	if createErr == nil {
		result, err := store.finalizeActionExecution(ctx, command, *prepared, externalObjectID, externalURL)
		if err != nil {
			store.markActionUnknown(ctx, command.WorkspaceID, command.Input.ActionRequestID, prepared.ProviderMarker)
			return AgentLifecycleResult{}, connectorUnknownEffect("GitHub created the pull request but its receipt could not be committed")
		}
		return result, nil
	}

	postLookup, postLookupErr := github.LookupPullRequest(ctx, prepared.Repo, prepared.Params, prepared.ProviderMarker)
	if postLookupErr == nil && postLookup.Status == PullRequestFound {
		result, err := store.finalizeActionExecution(ctx, command, *prepared, postLookup.ExternalObjectID, postLookup.ExternalURL)
		if err == nil {
			return result, nil
		}
		store.markActionUnknown(ctx, command.WorkspaceID, command.Input.ActionRequestID, prepared.ProviderMarker)
		return AgentLifecycleResult{}, connectorUnknownEffect("GitHub effect was found but its receipt could not be committed")
	}
	var providerErr *GitHubProviderError
	uncertain := !errors.As(createErr, &providerErr) || providerErr.Uncertain
	if postLookupErr != nil || postLookup.Status == PullRequestInconclusive || uncertain {
		store.markActionUnknown(ctx, command.WorkspaceID, command.Input.ActionRequestID, prepared.ProviderMarker)
		return AgentLifecycleResult{}, connectorUnknownEffect("GitHub create outcome is unknown; retry will reconcile before creating")
	}
	store.markActionDefinitiveFailure(ctx, command.WorkspaceID, command.Input.ActionRequestID, prepared.ProviderMarker)
	return AgentLifecycleResult{}, connectorUpstreamError(createErr.Error())
}
