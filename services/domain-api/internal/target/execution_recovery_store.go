package target

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func (store *Store) ObserveRunForRecovery(ctx context.Context, workspaceID, runID string, principal Principal) (RunRecoverySnapshot, error) {
	result := RunRecoverySnapshot{SchemaVersion: ExecutionSchemaVersion, WorkspaceID: workspaceID, RunID: runID}
	if principal.Type != "service" {
		return result, forbidden("EXECUTION_COMMAND_FORBIDDEN", "A recovery service Principal is required")
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := assertSchedulingScope(ctx, tx, workspaceID, principal); err != nil {
		return result, err
	}
	var workNodeID, attemptStatus string
	err = tx.QueryRow(ctx, `select target_id,work_node_id,status from verrail_runs where workspace_id=$1 and id=$2 for update`, workspaceID, runID).Scan(&result.TargetID, &workNodeID, &result.RunStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, NotFound()
	}
	if err != nil {
		return result, err
	}
	err = tx.QueryRow(ctx, `select attempt.id,attempt.attempt_number,attempt.status,attempt.fencing_token,lease.id,lease.status,lease.grace_expires_at from verrail_run_attempts attempt join verrail_execution_leases lease on lease.run_attempt_id=attempt.id and lease.workspace_id=attempt.workspace_id where attempt.workspace_id=$1 and attempt.run_id=$2 order by attempt.attempt_number desc limit 1 for update of attempt,lease`, workspaceID, runID).Scan(&result.RunAttemptID, &result.AttemptNumber, &attemptStatus, &result.FencingToken, &result.LeaseID, &result.LeaseStatus, &result.RecoverAfter)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `select clock_timestamp()`).Scan(&now); err != nil {
		return result, err
	}
	liveLease := result.LeaseStatus == "offered" || result.LeaseStatus == "active" || result.LeaseStatus == "suspect"
	liveAttempt := attemptStatus == "pending" || attemptStatus == "running" || attemptStatus == "cancel_requested" || attemptStatus == "cancel_acknowledged"
	if liveLease && liveAttempt && result.RunStatus != "succeeded" && result.RunStatus != "canceled" && !result.RecoverAfter.After(now) {
		if _, err := tx.Exec(ctx, `update verrail_execution_leases set status='expired',released_at=$1,updated_at=$1 where id=$2`, now, result.LeaseID); err != nil {
			return result, err
		}
		if _, err := tx.Exec(ctx, `update verrail_run_attempts set status='failed',error_code='LEASE_EXPIRED',error_message='Execution lease expired during governed recovery',finished_at=$1,updated_at=$1 where id=$2`, now, result.RunAttemptID); err != nil {
			return result, err
		}
		if _, err := tx.Exec(ctx, `update verrail_runs set status='failed',finished_at=$1,updated_at=$1 where id=$2`, now, runID); err != nil {
			return result, err
		}
		if _, err := tx.Exec(ctx, `update verrail_work_nodes set status='blocked',updated_at=$1 where id=$2`, now, workNodeID); err != nil {
			return result, err
		}
		auditID, err := NewUUID()
		if err != nil {
			return result, err
		}
		payload, err := json.Marshal(map[string]any{"schemaVersion": ExecutionSchemaVersion, "runId": runID, "runAttemptId": result.RunAttemptID, "leaseId": result.LeaseID, "fencingToken": result.FencingToken, "reason": "grace_expired"})
		if err != nil {
			return result, err
		}
		if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'service',$3,'run.lease_expired','target',$4,$5,$6::jsonb)`, auditID, workspaceID, principal.ID, result.TargetID, "recovery-expire:"+result.LeaseID, payload); err != nil {
			return result, err
		}
		result.RunStatus, result.LeaseStatus = "failed", "expired"
	}
	err = tx.QueryRow(ctx, `select exists(select 1 from verrail_outbox_events where workspace_id=$1 and aggregate_type='run' and aggregate_id=$2 and status<>'delivered')`, workspaceID, runID).Scan(&result.PendingEvents)
	if err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

func (store *Store) RetryRunOutbox(ctx context.Context, command RetryRunOutboxCommand) (RetryRunOutboxResult, error) {
	const commandType = "run_outbox.retry.v1"
	if command.Principal.Type != "user" {
		return RetryRunOutboxResult{}, forbidden("OUTBOX_RECOVERY_FORBIDDEN", "A Workspace member must explicitly request outbox recovery")
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return RetryRunOutboxResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := assertSchedulingScope(ctx, tx, command.WorkspaceID, command.Principal); err != nil {
		return RetryRunOutboxResult{}, err
	}
	lockKey := command.WorkspaceID + "\n" + command.Principal.ID + "\n" + commandType + "\n" + command.IdempotencyKey
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return RetryRunOutboxResult{}, err
	}
	var targetID string
	err = tx.QueryRow(ctx, `select target_id from verrail_runs where id=$1 and workspace_id=$2 for update`, command.RunID, command.WorkspaceID).Scan(&targetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RetryRunOutboxResult{}, NotFound()
	}
	if err != nil {
		return RetryRunOutboxResult{}, err
	}
	var existingHash string
	var response []byte
	err = tx.QueryRow(ctx, `select request_hash,response from verrail_execution_command_receipts where workspace_id=$1 and principal_type='user' and principal_id=$2 and command_type=$3 and idempotency_key=$4`, command.WorkspaceID, command.Principal.ID, commandType, command.IdempotencyKey).Scan(&existingHash, &response)
	if err == nil {
		if existingHash != command.RequestHash {
			return RetryRunOutboxResult{}, IdempotencyConflict()
		}
		var result RetryRunOutboxResult
		if err := json.Unmarshal(response, &result); err != nil {
			return result, err
		}
		result.Replayed = true
		return result, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return RetryRunOutboxResult{}, err
	}
	var status string
	var attemptCount int
	var lastError *string
	err = tx.QueryRow(ctx, `select status,attempt_count,last_error from verrail_outbox_events where id=$1 and workspace_id=$2 and aggregate_type='run' and aggregate_id=$3 for update`, command.Input.EventID, command.WorkspaceID, command.RunID).Scan(&status, &attemptCount, &lastError)
	if errors.Is(err, pgx.ErrNoRows) {
		return RetryRunOutboxResult{}, NotFound()
	}
	if err != nil {
		return RetryRunOutboxResult{}, err
	}
	if status != "failed" || attemptCount != command.Input.ExpectedAttemptCount {
		return RetryRunOutboxResult{}, &Error{Status: 409, Code: "OUTBOX_RECOVERY_STALE", Message: "The failed outbox event has changed; refresh before retrying"}
	}
	var predecessorExists bool
	err = tx.QueryRow(ctx, `select exists(select 1 from verrail_outbox_events predecessor join verrail_outbox_events event on event.id=$1 where predecessor.workspace_id=event.workspace_id and predecessor.aggregate_type=event.aggregate_type and predecessor.aggregate_id=event.aggregate_id and predecessor.status in ('pending','delivering','failed') and (predecessor.created_at,predecessor.id::text)<(event.created_at,event.id::text))`, command.Input.EventID).Scan(&predecessorExists)
	if err != nil {
		return RetryRunOutboxResult{}, err
	}
	if predecessorExists {
		return RetryRunOutboxResult{}, &Error{Status: 409, Code: "OUTBOX_PREDECESSOR_PENDING", Message: "An earlier outbox event must be delivered first"}
	}
	// Preserve event identity, payload and attempt count; normal ordered delivery owns the next claim.
	if _, err := tx.Exec(ctx, `update verrail_outbox_events set status='pending',available_at=clock_timestamp(),claim_token=null,claimed_at=null,lease_expires_at=null where id=$1`, command.Input.EventID); err != nil {
		return RetryRunOutboxResult{}, err
	}
	result := RetryRunOutboxResult{SchemaVersion: ExecutionSchemaVersion, RunID: command.RunID, EventID: command.Input.EventID, Status: "pending"}
	response, err = json.Marshal(result)
	if err != nil {
		return result, err
	}
	payload, err := json.Marshal(map[string]any{"schemaVersion": ExecutionSchemaVersion, "targetId": targetID, "runId": command.RunID, "eventId": command.Input.EventID, "previousAttemptCount": attemptCount, "previousError": lastError})
	if err != nil {
		return result, err
	}
	receiptID, err := NewUUID()
	if err != nil {
		return result, err
	}
	auditID, err := NewUUID()
	if err != nil {
		return result, err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_execution_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,response) values($1,$2,'user',$3,$4,$5,$6,$7::jsonb)`, receiptID, command.WorkspaceID, command.Principal.ID, commandType, command.IdempotencyKey, command.RequestHash, response); err != nil {
		return result, err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,'user',$3,'run.outbox_retry_requested','target',$4,$5,$6::jsonb)`, auditID, command.WorkspaceID, command.Principal.ID, targetID, command.IdempotencyKey, payload); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
