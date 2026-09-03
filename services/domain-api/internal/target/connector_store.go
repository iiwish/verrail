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
	var claimTargetID string
	if err := tx.QueryRow(ctx, `select target_id from verrail_claims where id=$1 and workspace_id=$2`, command.Input.ClaimID, command.WorkspaceID).Scan(&claimTargetID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, connectorNotFound("Claim")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if claimTargetID != command.Input.TargetID {
		return AgentLifecycleResult{}, validation("Integration run claim does not belong to the given Target")
	}
	if command.Input.WorkNodeID != nil {
		var workNodeTargetID string
		if err := tx.QueryRow(ctx, `select target_id from verrail_work_nodes where id=$1 and workspace_id=$2`, *command.Input.WorkNodeID, command.WorkspaceID).Scan(&workNodeTargetID); errors.Is(err, pgx.ErrNoRows) {
			return AgentLifecycleResult{}, connectorNotFound("WorkNode")
		} else if err != nil {
			return AgentLifecycleResult{}, err
		}
		if workNodeTargetID != command.Input.TargetID {
			return AgentLifecycleResult{}, validation("Integration run WorkNode does not belong to the given Target")
		}
	}
	// CI evidence is written first so the run can bind it: kind ci_result,
	// service producer, high trust (spec.md product contract item 1).
	evidenceID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_evidence(id,workspace_id,target_id,claim_id,kind,producer_principal_type,producer_principal_id,object_hash,reference,trust_level,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,'ci_result','service',$5,$6,$7,'high','user',$8)`, evidenceID, command.WorkspaceID, command.Input.TargetID, command.Input.ClaimID, connectorProducerPrincipalID, command.Input.ObjectHash, command.Input.Reference, command.Principal.ID); err != nil {
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
			if _, err := tx.Exec(ctx, `insert into verrail_verification_results(id,workspace_id,target_id,claim_id,verdict,verifier_version,evidence_ids,waiver_reference,result_hash,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7::uuid[],null,$8,'user',$9)`, resultID, command.WorkspaceID, command.Input.TargetID, command.Input.ClaimID, verdict, connectorVerifierVersion, []string{evidenceID}, resultHash, command.Principal.ID); err != nil {
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
	if _, err := tx.Exec(ctx, `insert into verrail_integration_runs(id,workspace_id,target_id,claim_id,work_node_id,provider,external_ref,conclusion,evidence_id,verification_result_id,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user',$11)`, runID, command.WorkspaceID, command.Input.TargetID, command.Input.ClaimID, command.Input.WorkNodeID, command.Input.Provider, command.Input.ExternalRef, command.Input.Conclusion, evidenceID, verificationResultID, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert IntegrationRun: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceIntegrationRun, ResourceID: runID}
	if err := finishAgentCommand(ctx, tx, meta, result, connectorIntegrationRunRecordedEvent); err != nil {
		return result, err
	}
	return result, nil
}

func (store *Store) RequestPullRequestAction(ctx context.Context, command AgentLifecycleCommand[RequestPullRequestActionInput]) (AgentLifecycleResult, error) {
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
	var submissionTargetID, submissionRevisionID string
	if err := tx.QueryRow(ctx, `select target_id,target_revision_id from verrail_submissions where id=$1 and workspace_id=$2`, command.Input.SubmissionID, command.WorkspaceID).Scan(&submissionTargetID, &submissionRevisionID); errors.Is(err, pgx.ErrNoRows) {
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
	if _, err := tx.Exec(ctx, `insert into verrail_action_requests(id,workspace_id,target_id,submission_id,action_type,params,params_hash,status,requested_by_principal_type,requested_by_principal_id) values($1,$2,$3,$4,'create_pull_request',$5,$6,'pending_approval','user',$7)`, actionRequestID, command.WorkspaceID, command.Input.TargetID, command.Input.SubmissionID, paramsJSON, paramsHash, command.Principal.ID); err != nil {
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
	var requestStatus, requestTargetID, requestParamsHash, requestSubmissionID string
	var params PullRequestParams
	if err := tx.QueryRow(ctx, `select status,target_id,params_hash,params,submission_id from verrail_action_requests where id=$1 and workspace_id=$2 for update`, command.Input.ActionRequestID, command.WorkspaceID).Scan(&requestStatus, &requestTargetID, &requestParamsHash, &params, &requestSubmissionID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, connectorNotFound("ActionRequest")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	if requestStatus != "approved" {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "CONNECTOR_ACTION_NOT_APPROVED", Message: "Only an approved ActionRequest can be executed"}
	}
	// Execute-time re-check (target criterion 2): the submission must still be
	// the latest for the target and its revision must still be the target's
	// active revision — invariant 10 forbids a stale acceptance from
	// producing a governed external effect.
	var submissionRevisionID string
	if err := tx.QueryRow(ctx, `select target_revision_id from verrail_submissions where id=$1 and workspace_id=$2`, requestSubmissionID, command.WorkspaceID).Scan(&submissionRevisionID); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, adjudicationNotFound("Submission")
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	var latestSubmissionID string
	if err := tx.QueryRow(ctx, `select id from verrail_submissions where target_id=$1 order by created_at desc, id desc limit 1`, requestTargetID).Scan(&latestSubmissionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	var activeRevisionID string
	if err := tx.QueryRow(ctx, `select active_target_revision_id from verrail_targets where id=$1 and workspace_id=$2`, requestTargetID, command.WorkspaceID).Scan(&activeRevisionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	validity, invalidReason := deriveAcceptanceValidity(latestSubmissionID == requestSubmissionID, activeRevisionID == submissionRevisionID)
	if validity != "valid" {
		if latestSubmissionID != requestSubmissionID {
			return AgentLifecycleResult{}, &Error{Status: 409, Code: "CONNECTOR_SUBMISSION_SUPERSEDED", Message: "The Submission is no longer the latest submission for this Target"}
		}
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "ADJUDICATION_NOT_APPLICABLE", Message: "The derived acceptance for this Submission is " + validity + " (" + invalidReason + ")"}
	}
	// A GitHub connection must be bound for the workspace with a repo binding
	// and an enabled connection (409 CONNECTOR_NOT_BOUND when absent).
	var repoOwner, repoName string
	if err := tx.QueryRow(ctx, `
		select binding.repo_owner, binding.repo_name
		from verrail_github_repo_bindings binding
		join tool_connections connection on connection.company_id = binding.workspace_id and connection.id = binding.connection_id
		where binding.workspace_id=$1 and connection.enabled
	`, command.WorkspaceID).Scan(&repoOwner, &repoName); errors.Is(err, pgx.ErrNoRows) {
		return AgentLifecycleResult{}, &Error{Status: 409, Code: "CONNECTOR_NOT_BOUND", Message: "No enabled GitHub connection is bound for this Workspace"}
	} else if err != nil {
		return AgentLifecycleResult{}, err
	}
	externalObjectID, externalURL, err := store.github.CreatePullRequest(ctx, repoOwner+"/"+repoName, params)
	if err != nil {
		// The upstream failure surfaces as a retryable 502 and the action
		// stays approved: the transaction rolls back before any status change.
		var domainError *Error
		if errors.As(err, &domainError) {
			return AgentLifecycleResult{}, domainError
		}
		return AgentLifecycleResult{}, connectorUpstreamError(err.Error())
	}
	effectHash, err := effectHash(command.Input.ActionRequestID, requestParamsHash, externalObjectID)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	payload, err := json.Marshal(map[string]any{
		"actionRequestId":  command.Input.ActionRequestID,
		"paramsHash":       requestParamsHash,
		"params":           params,
		"externalObjectId": externalObjectID,
		"externalUrl":      externalURL,
	})
	if err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("marshal effect receipt payload: %w", err)
	}
	receiptID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_effect_receipts(id,workspace_id,target_id,action_request_id,action_type,provider,external_object_id,external_url,effect_hash,payload,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,'create_pull_request','github',$5,$6,$7,$8::jsonb,'user',$9)`, receiptID, command.WorkspaceID, requestTargetID, command.Input.ActionRequestID, externalObjectID, externalURL, effectHash, payload, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert EffectReceipt: %w", err)
	}
	if _, err := tx.Exec(ctx, `update verrail_action_requests set status='executed',updated_at=now() where id=$1`, command.Input.ActionRequestID); err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("update ActionRequest status: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceEffectReceipt, ResourceID: receiptID}
	if err := finishAgentCommand(ctx, tx, meta, result, connectorActionExecutedEvent); err != nil {
		return result, err
	}
	return result, nil
}
