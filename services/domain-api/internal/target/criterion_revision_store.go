package target

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

func (store *Store) ReviseTargetProof(ctx context.Context, command ReviseTargetProofCommand) (ReviseTargetProofResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return ReviseTargetProofResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: command.WorkspaceID, Principal: command.Principal}); err != nil {
		return ReviseTargetProofResult{}, err
	}
	const commandType = "target.proof.revise.v1"
	if _, err = tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,0))`, command.WorkspaceID+"\n"+command.Principal.ID+"\n"+commandType+"\n"+command.IdempotencyKey); err != nil {
		return ReviseTargetProofResult{}, err
	}
	var existingHash string
	var response []byte
	err = tx.QueryRow(ctx, `select request_hash,response from verrail_command_receipts where workspace_id=$1 and principal_type='user' and principal_id=$2 and command_type=$3 and idempotency_key=$4`, command.WorkspaceID, command.Principal.ID, commandType, command.IdempotencyKey).Scan(&existingHash, &response)
	if err == nil {
		if existingHash != command.RequestHash {
			return ReviseTargetProofResult{}, IdempotencyConflict()
		}
		var result ReviseTargetProofResult
		if err = json.Unmarshal(response, &result); err != nil {
			return result, err
		}
		result.Replayed = true
		return result, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return ReviseTargetProofResult{}, err
	}
	var activeRevision, graphID string
	err = tx.QueryRow(ctx, `select target.active_target_revision_id,graph.id from verrail_targets target join verrail_work_graphs graph on graph.target_id=target.id and graph.workspace_id=target.workspace_id where target.id=$1 and target.workspace_id=$2 for update`, command.TargetID, command.WorkspaceID).Scan(&activeRevision, &graphID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReviseTargetProofResult{}, NotFound()
	}
	if err != nil {
		return ReviseTargetProofResult{}, err
	}
	if activeRevision != command.Input.ExpectedTargetRevisionID {
		return ReviseTargetProofResult{}, &Error{Status: 409, Code: "TARGET_REVISION_CONFLICT", Message: "Target active revision changed"}
	}
	// Refuse a version switch while an external operation has an unresolved outcome.
	var inFlight bool
	if err = tx.QueryRow(ctx, `select exists(select 1 from verrail_action_requests where target_id=$1 and workspace_id=$2 and status in ('executing','unknown_effect'))`, command.TargetID, command.WorkspaceID).Scan(&inFlight); err != nil {
		return ReviseTargetProofResult{}, err
	}
	if inFlight {
		return ReviseTargetProofResult{}, &Error{Status: 409, Code: "TARGET_EFFECT_UNSETTLED", Message: "Reconcile the external effect before revising its Target"}
	}
	if err = tx.QueryRow(ctx, `select exists(select 1 from verrail_runs where target_id=$1 and workspace_id=$2 and status in ('queued','running','cancel_requested'))`, command.TargetID, command.WorkspaceID).Scan(&inFlight); err != nil {
		return ReviseTargetProofResult{}, err
	}
	if inFlight {
		return ReviseTargetProofResult{}, &Error{Status: 409, Code: "TARGET_EXECUTION_UNSETTLED", Message: "Settle or cancel active Runs before revising their Target"}
	}
	var criteriaJSON, originalJSON []byte
	var revisionNumber int
	if err = tx.QueryRow(ctx, `select acceptance_criteria,revision_number,to_jsonb(revision)-'id'-'created_at'-'created_by_principal_type'-'created_by_principal_id'-'content_hash' from verrail_target_revisions revision where id=$1 and workspace_id=$2`, activeRevision, command.WorkspaceID).Scan(&criteriaJSON, &revisionNumber, &originalJSON); err != nil {
		return ReviseTargetProofResult{}, err
	}
	var criteria []AcceptanceCriterion
	if err = json.Unmarshal(criteriaJSON, &criteria); err != nil {
		return ReviseTargetProofResult{}, err
	}
	changes := map[string]CriterionProofContract{}
	for _, change := range command.Input.Criteria {
		changes[change.CriterionID] = change.ProofContract
	}
	for index := range criteria {
		if contract, ok := changes[criteria[index].ID]; ok {
			criteria[index].ProofContract = &contract
			delete(changes, criteria[index].ID)
		}
	}
	if len(changes) > 0 {
		return ReviseTargetProofResult{}, validation("Every criterion must belong to the expected TargetRevision")
	}
	criteriaJSON, _ = json.Marshal(criteria)
	revisionID, _ := NewUUID()
	var original map[string]any
	if err = json.Unmarshal(originalJSON, &original); err != nil {
		return ReviseTargetProofResult{}, err
	}
	original["acceptance_criteria"] = criteria
	original["revision_number"] = revisionNumber + 1
	contentHash := proofHash(original)
	_, err = tx.Exec(ctx, `insert into verrail_target_revisions(id,workspace_id,target_id,revision_number,title,summary,outcome_owner_principal_type,outcome_owner_principal_id,outcome_owner_display_name,goal,constraints,acceptance_criteria,risk_level,deadline,policy_summary,resource_refs,content_hash,created_by_principal_type,created_by_principal_id)
 select $1,workspace_id,target_id,revision_number+1,title,summary,outcome_owner_principal_type,outcome_owner_principal_id,outcome_owner_display_name,goal,constraints,$2::jsonb,risk_level,deadline,policy_summary,resource_refs,$3,'user',$4 from verrail_target_revisions where id=$5 and workspace_id=$6`, revisionID, criteriaJSON, contentHash, command.Principal.ID, activeRevision, command.WorkspaceID)
	if err != nil {
		return ReviseTargetProofResult{}, err
	}
	if _, err = tx.Exec(ctx, `update verrail_graph_revisions set status='superseded' where work_graph_id=$1 and status='active'`, graphID); err != nil {
		return ReviseTargetProofResult{}, err
	}
	if _, err = tx.Exec(ctx, `update verrail_work_graphs set active_graph_revision_id=null,status='draft',updated_at=now() where id=$1`, graphID); err != nil {
		return ReviseTargetProofResult{}, err
	}
	if _, err = tx.Exec(ctx, `update verrail_targets set active_target_revision_id=$1,updated_at=now() where id=$2 and workspace_id=$3`, revisionID, command.TargetID, command.WorkspaceID); err != nil {
		return ReviseTargetProofResult{}, err
	}
	result := ReviseTargetProofResult{SchemaVersion: 1, TargetID: command.TargetID, TargetRevisionID: revisionID, RevisionNumber: revisionNumber + 1}
	response, _ = json.Marshal(result)
	receiptID, _ := NewUUID()
	if _, err = tx.Exec(ctx, `insert into verrail_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,target_id,target_revision_id,response) values($1,$2,'user',$3,$4,$5,$6,$7,$8,$9::jsonb)`, receiptID, command.WorkspaceID, command.Principal.ID, commandType, command.IdempotencyKey, command.RequestHash, command.TargetID, revisionID, response); err != nil {
		return result, err
	}
	auditID, _ := NewUUID()
	payload, _ := json.Marshal(map[string]any{"targetRevisionId": revisionID, "previousTargetRevisionId": activeRevision, "revisionNumber": revisionNumber + 1, "contentHash": contentHash})
	if _, err = tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'user',$3,'target.revision_created','target',$4,$5,$6::jsonb)`, auditID, command.WorkspaceID, command.Principal.ID, command.TargetID, command.IdempotencyKey, payload); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
