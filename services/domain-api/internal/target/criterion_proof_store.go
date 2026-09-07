package target

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type validatedCriterionProof struct {
	context            CriterionProofContext
	requirement        CriterionProofRequirement
	contractHash       string
	sourceIdentityHash string
}

func validateIntegrationProof(ctx context.Context, tx pgx.Tx, command AgentLifecycleCommand[RecordIntegrationRunInput]) (*validatedCriterionProof, error) {
	input := command.Input
	var raw []byte
	if err := tx.QueryRow(ctx, `select acceptance_criteria from verrail_target_revisions where id=$1 and workspace_id=$2`, input.TargetRevisionID, command.WorkspaceID).Scan(&raw); err != nil {
		return nil, err
	}
	var criteria []AcceptanceCriterion
	if err := json.Unmarshal(raw, &criteria); err != nil {
		return nil, err
	}
	var contract *CriterionProofContract
	for _, criterion := range criteria {
		if criterion.ID == input.CriterionKey {
			contract = criterion.ProofContract
		}
	}
	if contract == nil {
		if input.ProofContext != nil {
			return nil, validation("Legacy criteria do not have named proof requirements")
		}
		return nil, nil
	}
	if err := ValidateCriterionProofContract(contract); err != nil {
		return nil, err
	}
	if input.ProofContext == nil {
		return nil, validation("Explicit criteria require proofContext from the independent verifier")
	}
	if command.Principal.Type != "service" {
		return nil, forbidden("CRITERION_PROOF_VERIFIER_REQUIRED", "An authenticated independent verifier service must record contract-bound CI proof")
	}
	var requirement *CriterionProofRequirement
	for _, candidate := range contract.AllOf {
		if candidate.ID == input.ProofContext.RequirementID {
			copy := candidate
			requirement = &copy
		}
	}
	if requirement == nil || requirement.Kind != "independent_verification" {
		return nil, validation("proofContext must name an independent verification requirement")
	}
	late := requirement.Phase == "post_effect"
	if late != (input.ProofContext.SubmissionID != nil) {
		return nil, validation("Proof context does not match the required phase")
	}
	contractHash := proofHash(contract)
	// Coverage belongs to the independent provider receipt, never a UI assertion toggle.
	coverage, ok := input.ProviderReceipt["criterionProof"].(map[string]any)
	if !ok {
		return nil, validation("Provider receipt must include actual criterion proof coverage")
	}
	providerRunID, ok := coverage["providerRunId"].(string)
	attemptJSON, _ := json.Marshal(coverage["providerAttempt"])
	providerAttempt, attemptErr := strconv.ParseUint(string(attemptJSON), 10, 32)
	if !ok || strings.TrimSpace(providerRunID) == "" || len(providerRunID) > 512 || attemptErr != nil || providerAttempt == 0 {
		return nil, validation("Provider proof requires its stable providerRunId and positive providerAttempt")
	}
	sourceIdentityHash := proofHash(map[string]any{"workspaceId": command.WorkspaceID, "connectionId": input.ConnectionID, "provider": input.Provider, "providerRunId": providerRunID, "providerAttempt": providerAttempt, "targetRevisionId": input.TargetRevisionID, "graphRevisionId": input.GraphRevisionID, "criterionKey": input.CriterionKey, "context": input.ProofContext})
	expected := map[string]any{"contractHash": contractHash, "requirementId": requirement.ID, "assertions": requirement.Assertions, "targetRevisionId": input.TargetRevisionID, "graphRevisionId": input.GraphRevisionID, "commitRef": input.CommitRef}
	if late {
		expected["submissionId"] = *input.ProofContext.SubmissionID
		expected["effectReceiptId"] = *input.ProofContext.EffectReceiptID
	}
	for key, value := range expected {
		if proofHash(coverage[key]) != proofHash(value) {
			return nil, validation("Independent provider coverage does not match " + key)
		}
	}
	verifiedAtString, ok := coverage["verifiedAt"].(string)
	verifiedAt, err := time.Parse(time.RFC3339Nano, verifiedAtString)
	if !ok || err != nil || verifiedAt.After(time.Now().Add(time.Minute)) {
		return nil, validation("Provider proof requires a valid verification time")
	}
	if late {
		var bound bool
		var effectAt time.Time
		err := tx.QueryRow(ctx, `select submission.id=(select id from verrail_submissions where target_id=$2 and workspace_id=$1 order by created_at desc,id desc limit 1)
   and submission.target_revision_id=$4 and submission.graph_revision_id=$5 and submission.commit_ref=$6
   and exists(select 1 from verrail_artifact_revisions artifact where artifact.id=any(submission.artifact_revision_ids) and artifact.workspace_id=$1 and artifact.content_hash=$7)
   and request.target_id=$2 and request.submission_id=submission.id and request.status='executed' and request.expected_commit_ref=submission.commit_ref
   and receipt.provider_marker=request.provider_marker
   and exists(select 1 from verrail_action_approvals approval where approval.workspace_id=$1 and approval.action_request_id=request.id and approval.params_hash=request.params_hash and approval.approved_by_principal_type='user'),receipt.created_at
   from verrail_submissions submission join verrail_effect_receipts receipt on receipt.id=$8 and receipt.workspace_id=$1
   join verrail_action_requests request on request.id=receipt.action_request_id and request.workspace_id=$1
   where submission.id=$3 and submission.workspace_id=$1 and submission.target_id=$2`, command.WorkspaceID, input.TargetID, *input.ProofContext.SubmissionID, input.TargetRevisionID, input.GraphRevisionID, input.CommitRef, input.ObjectHash, *input.ProofContext.EffectReceiptID).Scan(&bound, &effectAt)
		if err == pgx.ErrNoRows || err == nil && !bound {
			return nil, &Error{Status: 409, Code: "CRITERION_PROOF_STALE", Message: "Late proof must bind the current candidate and its exact settled effect"}
		}
		if err != nil {
			return nil, err
		}
		if verifiedAt.Before(effectAt) {
			return nil, validation("Independent post-effect verification must occur after the bound effect")
		}
		facts, err := readDeliveryFacts(ctx, tx, command.WorkspaceID, input.TargetID)
		if err != nil {
			return nil, err
		}
		if !facts.acceptanceValid() {
			return nil, &Error{Status: 409, Code: "CRITERION_PROOF_STALE", Message: "Late proof requires the current accepted candidate"}
		}
	}
	return &validatedCriterionProof{context: *input.ProofContext, requirement: *requirement, contractHash: contractHash, sourceIdentityHash: sourceIdentityHash}, nil
}

func insertIntegrationProof(ctx context.Context, tx pgx.Tx, command AgentLifecycleCommand[RecordIntegrationRunInput], proof *validatedCriterionProof, runID, resultID string) error {
	if proof == nil {
		return nil
	}
	id, _ := NewUUID()
	hash := proofHash(map[string]any{"workspaceId": command.WorkspaceID, "targetId": command.Input.TargetID, "targetRevisionId": command.Input.TargetRevisionID, "graphRevisionId": command.Input.GraphRevisionID, "criterionKey": command.Input.CriterionKey, "contractHash": proof.contractHash, "context": proof.context, "integrationRunId": runID, "verificationResultId": resultID, "sourceIdentityHash": proof.sourceIdentityHash, "sourcePayloadHash": command.RequestHash})
	_, err := tx.Exec(ctx, `insert into verrail_criterion_proofs(id,workspace_id,target_id,target_revision_id,graph_revision_id,criterion_key,requirement_id,phase,contract_hash,submission_id,effect_receipt_id,verification_result_id,integration_run_id,context_hash,source_identity_hash,source_payload_hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, id, command.WorkspaceID, command.Input.TargetID, command.Input.TargetRevisionID, command.Input.GraphRevisionID, command.Input.CriterionKey, proof.requirement.ID, proof.requirement.Phase, proof.contractHash, proof.context.SubmissionID, proof.context.EffectReceiptID, resultID, runID, hash, proof.sourceIdentityHash, command.RequestHash)
	return err
}
