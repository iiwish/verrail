package target

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestRetryRunOutboxRequiresExplicitMemberAndVersion(t *testing.T) {
	for _, principalType := range []string{"agent", "service", ""} {
		command := RetryRunOutboxCommand{WorkspaceID: "11111111-1111-4111-8111-111111111111", RunID: "22222222-2222-4222-8222-222222222222", Principal: Principal{Type: principalType, ID: "operator"}, IdempotencyKey: "recovery-test-key", Input: RetryRunOutboxInput{EventID: "33333333-3333-4333-8333-333333333333", ExpectedAttemptCount: 1}}
		require.Error(t, ValidateRetryRunOutboxCommand(&command))
	}
}

func verifyRunOutboxRecovery(t *testing.T, pool *pgxpool.Pool, store *Store, workspaceID, runID, principalID string) {
	t.Helper()
	ctx := context.Background()
	eventID, successorID := mustNewUUID(t), mustNewUUID(t)
	// These failure injections belong only to the isolated integration fixture.
	_, err := pool.Exec(ctx, `update verrail_outbox_events set status='delivered',workflow_id='integration-fixture',published_at=clock_timestamp() where workspace_id=$1 and aggregate_id=$2`, workspaceID, runID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `insert into verrail_outbox_events(id,workspace_id,aggregate_type,aggregate_id,event_type,payload,status,attempt_count,last_error,created_at) values($1,$2,'run',$3,'verrail.run.cancellation_requested.v1','{"schemaVersion":1,"eventType":"run.cancellation_requested"}','failed',3,'old failure',clock_timestamp()),($4,$2,'run',$3,'verrail.run.attempt_changed.v1','{}','failed',2,'successor failure',clock_timestamp()+interval '1 second')`, eventID, workspaceID, runID, successorID)
	require.NoError(t, err)
	command := RetryRunOutboxCommand{WorkspaceID: workspaceID, RunID: runID, Principal: Principal{Type: "user", ID: principalID}, IdempotencyKey: "g2-7-outbox-recovery", Input: RetryRunOutboxInput{EventID: eventID, ExpectedAttemptCount: 3}}
	require.NoError(t, ValidateRetryRunOutboxCommand(&command))
	blocked := command
	blocked.Input = RetryRunOutboxInput{EventID: successorID, ExpectedAttemptCount: 2}
	require.NoError(t, ValidateRetryRunOutboxCommand(&blocked))
	_, err = store.RetryRunOutbox(ctx, blocked)
	requireLifecycleCode(t, err, "OUTBOX_PREDECESSOR_PENDING")
	stale := command
	stale.Input.ExpectedAttemptCount = 2
	require.NoError(t, ValidateRetryRunOutboxCommand(&stale))
	_, err = store.RetryRunOutbox(ctx, stale)
	requireLifecycleCode(t, err, "OUTBOX_RECOVERY_STALE")
	otherRun := command
	otherRun.RunID = mustNewUUID(t)
	require.NoError(t, ValidateRetryRunOutboxCommand(&otherRun))
	_, err = store.RetryRunOutbox(ctx, otherRun)
	require.Error(t, err)
	result, err := store.RetryRunOutbox(ctx, command)
	require.NoError(t, err)
	require.Equal(t, eventID, result.EventID)
	require.Equal(t, "pending", result.Status)
	require.False(t, result.Replayed)
	replay, err := store.RetryRunOutbox(ctx, command)
	require.NoError(t, err)
	require.True(t, replay.Replayed)
	var status, payload, lastError string
	var attempts, audits int
	require.NoError(t, pool.QueryRow(ctx, `select status,attempt_count,payload->>'eventType',last_error from verrail_outbox_events where id=$1`, eventID).Scan(&status, &attempts, &payload, &lastError))
	require.Equal(t, "pending", status)
	require.Equal(t, 3, attempts)
	require.Equal(t, "run.cancellation_requested", payload)
	require.Equal(t, "old failure", lastError)
	require.NoError(t, pool.QueryRow(ctx, `select status from verrail_outbox_events where id=$1`, successorID).Scan(&status))
	require.Equal(t, "failed", status)
	require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_audit_events where workspace_id=$1 and event_type='run.outbox_retry_requested'`, workspaceID).Scan(&audits))
	require.Equal(t, 1, audits)
	_, err = store.RetryRunOutbox(ctx, blocked)
	require.Error(t, err, "same idempotency key cannot replay a different event")
	_, err = pool.Exec(ctx, `update company_memberships set status='inactive' where company_id=$1 and principal_id=$2`, workspaceID, principalID)
	require.NoError(t, err)
	_, err = store.RetryRunOutbox(ctx, command)
	require.Error(t, err, "a revoked member cannot retrieve a prior receipt")
}
