package orchestration

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrClaimLost = errors.New("outbox claim is no longer owned")

type PostgresOutboxStore struct {
	pool *pgxpool.Pool
}

func NewPostgresOutboxStore(pool *pgxpool.Pool) *PostgresOutboxStore {
	return &PostgresOutboxStore{pool: pool}
}

func (store *PostgresOutboxStore) Claim(ctx context.Context, options ClaimOptions) (*OutboxEvent, error) {
	claimToken, err := newUUID()
	if err != nil {
		return nil, fmt.Errorf("generate outbox claim token: %w", err)
	}
	var event OutboxEvent
	err = store.pool.QueryRow(ctx, `
		with candidate as (
			select event.id
			from verrail_outbox_events event
			where (
				(event.status = 'pending' and event.available_at <= clock_timestamp())
				or (event.status = 'delivering' and event.lease_expires_at <= clock_timestamp())
			)
			and not exists (
				select 1
				from verrail_outbox_events predecessor
				where predecessor.aggregate_type = event.aggregate_type
				  and predecessor.aggregate_id = event.aggregate_id
				  and predecessor.status in ('pending', 'delivering', 'failed')
				  and (
					predecessor.created_at < event.created_at
					or (predecessor.created_at = event.created_at and predecessor.id::text < event.id::text)
				  )
			)
			order by event.available_at, event.created_at, event.id
			for update of event skip locked
			limit 1
		)
		update verrail_outbox_events event
		set status = 'delivering',
			attempt_count = event.attempt_count + 1,
			claim_token = $1,
			claimed_at = clock_timestamp(),
			lease_expires_at = clock_timestamp() + make_interval(secs => $2),
			last_error = null
		from candidate
		where event.id = candidate.id
		returning event.id, event.workspace_id, event.aggregate_type, event.aggregate_id,
			event.event_type, event.payload, event.attempt_count, event.claim_token, event.created_at
	`, claimToken, options.LeaseDuration.Seconds()).Scan(
		&event.ID,
		&event.WorkspaceID,
		&event.AggregateType,
		&event.AggregateID,
		&event.EventType,
		&event.Payload,
		&event.AttemptCount,
		&event.ClaimToken,
		&event.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("claim available outbox event: %w", err)
	}
	return &event, nil
}

func (store *PostgresOutboxStore) MarkDelivered(ctx context.Context, acknowledgment DeliveryAck) error {
	command, err := store.pool.Exec(ctx, `
		update verrail_outbox_events
		set status = 'delivered',
			workflow_id = $3,
			workflow_run_id = nullif($4, ''),
			published_at = clock_timestamp(),
			claimed_at = null,
			lease_expires_at = null,
			last_error = null
		where id = $1 and status = 'delivering' and claim_token = $2
	`, acknowledgment.EventID, acknowledgment.ClaimToken, acknowledgment.WorkflowID, acknowledgment.WorkflowRun)
	return exactClaimResult(command.RowsAffected(), err)
}

func (store *PostgresOutboxStore) MarkRetry(ctx context.Context, acknowledgment RetryAck) error {
	command, err := store.pool.Exec(ctx, `
		update verrail_outbox_events
		set status = 'pending',
			available_at = $3,
			claim_token = null,
			claimed_at = null,
			lease_expires_at = null,
			last_error = $4
		where id = $1 and status = 'delivering' and claim_token = $2
	`, acknowledgment.EventID, acknowledgment.ClaimToken, acknowledgment.AvailableAt, acknowledgment.LastError)
	return exactClaimResult(command.RowsAffected(), err)
}

func (store *PostgresOutboxStore) MarkFailed(ctx context.Context, acknowledgment FailureAck) error {
	command, err := store.pool.Exec(ctx, `
		update verrail_outbox_events
		set status = 'failed',
			claim_token = null,
			claimed_at = null,
			lease_expires_at = null,
			last_error = $3
		where id = $1 and status = 'delivering' and claim_token = $2
	`, acknowledgment.EventID, acknowledgment.ClaimToken, acknowledgment.LastError)
	return exactClaimResult(command.RowsAffected(), err)
}

func exactClaimResult(rowsAffected int64, err error) error {
	if err != nil {
		return err
	}
	if rowsAffected != 1 {
		return ErrClaimLost
	}
	return nil
}

func newUUID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16]), nil
}
