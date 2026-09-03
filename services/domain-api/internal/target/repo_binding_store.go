package target

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// assertRepoBindingAuthority implements the admin-gated authority rule for the
// repo-binding provisioning command (spec section C): the command principal
// must hold an owner-role membership in the workspace
// (company_memberships.membership_role='owner', principal_type='user',
// status='active') OR be the local-board instance-admin principal
// (instance_user_roles.role='instance_admin'). A principal with no membership
// at all never reaches this check: beginAgentCommand's assertCreateScope
// already rejected it as the first gate.
func assertRepoBindingAuthority(ctx context.Context, tx pgx.Tx, workspaceID, principalID string) error {
	var instanceAdmin bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from instance_user_roles where user_id=$1 and role='instance_admin')`, principalID).Scan(&instanceAdmin); err != nil {
		return fmt.Errorf("validate repo binding instance admin role: %w", err)
	}
	if instanceAdmin {
		return nil
	}
	var membershipRole *string
	err := tx.QueryRow(ctx, `select membership_role from company_memberships where company_id=$1 and principal_type='user' and principal_id=$2 and status='active'`, workspaceID, principalID).Scan(&membershipRole)
	if errors.Is(err, pgx.ErrNoRows) {
		// Defensive: assertCreateScope rejects non-members before this point,
		// so a concurrent demotion is the only way to observe this branch.
		return repoBindingNotOwner()
	} else if err != nil {
		return fmt.Errorf("validate repo binding membership: %w", err)
	}
	if membershipRole == nil || *membershipRole != "owner" {
		return repoBindingNotOwner()
	}
	return nil
}

// assertRepoBindingConnection validates that the referenced connection exists
// in the workspace AND is enabled (join tool_connections on company_id =
// workspace_id and id = connection_id): 404 CONNECTOR_RESOURCE_NOT_FOUND when
// absent, 409 CONNECTOR_CONNECTION_DISABLED when switched off.
func assertRepoBindingConnection(ctx context.Context, tx pgx.Tx, workspaceID, connectionID string) error {
	var enabled bool
	if err := tx.QueryRow(ctx, `select enabled from tool_connections where company_id=$1 and id=$2`, workspaceID, connectionID).Scan(&enabled); errors.Is(err, pgx.ErrNoRows) {
		return connectorNotFound("Connection")
	} else if err != nil {
		return fmt.Errorf("validate repo binding connection: %w", err)
	}
	if !enabled {
		return connectorConnectionDisabled()
	}
	return nil
}

// repoBindingForWorkspace reads the workspace's single binding (one per
// workspace, unique workspace_id) and compares it field-wise against the
// command content: the same {connectionId, repoOwner, repoName} replays the
// existing binding id; different content is a CONNECTOR_BINDING_CONFLICT.
// Returns (nil, nil) when no binding exists.
func compareRepoBindingForReplay(ctx context.Context, tx pgx.Tx, workspaceID string, input CreateGithubRepoBindingInput) (*AgentLifecycleResult, error) {
	var existingID, existingConnectionID, existingOwner, existingName string
	err := tx.QueryRow(ctx, `select id,connection_id,repo_owner,repo_name from verrail_github_repo_bindings where workspace_id=$1`, workspaceID).Scan(&existingID, &existingConnectionID, &existingOwner, &existingName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read repo binding: %w", err)
	}
	if existingConnectionID == input.ConnectionID && existingOwner == input.RepoOwner && existingName == input.RepoName {
		return &AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceRepoBinding, ResourceID: existingID, Replayed: true}, nil
	}
	return nil, connectorBindingConflict()
}

func (store *Store) CreateGithubRepoBinding(ctx context.Context, command AgentLifecycleCommand[CreateGithubRepoBindingInput]) (AgentLifecycleResult, error) {
	meta := lifecycleMeta(command)
	tx, replay, err := store.beginAgentCommand(ctx, meta)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replay != nil {
		return *replay, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// First gate (authority): owner-role membership or instance admin.
	if err := assertRepoBindingAuthority(ctx, tx, command.WorkspaceID, command.Principal.ID); err != nil {
		return AgentLifecycleResult{}, err
	}
	// Second gate: the referenced connection must exist in the workspace and
	// be enabled. It runs before dedup so a repeat against a disabled
	// connection surfaces the disabled state instead of a silent replay.
	if err := assertRepoBindingConnection(ctx, tx, command.WorkspaceID, command.Input.ConnectionID); err != nil {
		return AgentLifecycleResult{}, err
	}
	// Dedup: one binding per workspace. Same content replays; different
	// content conflicts.
	replayed, err := compareRepoBindingForReplay(ctx, tx, command.WorkspaceID, command.Input)
	if err != nil {
		return AgentLifecycleResult{}, err
	}
	if replayed != nil {
		if err := finishAgentCommand(ctx, tx, meta, *replayed, connectorRepoBindingCreatedEvent); err != nil {
			return *replayed, err
		}
		return *replayed, nil
	}
	bindingID, _ := NewUUID()
	// on conflict (workspace_id) do nothing keeps the transaction usable if a
	// concurrent command won the workspace-unique race; the row is then read
	// back and compared as a replay or conflict.
	var insertedID string
	err = tx.QueryRow(ctx, `insert into verrail_github_repo_bindings(id,workspace_id,connection_id,repo_owner,repo_name,created_by_principal_type,created_by_principal_id) values($1,$2,$3,$4,$5,'user',$6) on conflict (workspace_id) do nothing returning id`, bindingID, command.WorkspaceID, command.Input.ConnectionID, command.Input.RepoOwner, command.Input.RepoName, command.Principal.ID).Scan(&insertedID)
	if errors.Is(err, pgx.ErrNoRows) {
		raced, raceErr := compareRepoBindingForReplay(ctx, tx, command.WorkspaceID, command.Input)
		if raceErr != nil {
			return AgentLifecycleResult{}, raceErr
		}
		if raced == nil {
			return AgentLifecycleResult{}, fmt.Errorf("repo binding insert lost the workspace race but no binding row was found")
		}
		if err := finishAgentCommand(ctx, tx, meta, *raced, connectorRepoBindingCreatedEvent); err != nil {
			return *raced, err
		}
		return *raced, nil
	}
	if err != nil {
		return AgentLifecycleResult{}, fmt.Errorf("insert GithubRepoBinding: %w", err)
	}
	result := AgentLifecycleResult{SchemaVersion: SchemaVersion, ResourceType: connectorResourceRepoBinding, ResourceID: insertedID}
	if err := finishAgentCommand(ctx, tx, meta, result, connectorRepoBindingCreatedEvent); err != nil {
		return result, err
	}
	return result, nil
}
