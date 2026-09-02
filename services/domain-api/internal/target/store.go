package target

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const createCommandType = "target.create.v1"

type Store struct {
	pool *pgxpool.Pool
}

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (store *Store) Create(ctx context.Context, command CreateCommand) (CreateResult, error) {
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return CreateResult{}, fmt.Errorf("begin Target transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	lockKey := command.WorkspaceID + "\n" + command.Principal.Type + "\n" + command.Principal.ID + "\n" + createCommandType + "\n" + command.IdempotencyKey
	if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return CreateResult{}, fmt.Errorf("lock Target command receipt: %w", err)
	}

	var existingHash string
	var existingResponse []byte
	err = tx.QueryRow(ctx, `
		select request_hash, response
		from verrail_command_receipts
		where workspace_id = $1 and principal_type = $2 and principal_id = $3
		  and command_type = $4 and idempotency_key = $5
	`, command.WorkspaceID, command.Principal.Type, command.Principal.ID, createCommandType, command.IdempotencyKey).Scan(&existingHash, &existingResponse)
	if err == nil {
		if existingHash != command.RequestHash {
			return CreateResult{}, IdempotencyConflict()
		}
		var result CreateResult
		if err := json.Unmarshal(existingResponse, &result); err != nil {
			return CreateResult{}, fmt.Errorf("decode Target command receipt: %w", err)
		}
		result.Replayed = true
		if err := tx.Commit(ctx); err != nil {
			return CreateResult{}, fmt.Errorf("commit Target replay: %w", err)
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, fmt.Errorf("read Target command receipt: %w", err)
	}

	if err := assertCreateScope(ctx, tx, command); err != nil {
		return CreateResult{}, err
	}
	displayName, err := assertOwner(ctx, tx, command.WorkspaceID, command.Input.OutcomeOwner)
	if err != nil {
		return CreateResult{}, err
	}

	targetID, err := NewUUID()
	if err != nil {
		return CreateResult{}, fmt.Errorf("generate Target ID: %w", err)
	}
	revisionID, err := NewUUID()
	if err != nil {
		return CreateResult{}, fmt.Errorf("generate TargetRevision ID: %w", err)
	}
	workGraphID, err := NewUUID()
	if err != nil {
		return CreateResult{}, fmt.Errorf("generate WorkGraph ID: %w", err)
	}
	graphRevisionID, err := NewUUID()
	if err != nil {
		return CreateResult{}, fmt.Errorf("generate GraphRevision ID: %w", err)
	}
	receiptID, err := NewUUID()
	if err != nil {
		return CreateResult{}, fmt.Errorf("generate command receipt ID: %w", err)
	}
	auditID, err := NewUUID()
	if err != nil {
		return CreateResult{}, fmt.Errorf("generate AuditEvent ID: %w", err)
	}
	outboxID, err := NewUUID()
	if err != nil {
		return CreateResult{}, fmt.Errorf("generate outbox event ID: %w", err)
	}

	criteria := make([]AcceptanceCriterion, 0, len(command.Input.AcceptanceCriteria))
	for _, input := range command.Input.AcceptanceCriteria {
		criterionID, idErr := NewUUID()
		if idErr != nil {
			return CreateResult{}, fmt.Errorf("generate acceptance criterion ID: %w", idErr)
		}
		criteria = append(criteria, AcceptanceCriterion{ID: criterionID, Title: input.Title, Description: input.Description})
	}
	criteriaJSON, _ := json.Marshal(criteria)
	constraintsJSON, _ := json.Marshal(command.Input.Constraints)
	resourceRefsJSON, _ := json.Marshal(command.Input.ResourceRefs)

	_, err = tx.Exec(ctx, `
		insert into verrail_targets (
			id, workspace_id, collection_id, active_target_revision_id, status,
			created_by_principal_type, created_by_principal_id
		) values ($1, $2, $3, $4, 'draft', $5, $6)
	`, targetID, command.WorkspaceID, command.Input.CollectionID, revisionID, command.Principal.Type, command.Principal.ID)
	if err != nil {
		return CreateResult{}, fmt.Errorf("insert Target: %w", err)
	}

	_, err = tx.Exec(ctx, `
		insert into verrail_target_revisions (
			id, workspace_id, target_id, revision_number, title, summary,
			outcome_owner_principal_type, outcome_owner_principal_id, outcome_owner_display_name,
			goal, constraints, acceptance_criteria, risk_level, deadline, policy_summary, resource_refs, content_hash,
			created_by_principal_type, created_by_principal_id
		) values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb, $16, $17, $18)
	`, revisionID, command.WorkspaceID, targetID, command.Input.Title, command.Input.Summary,
		command.Input.OutcomeOwner.PrincipalType, command.Input.OutcomeOwner.PrincipalID, displayName,
		command.Input.Goal, constraintsJSON, criteriaJSON, command.Input.RiskLevel, command.Input.Deadline,
		command.Input.PolicySummary, resourceRefsJSON, command.RequestHash, command.Principal.Type, command.Principal.ID)
	if err != nil {
		return CreateResult{}, fmt.Errorf("insert TargetRevision: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		insert into verrail_work_graphs (id, workspace_id, target_id, status)
		values ($1, $2, $3, 'draft')
	`, workGraphID, command.WorkspaceID, targetID); err != nil {
		return CreateResult{}, fmt.Errorf("insert WorkGraph: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		insert into verrail_graph_revisions (
			id, workspace_id, target_id, target_revision_id, work_graph_id,
			revision_number, status, content_hash, created_by_principal_type, created_by_principal_id
		) values ($1, $2, $3, $4, $5, 1, 'draft', $6, $7, $8)
	`, graphRevisionID, command.WorkspaceID, targetID, revisionID, workGraphID,
		command.RequestHash, command.Principal.Type, command.Principal.ID); err != nil {
		return CreateResult{}, fmt.Errorf("insert initial GraphRevision: %w", err)
	}

	result := CreateResult{
		SchemaVersion:    SchemaVersion,
		TargetID:         targetID,
		TargetRevisionID: revisionID,
		WorkGraphID:      workGraphID,
		GraphRevisionID:  graphRevisionID,
		WorkbenchHref:    "/targets/" + targetID + "/overview",
		Replayed:         false,
	}
	responseJSON, _ := json.Marshal(result)
	eventPayload, _ := json.Marshal(map[string]any{
		"schemaVersion":    SchemaVersion,
		"targetId":         targetID,
		"targetRevisionId": revisionID,
		"workGraphId":      workGraphID,
		"graphRevisionId":  graphRevisionID,
		"requestHash":      command.RequestHash,
	})

	if _, err := tx.Exec(ctx, `
		insert into verrail_audit_events (
			id, workspace_id, principal_type, principal_id, event_type,
			aggregate_type, aggregate_id, idempotency_key, payload
		) values ($1, $2, $3, $4, 'target.created', 'target', $5, $6, $7::jsonb)
	`, auditID, command.WorkspaceID, command.Principal.Type, command.Principal.ID, targetID, command.IdempotencyKey, eventPayload); err != nil {
		return CreateResult{}, fmt.Errorf("insert Target AuditEvent: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		insert into verrail_outbox_events (
			id, workspace_id, aggregate_type, aggregate_id, event_type, payload
		) values ($1, $2, 'target', $3, 'verrail.target.created.v1', $4::jsonb)
	`, outboxID, command.WorkspaceID, targetID, eventPayload); err != nil {
		return CreateResult{}, fmt.Errorf("insert Target outbox event: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		insert into verrail_command_receipts (
			id, workspace_id, principal_type, principal_id, command_type, idempotency_key,
			request_hash, target_id, target_revision_id, response
		) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
	`, receiptID, command.WorkspaceID, command.Principal.Type, command.Principal.ID, createCommandType,
		command.IdempotencyKey, command.RequestHash, targetID, revisionID, responseJSON); err != nil {
		return CreateResult{}, fmt.Errorf("insert Target command receipt: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return CreateResult{}, fmt.Errorf("commit Target command: %w", err)
	}
	return result, nil
}

func assertCreateScope(ctx context.Context, tx pgx.Tx, command CreateCommand) error {
	var membershipRole *string
	if err := tx.QueryRow(ctx, `
		select membership_role from company_memberships
		where company_id = $1 and principal_type = 'user' and principal_id = $2 and status = 'active'
	`, command.WorkspaceID, command.Principal.ID).Scan(&membershipRole); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CreateForbidden()
		}
		return fmt.Errorf("validate Target creator membership: %w", err)
	}
	if membershipRole != nil && *membershipRole == "viewer" {
		return CreateForbidden()
	}

	if command.Input.CollectionID != nil {
		var collectionExists bool
		if err := tx.QueryRow(ctx, `
			select exists(
				select 1 from verrail_collections collection
				join companies workspace on workspace.id = collection.workspace_id
				where workspace.id = $1 and workspace.status = 'active'
				  and collection.id = $2 and collection.archived_at is null
			)
		`, command.WorkspaceID, *command.Input.CollectionID).Scan(&collectionExists); err != nil {
			return fmt.Errorf("validate Target Collection: %w", err)
		}
		if !collectionExists {
			return NotFound()
		}
	}
	return nil
}

func assertOwner(ctx context.Context, tx pgx.Tx, workspaceID string, owner OutcomeOwner) (*string, error) {
	var displayName *string
	if owner.PrincipalType == "user" {
		err := tx.QueryRow(ctx, `
			select u.name from company_memberships m
			left join "user" u on u.id = m.principal_id
			where m.company_id = $1 and m.principal_type = 'user' and m.principal_id = $2 and m.status = 'active'
		`, workspaceID, owner.PrincipalID).Scan(&displayName)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, OwnerInvalid()
		}
		if err != nil {
			return nil, fmt.Errorf("validate Target user owner: %w", err)
		}
		return displayName, nil
	}
	err := tx.QueryRow(ctx, `
		select name from agents where company_id = $1 and id = $2 and status <> 'terminated'
	`, workspaceID, owner.PrincipalID).Scan(&displayName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, OwnerInvalid()
	}
	if err != nil {
		return nil, fmt.Errorf("validate Target agent owner: %w", err)
	}
	return displayName, nil
}
