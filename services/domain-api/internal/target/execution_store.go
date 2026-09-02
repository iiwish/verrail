package target

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type executionCommandMeta struct {
	WorkspaceID, CommandType, IdempotencyKey, RequestHash string
	Principal                                             Principal
}

func beginExecutionCommand[T any](ctx context.Context, store *Store, meta executionCommandMeta, requireHuman bool) (pgx.Tx, *T, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, nil, err
	}
	lockKey := meta.WorkspaceID + "\n" + meta.Principal.Type + "\n" + meta.Principal.ID + "\n" + meta.CommandType + "\n" + meta.IdempotencyKey
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	var existingHash string
	var response []byte
	err = tx.QueryRow(ctx, `select request_hash,response from verrail_execution_command_receipts where workspace_id=$1 and principal_type=$2 and principal_id=$3 and command_type=$4 and idempotency_key=$5`, meta.WorkspaceID, meta.Principal.Type, meta.Principal.ID, meta.CommandType, meta.IdempotencyKey).Scan(&existingHash, &response)
	if err == nil {
		if existingHash != meta.RequestHash {
			_ = tx.Rollback(ctx)
			return nil, nil, IdempotencyConflict()
		}
		var result T
		if err := json.Unmarshal(response, &result); err != nil {
			_ = tx.Rollback(ctx)
			return nil, nil, err
		}
		switch value := any(&result).(type) {
		case *CreateRunAttemptResult:
			value.Replayed = true
		case *ReportRunEventResult:
			value.Replayed = true
		case *RequestRunCancellationResult:
			value.Replayed = true
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, nil, err
		}
		return nil, &result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	if requireHuman {
		if err := assertCreateScope(ctx, tx, CreateCommand{WorkspaceID: meta.WorkspaceID, Principal: meta.Principal}); err != nil {
			_ = tx.Rollback(ctx)
			return nil, nil, err
		}
	}
	return tx, nil, nil
}

func finishExecutionCommand(ctx context.Context, tx pgx.Tx, meta executionCommandMeta, result any, targetID, runID, attemptID, eventType, outboxType string) error {
	receiptID, _ := NewUUID()
	auditID, _ := NewUUID()
	response, _ := json.Marshal(result)
	payload, _ := json.Marshal(map[string]any{"schemaVersion": ExecutionSchemaVersion, "targetId": targetID, "runId": runID, "runAttemptId": attemptID, "eventType": eventType})
	if _, err := tx.Exec(ctx, `insert into verrail_execution_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,response) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, receiptID, meta.WorkspaceID, meta.Principal.Type, meta.Principal.ID, meta.CommandType, meta.IdempotencyKey, meta.RequestHash, response); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload) values($1,$2,$3,$4,$5,'target',$6,$7,$8::jsonb)`, auditID, meta.WorkspaceID, meta.Principal.Type, meta.Principal.ID, eventType, targetID, meta.IdempotencyKey, payload); err != nil {
		return err
	}
	if outboxType != "" {
		outboxID, _ := NewUUID()
		if _, err := tx.Exec(ctx, `insert into verrail_outbox_events(id,workspace_id,aggregate_type,aggregate_id,event_type,payload) values($1,$2,'run',$3,$4,$5::jsonb)`, outboxID, meta.WorkspaceID, runID, outboxType, payload); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (store *Store) CreateRunAttempt(ctx context.Context, command CreateRunAttemptCommand) (CreateRunAttemptResult, error) {
	meta := executionCommandMeta{command.WorkspaceID, "run_attempt.create.v1", command.IdempotencyKey, command.RequestHash, command.Principal}
	tx, replay, err := beginExecutionCommand[CreateRunAttemptResult](ctx, store, meta, true)
	if err != nil {
		return CreateRunAttemptResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var targetID, workNodeID, kind, runStatus string
	var deploymentRevisionID, agentVersionID *string
	var attemptCount int
	err = tx.QueryRow(ctx, `select target_id,work_node_id,kind,status,deployment_revision_id,agent_version_id,attempt_count from verrail_runs where id=$1 and workspace_id=$2 for update`, command.RunID, command.WorkspaceID).Scan(&targetID, &workNodeID, &kind, &runStatus, &deploymentRevisionID, &agentVersionID, &attemptCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateRunAttemptResult{}, NotFound()
	}
	if err != nil {
		return CreateRunAttemptResult{}, err
	}
	if kind != "agent" || deploymentRevisionID == nil || agentVersionID == nil {
		return CreateRunAttemptResult{}, validation("RunAttempt requires a version-bound Agent Run")
	}
	if runStatus == "succeeded" || runStatus == "canceled" || runStatus == "cancel_requested" {
		return CreateRunAttemptResult{}, &Error{Status: 409, Code: "RUN_TERMINAL_OR_CANCELING", Message: "Run cannot create another Attempt"}
	}
	now := time.Now().UTC()
	var latestAttemptID, latestAttemptStatus, latestLeaseID, latestLeaseStatus string
	var latestGraceExpiresAt time.Time
	err = tx.QueryRow(ctx, `select attempt.id,attempt.status,lease.id,lease.status,lease.grace_expires_at from verrail_run_attempts attempt join verrail_execution_leases lease on lease.run_attempt_id=attempt.id and lease.workspace_id=attempt.workspace_id where attempt.run_id=$1 and attempt.workspace_id=$2 order by attempt.attempt_number desc limit 1 for update of attempt,lease`, command.RunID, command.WorkspaceID).Scan(&latestAttemptID, &latestAttemptStatus, &latestLeaseID, &latestLeaseStatus, &latestGraceExpiresAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return CreateRunAttemptResult{}, err
	}
	if err == nil && latestAttemptStatus != "succeeded" && latestAttemptStatus != "failed" && latestAttemptStatus != "canceled" && latestAttemptStatus != "superseded" {
		if latestGraceExpiresAt.After(now) {
			return CreateRunAttemptResult{}, &Error{Status: 409, Code: "ACTIVE_RUN_ATTEMPT_EXISTS", Message: "The current RunAttempt still owns an execution lease"}
		}
		if _, err := tx.Exec(ctx, `update verrail_execution_leases set status='expired',released_at=$1,updated_at=$1 where id=$2`, now, latestLeaseID); err != nil {
			return CreateRunAttemptResult{}, err
		}
		if _, err := tx.Exec(ctx, `update verrail_run_attempts set status='superseded',error_code='LEASE_EXPIRED',error_message='Execution lease expired before recovery',finished_at=$1,updated_at=$1 where id=$2`, now, latestAttemptID); err != nil {
			return CreateRunAttemptResult{}, err
		}
	}
	var attemptNumber int
	var fencingToken int64
	if err := tx.QueryRow(ctx, `select coalesce(max(attempt_number),0)+1,coalesce(max(fencing_token),0)+1 from verrail_run_attempts where run_id=$1`, command.RunID).Scan(&attemptNumber, &fencingToken); err != nil {
		return CreateRunAttemptResult{}, err
	}
	attemptID, _ := NewUUID()
	leaseID, _ := NewUUID()
	expiresAt := now.Add(time.Duration(command.Input.LeaseDurationSeconds) * time.Second)
	graceExpiresAt := expiresAt.Add(time.Duration(command.Input.GraceDurationSeconds) * time.Second)
	if _, err := tx.Exec(ctx, `insert into verrail_run_attempts(id,workspace_id,run_id,attempt_number,deployment_revision_id,agent_version_id,runtime_profile,executor_principal_type,executor_principal_id,fencing_token,status,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,'service',$8,$9,'pending',$10)`, attemptID, command.WorkspaceID, command.RunID, attemptNumber, *deploymentRevisionID, *agentVersionID, command.Input.RuntimeProfile, command.Input.Executor.PrincipalID, fencingToken, command.IdempotencyKey); err != nil {
		return CreateRunAttemptResult{}, err
	}
	if _, err := tx.Exec(ctx, `insert into verrail_execution_leases(id,workspace_id,run_id,run_attempt_id,executor_principal_id,runtime_profile,fencing_token,status,expires_at,grace_expires_at) values($1,$2,$3,$4,$5,$6,$7,'offered',$8,$9)`, leaseID, command.WorkspaceID, command.RunID, attemptID, command.Input.Executor.PrincipalID, command.Input.RuntimeProfile, fencingToken, expiresAt, graceExpiresAt); err != nil {
		return CreateRunAttemptResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_runs set status='queued',attempt_count=$1,finished_at=null,updated_at=$2 where id=$3`, attemptNumber, now, command.RunID); err != nil {
		return CreateRunAttemptResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_work_nodes set status='running',updated_at=$1 where id=$2`, now, workNodeID); err != nil {
		return CreateRunAttemptResult{}, err
	}
	result := CreateRunAttemptResult{SchemaVersion: ExecutionSchemaVersion, RunID: command.RunID, RunAttemptID: attemptID, LeaseID: leaseID, AttemptNumber: attemptNumber, FencingToken: fencingToken, Status: "pending", LeaseStatus: "offered", ExpiresAt: expiresAt.Format(time.RFC3339Nano)}
	if err := finishExecutionCommand(ctx, tx, meta, result, targetID, command.RunID, attemptID, "run.attempt_created", "verrail.run.attempt_changed.v1"); err != nil {
		return result, err
	}
	return result, nil
}

func rejection(code string) *string { return &code }

func (store *Store) ReportRunEvent(ctx context.Context, command ReportRunEventCommand) (ReportRunEventResult, error) {
	meta := executionCommandMeta{command.WorkspaceID, "run_event.report.v1", command.IdempotencyKey, command.RequestHash, command.Principal}
	tx, replay, err := beginExecutionCommand[ReportRunEventResult](ctx, store, meta, false)
	if err != nil {
		return ReportRunEventResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var targetID, workNodeID, executorID, attemptStatus, runStatus, leaseID, leaseStatus, existingHash string
	var fencingToken, lastCursor int64
	var expiresAt, graceExpiresAt time.Time
	err = tx.QueryRow(ctx, `select run.target_id,run.work_node_id,attempt.executor_principal_id,attempt.status,run.status,attempt.fencing_token,attempt.last_event_cursor,lease.id,lease.status,lease.expires_at,lease.grace_expires_at from verrail_run_attempts attempt join verrail_runs run on run.id=attempt.run_id and run.workspace_id=attempt.workspace_id join verrail_execution_leases lease on lease.run_attempt_id=attempt.id and lease.workspace_id=attempt.workspace_id where attempt.id=$1 and attempt.run_id=$2 and attempt.workspace_id=$3 for update of attempt,run,lease`, command.RunAttemptID, command.RunID, command.WorkspaceID).Scan(&targetID, &workNodeID, &executorID, &attemptStatus, &runStatus, &fencingToken, &lastCursor, &leaseID, &leaseStatus, &expiresAt, &graceExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReportRunEventResult{}, NotFound()
	}
	if err != nil {
		return ReportRunEventResult{}, err
	}
	if command.Principal.ID != executorID {
		return ReportRunEventResult{}, forbidden("EXECUTOR_IDENTITY_MISMATCH", "Executor Principal does not own this Attempt")
	}
	baseResult := ReportRunEventResult{SchemaVersion: ExecutionSchemaVersion, RunID: command.RunID, RunAttemptID: command.RunAttemptID, Cursor: command.Input.Cursor, EventType: command.Input.EventType, RunStatus: runStatus, AttemptStatus: attemptStatus, LeaseStatus: leaseStatus}
	var currentAttemptID string
	if err := tx.QueryRow(ctx, `select id from verrail_run_attempts where run_id=$1 and workspace_id=$2 order by attempt_number desc limit 1`, command.RunID, command.WorkspaceID).Scan(&currentAttemptID); err != nil {
		return ReportRunEventResult{}, err
	}
	if currentAttemptID != command.RunAttemptID || fencingToken != command.Input.FencingToken || leaseID != command.Input.LeaseID {
		baseResult.RejectionCode = rejection("STALE_FENCING_TOKEN")
		if err := finishExecutionCommand(ctx, tx, meta, baseResult, targetID, command.RunID, command.RunAttemptID, "run.event_rejected_stale_fence", ""); err != nil {
			return baseResult, err
		}
		return baseResult, nil
	}
	err = tx.QueryRow(ctx, `select content_hash from verrail_run_events where run_attempt_id=$1 and cursor=$2`, command.RunAttemptID, command.Input.Cursor).Scan(&existingHash)
	if err == nil {
		if existingHash != command.RequestHash {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "RUN_EVENT_CURSOR_CONFLICT", Message: "Cursor already contains a different event"}
		}
		baseResult.Authoritative, baseResult.Replayed = true, true
		if err := finishExecutionCommand(ctx, tx, meta, baseResult, targetID, command.RunID, command.RunAttemptID, "run.event_replayed", ""); err != nil {
			return baseResult, err
		}
		return baseResult, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ReportRunEventResult{}, err
	}
	if command.Input.Cursor != lastCursor+1 {
		baseResult.RejectionCode = rejection("EVENT_CURSOR_GAP")
		if err := finishExecutionCommand(ctx, tx, meta, baseResult, targetID, command.RunID, command.RunAttemptID, "run.event_rejected_cursor_gap", ""); err != nil {
			return baseResult, err
		}
		return baseResult, nil
	}
	now := time.Now().UTC()
	terminal := attemptStatus == "succeeded" || attemptStatus == "failed" || attemptStatus == "canceled" || attemptStatus == "superseded"
	if terminal {
		baseResult.RejectionCode = rejection("ATTEMPT_TERMINAL")
		if err := finishExecutionCommand(ctx, tx, meta, baseResult, targetID, command.RunID, command.RunAttemptID, "run.event_rejected_terminal", ""); err != nil {
			return baseResult, err
		}
		return baseResult, nil
	}
	if now.After(graceExpiresAt) || leaseStatus == "expired" || leaseStatus == "released" || leaseStatus == "revoked" {
		if leaseStatus != "expired" && leaseStatus != "released" && leaseStatus != "revoked" {
			leaseStatus, attemptStatus, runStatus = "expired", "failed", "failed"
			_, _ = tx.Exec(ctx, `update verrail_execution_leases set status='expired',released_at=$1,updated_at=$1 where id=$2`, now, leaseID)
			_, _ = tx.Exec(ctx, `update verrail_run_attempts set status='failed',error_code='LEASE_EXPIRED',error_message='Execution lease expired',finished_at=$1,updated_at=$1 where id=$2`, now, command.RunAttemptID)
			_, _ = tx.Exec(ctx, `update verrail_runs set status='failed',finished_at=$1,updated_at=$1 where id=$2`, now, command.RunID)
			_, _ = tx.Exec(ctx, `update verrail_work_nodes set status='blocked',updated_at=$1 where id=$2`, now, workNodeID)
		}
		baseResult.RunStatus, baseResult.AttemptStatus, baseResult.LeaseStatus = runStatus, attemptStatus, leaseStatus
		baseResult.RejectionCode = rejection("LEASE_NOT_ACTIVE")
		if err := finishExecutionCommand(ctx, tx, meta, baseResult, targetID, command.RunID, command.RunAttemptID, "run.event_rejected_expired_lease", "verrail.run.attempt_changed.v1"); err != nil {
			return baseResult, err
		}
		return baseResult, nil
	}
	if now.After(expiresAt) && command.Input.EventType != "heartbeat" {
		leaseStatus = "suspect"
		if _, err := tx.Exec(ctx, `update verrail_execution_leases set status='suspect',updated_at=$1 where id=$2`, now, leaseID); err != nil {
			return ReportRunEventResult{}, err
		}
		baseResult.LeaseStatus = leaseStatus
		baseResult.RejectionCode = rejection("LEASE_NOT_ACTIVE")
		if err := finishExecutionCommand(ctx, tx, meta, baseResult, targetID, command.RunID, command.RunAttemptID, "run.event_rejected_suspect_lease", "verrail.run.attempt_changed.v1"); err != nil {
			return baseResult, err
		}
		return baseResult, nil
	}
	if (attemptStatus == "cancel_requested" || attemptStatus == "cancel_acknowledged") && command.Input.EventType != "cancel_acknowledged" && command.Input.EventType != "terminated" && command.Input.EventType != "heartbeat" {
		baseResult.RejectionCode = rejection("CANCELLATION_IN_PROGRESS")
		if err := finishExecutionCommand(ctx, tx, meta, baseResult, targetID, command.RunID, command.RunAttemptID, "run.event_rejected_canceling", ""); err != nil {
			return baseResult, err
		}
		return baseResult, nil
	}
	payload, _ := json.Marshal(command.Input.Payload)
	eventID, _ := NewUUID()
	if _, err := tx.Exec(ctx, `insert into verrail_run_events(id,workspace_id,run_id,run_attempt_id,cursor,fencing_token,event_type,payload,content_hash,emitted_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, eventID, command.WorkspaceID, command.RunID, command.RunAttemptID, command.Input.Cursor, command.Input.FencingToken, command.Input.EventType, payload, command.RequestHash, command.Input.EmittedAt); err != nil {
		return ReportRunEventResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_run_attempts set last_event_cursor=$1,updated_at=$2 where id=$3`, command.Input.Cursor, now, command.RunAttemptID); err != nil {
		return ReportRunEventResult{}, err
	}
	switch command.Input.EventType {
	case "claimed":
		if leaseStatus != "offered" || attemptStatus != "pending" {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "INVALID_ATTEMPT_TRANSITION", Message: "Lease can only be claimed once"}
		}
		leaseStatus = "active"
		_, err = tx.Exec(ctx, `update verrail_execution_leases set status='active',claimed_at=$1,last_heartbeat_at=$1,updated_at=$1 where id=$2`, now, leaseID)
	case "heartbeat":
		if leaseStatus != "active" && leaseStatus != "suspect" {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "INVALID_ATTEMPT_TRANSITION", Message: "Heartbeat requires an active or suspect lease"}
		}
		extend := command.Input.ExtendLeaseSeconds
		if extend == 0 {
			extend = 120
		}
		expiresAt = now.Add(time.Duration(extend) * time.Second)
		graceExpiresAt = expiresAt.Add(30 * time.Second)
		leaseStatus = "active"
		_, err = tx.Exec(ctx, `update verrail_execution_leases set status='active',expires_at=$1,grace_expires_at=$2,last_heartbeat_at=$3,updated_at=$3 where id=$4`, expiresAt, graceExpiresAt, now, leaseID)
	case "started":
		if leaseStatus != "active" || attemptStatus != "pending" {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "INVALID_ATTEMPT_TRANSITION", Message: "Started requires a claimed pending Attempt"}
		}
		attemptStatus, runStatus = "running", "running"
		_, err = tx.Exec(ctx, `update verrail_run_attempts set status='running',started_at=$1,updated_at=$1 where id=$2`, now, command.RunAttemptID)
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_runs set status='running',started_at=coalesce(started_at,$1),updated_at=$1 where id=$2`, now, command.RunID)
		}
	case "progress":
		if leaseStatus != "active" || attemptStatus != "running" {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "INVALID_ATTEMPT_TRANSITION", Message: "Progress requires a running Attempt"}
		}
	case "succeeded":
		if leaseStatus != "active" || attemptStatus != "running" {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "INVALID_ATTEMPT_TRANSITION", Message: "Success requires a running Attempt"}
		}
		attemptStatus, runStatus, leaseStatus = "succeeded", "succeeded", "released"
		_, err = tx.Exec(ctx, `update verrail_run_attempts set status='succeeded',result=$1::jsonb,finished_at=$2,updated_at=$2 where id=$3`, payload, now, command.RunAttemptID)
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_execution_leases set status='released',released_at=$1,updated_at=$1 where id=$2`, now, leaseID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_runs set status='succeeded',finished_at=$1,updated_at=$1 where id=$2`, now, command.RunID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_work_nodes set status='completed',updated_at=$1 where id=$2`, now, workNodeID)
		}
	case "failed":
		if leaseStatus != "active" || (attemptStatus != "running" && attemptStatus != "pending") {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "INVALID_ATTEMPT_TRANSITION", Message: "Failure requires an active Attempt"}
		}
		errorCode, _ := command.Input.Payload["errorCode"].(string)
		errorMessage, _ := command.Input.Payload["errorMessage"].(string)
		attemptStatus, runStatus, leaseStatus = "failed", "failed", "released"
		_, err = tx.Exec(ctx, `update verrail_run_attempts set status='failed',error_code=$1,error_message=$2,finished_at=$3,updated_at=$3 where id=$4`, errorCode, errorMessage, now, command.RunAttemptID)
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_execution_leases set status='released',released_at=$1,updated_at=$1 where id=$2`, now, leaseID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_runs set status='failed',finished_at=$1,updated_at=$1 where id=$2`, now, command.RunID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_work_nodes set status='blocked',updated_at=$1 where id=$2`, now, workNodeID)
		}
	case "cancel_acknowledged":
		if attemptStatus != "cancel_requested" {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "INVALID_ATTEMPT_TRANSITION", Message: "Cancellation must be requested before acknowledgement"}
		}
		attemptStatus = "cancel_acknowledged"
		_, err = tx.Exec(ctx, `update verrail_run_attempts set status='cancel_acknowledged',updated_at=$1 where id=$2`, now, command.RunAttemptID)
	case "terminated":
		if attemptStatus != "cancel_requested" && attemptStatus != "cancel_acknowledged" {
			return ReportRunEventResult{}, &Error{Status: 409, Code: "INVALID_ATTEMPT_TRANSITION", Message: "Termination requires observable cancellation"}
		}
		attemptStatus, runStatus, leaseStatus = "canceled", "canceled", "released"
		_, err = tx.Exec(ctx, `update verrail_run_attempts set status='canceled',result=$1::jsonb,finished_at=$2,updated_at=$2 where id=$3`, payload, now, command.RunAttemptID)
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_execution_leases set status='released',released_at=$1,updated_at=$1 where id=$2`, now, leaseID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_runs set status='canceled',finished_at=$1,updated_at=$1 where id=$2`, now, command.RunID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `update verrail_work_nodes set status='canceled',updated_at=$1 where id=$2`, now, workNodeID)
		}
	}
	if err != nil {
		return ReportRunEventResult{}, err
	}
	baseResult.Authoritative = true
	baseResult.RunStatus, baseResult.AttemptStatus, baseResult.LeaseStatus = runStatus, attemptStatus, leaseStatus
	if err := finishExecutionCommand(ctx, tx, meta, baseResult, targetID, command.RunID, command.RunAttemptID, "run.event_"+command.Input.EventType, "verrail.run.attempt_changed.v1"); err != nil {
		return baseResult, err
	}
	return baseResult, nil
}

func (store *Store) RequestRunCancellation(ctx context.Context, command RequestRunCancellationCommand) (RequestRunCancellationResult, error) {
	meta := executionCommandMeta{command.WorkspaceID, "run.cancel.request.v1", command.IdempotencyKey, command.RequestHash, command.Principal}
	tx, replay, err := beginExecutionCommand[RequestRunCancellationResult](ctx, store, meta, true)
	if err != nil {
		return RequestRunCancellationResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var targetID, runStatus, attemptID, attemptStatus string
	err = tx.QueryRow(ctx, `select run.target_id,run.status,attempt.id,attempt.status from verrail_runs run join verrail_run_attempts attempt on attempt.run_id=run.id and attempt.workspace_id=run.workspace_id where run.id=$1 and run.workspace_id=$2 order by attempt.attempt_number desc limit 1 for update of run,attempt`, command.RunID, command.WorkspaceID).Scan(&targetID, &runStatus, &attemptID, &attemptStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return RequestRunCancellationResult{}, NotFound()
	}
	if err != nil {
		return RequestRunCancellationResult{}, err
	}
	if runStatus == "succeeded" || runStatus == "failed" || runStatus == "canceled" || attemptStatus == "succeeded" || attemptStatus == "failed" || attemptStatus == "canceled" || attemptStatus == "superseded" {
		return RequestRunCancellationResult{}, &Error{Status: 409, Code: "RUN_TERMINAL", Message: "A terminal Run cannot be canceled"}
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `update verrail_runs set status='cancel_requested',cancel_requested_at=$1,updated_at=$1 where id=$2`, now, command.RunID); err != nil {
		return RequestRunCancellationResult{}, err
	}
	if _, err := tx.Exec(ctx, `update verrail_run_attempts set status='cancel_requested',updated_at=$1 where id=$2`, now, attemptID); err != nil {
		return RequestRunCancellationResult{}, err
	}
	result := RequestRunCancellationResult{SchemaVersion: ExecutionSchemaVersion, RunID: command.RunID, RunAttemptID: attemptID, RunStatus: "cancel_requested", AttemptStatus: "cancel_requested"}
	if err := finishExecutionCommand(ctx, tx, meta, result, targetID, command.RunID, attemptID, "run.cancellation_requested", "verrail.run.cancellation_requested.v1"); err != nil {
		return result, err
	}
	return result, nil
}
