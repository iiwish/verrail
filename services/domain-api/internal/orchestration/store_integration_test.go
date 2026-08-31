package orchestration

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestPostgresOutboxClaimOrderingLeaseRecoveryAndFencing(t *testing.T) {
	databaseURL := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	require.NoError(t, err)
	defer pool.Close()

	var workspaceID string
	require.NoError(t, pool.QueryRow(ctx, `select id from companies order by created_at limit 1`).Scan(&workspaceID))

	eventIDs := []string{
		"17e3d4d2-3654-40f5-a3b3-b98db9cda0f1",
		"17e3d4d2-3654-40f5-a3b3-b98db9cda0f2",
		"17e3d4d2-3654-40f5-a3b3-b98db9cda0f3",
		"17e3d4d2-3654-40f5-a3b3-b98db9cda0f4",
	}
	_, _ = pool.Exec(ctx, `delete from verrail_outbox_events where id = any($1::uuid[])`, eventIDs)
	defer func() {
		_, _ = pool.Exec(ctx, `delete from verrail_outbox_events where id = any($1::uuid[])`, eventIDs)
	}()

	createdAt := time.Now().Add(-time.Hour)
	insert := func(eventID, aggregateID string, offset time.Duration) {
		_, insertErr := pool.Exec(ctx, `
			insert into verrail_outbox_events (
				id, workspace_id, aggregate_type, aggregate_id, event_type, payload, created_at, available_at
			) values ($1, $2, 'target', $3, $4, $5::jsonb, $6, $6)
		`, eventID, workspaceID, aggregateID, TargetCreatedEventType,
			`{"schemaVersion":1,"targetId":"`+aggregateID+`","targetRevisionId":"`+testRevisionID+`"}`,
			createdAt.Add(offset))
		require.NoError(t, insertErr)
	}
	aggregateA := "a5b31660-2d65-46c2-9494-0806ef35de5b"
	aggregateB := "d7c4f0c4-81c5-4c8e-b0ce-a31e4e7d65c0"
	insert(eventIDs[0], aggregateA, 0)
	insert(eventIDs[1], aggregateA, time.Second)
	insert(eventIDs[2], aggregateB, 2*time.Second)
	insert(eventIDs[3], aggregateA, 3*time.Second)

	store := NewPostgresOutboxStore(pool)
	first, err := store.Claim(ctx, ClaimOptions{LeaseDuration: time.Minute})
	require.NoError(t, err)
	require.Equal(t, eventIDs[0], first.ID)
	require.Equal(t, 1, first.AttemptCount)

	secondAggregate, err := store.Claim(ctx, ClaimOptions{LeaseDuration: time.Minute})
	require.NoError(t, err)
	require.Equal(t, eventIDs[2], secondAggregate.ID, "a later event for a claimed aggregate must remain blocked")
	require.NoError(t, store.MarkDelivered(ctx, DeliveryAck{
		EventID: secondAggregate.ID, ClaimToken: secondAggregate.ClaimToken, WorkflowID: "workflow-b", WorkflowRun: "run-b",
	}))

	_, err = pool.Exec(ctx, `update verrail_outbox_events set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`, first.ID)
	require.NoError(t, err)
	reclaimed, err := store.Claim(ctx, ClaimOptions{LeaseDuration: time.Minute})
	require.NoError(t, err)
	require.Equal(t, first.ID, reclaimed.ID)
	require.Equal(t, 2, reclaimed.AttemptCount)
	require.NotEqual(t, first.ClaimToken, reclaimed.ClaimToken)

	err = store.MarkDelivered(ctx, DeliveryAck{
		EventID: first.ID, ClaimToken: first.ClaimToken, WorkflowID: "stale", WorkflowRun: "stale",
	})
	require.True(t, errors.Is(err, ErrClaimLost))
	require.NoError(t, store.MarkDelivered(ctx, DeliveryAck{
		EventID: reclaimed.ID, ClaimToken: reclaimed.ClaimToken, WorkflowID: "workflow-a", WorkflowRun: "run-a",
	}))

	next, err := store.Claim(ctx, ClaimOptions{LeaseDuration: time.Minute})
	require.NoError(t, err)
	require.Equal(t, eventIDs[1], next.ID)
	require.NoError(t, store.MarkFailed(ctx, FailureAck{
		EventID: next.ID, ClaimToken: next.ClaimToken, LastError: "operator repair required",
	}))

	blocked, err := store.Claim(ctx, ClaimOptions{LeaseDuration: time.Minute})
	require.NoError(t, err)
	require.Nil(t, blocked, "a failed predecessor must quarantine newer events for the aggregate")
}
