package target

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestCreateGithubRepoBindingInputValidation(t *testing.T) {
	valid := CreateGithubRepoBindingInput{
		ConnectionID: "66666666-6666-4666-8666-666666666666",
		RepoOwner:    "verrail",
		RepoName:     "verrail",
	}
	require.NoError(t, ValidateCreateGithubRepoBindingInput(&valid))

	badConnection := valid
	badConnection.ConnectionID = "not-a-uuid"
	require.Error(t, ValidateCreateGithubRepoBindingInput(&badConnection))

	blankOwner := valid
	blankOwner.RepoOwner = "   "
	require.Error(t, ValidateCreateGithubRepoBindingInput(&blankOwner))

	longOwner := valid
	longOwner.RepoOwner = strings.Repeat("o", 201)
	require.Error(t, ValidateCreateGithubRepoBindingInput(&longOwner))

	boundaryOwner := valid
	boundaryOwner.RepoOwner = strings.Repeat("o", 200)
	require.NoError(t, ValidateCreateGithubRepoBindingInput(&boundaryOwner))

	blankName := valid
	blankName.RepoName = ""
	require.Error(t, ValidateCreateGithubRepoBindingInput(&blankName))

	longName := valid
	longName.RepoName = strings.Repeat("n", 201)
	require.Error(t, ValidateCreateGithubRepoBindingInput(&longName))

	// Trimming normalizes the wire values before they reach the store.
	trimmed := CreateGithubRepoBindingInput{ConnectionID: valid.ConnectionID, RepoOwner: "  verrail  ", RepoName: "\tverrail\n"}
	require.NoError(t, ValidateCreateGithubRepoBindingInput(&trimmed))
	require.Equal(t, "verrail", trimmed.RepoOwner)
	require.Equal(t, "verrail", trimmed.RepoName)
}

func TestRepoBindingHashCanonical(t *testing.T) {
	base := CreateGithubRepoBindingInput{ConnectionID: "66666666-6666-4666-8666-666666666666", RepoOwner: "verrail", RepoName: "verrail"}
	digest, err := repoBindingHash(base)
	require.NoError(t, err)
	require.Regexp(t, `^[0-9a-f]{64}$`, digest)

	again, err := repoBindingHash(base)
	require.NoError(t, err)
	require.Equal(t, digest, again)

	changedConnection := base
	changedConnection.ConnectionID = "77777777-7777-4777-8777-777777777777"
	changedDigest, err := repoBindingHash(changedConnection)
	require.NoError(t, err)
	require.NotEqual(t, digest, changedDigest)

	changedOwner := base
	changedOwner.RepoOwner = "other"
	ownerDigest, err := repoBindingHash(changedOwner)
	require.NoError(t, err)
	require.NotEqual(t, digest, ownerDigest)

	changedName := base
	changedName.RepoName = "other"
	nameDigest, err := repoBindingHash(changedName)
	require.NoError(t, err)
	require.NotEqual(t, digest, nameDigest)
}

// repoBindingTestHarness extends the connector harness: the connector suite
// already provisions targets, submissions, connections, and the binding
// cleanup, and the repo-binding command shares its receipt/audit spine.
type repoBindingTestHarness struct {
	*connectorTestHarness
	nonOwnerID        string
	instanceAdminID   string
	noMemberID        string
	nonOwnerKeys      []string
	instanceAdminKeys []string
	noMemberKeys      []string
}

func newRepoBindingTestHarness(t *testing.T, pool *pgxpool.Pool) *repoBindingTestHarness {
	t.Helper()
	connector := newConnectorTestHarness(t, pool)
	// The binding command is admin-gated: promote the shared harness principal
	// to the workspace owner role for the happy-path commands.
	_, err := pool.Exec(context.Background(), `update company_memberships set membership_role='owner' where company_id=$1 and principal_id=$2`, connector.workspaceID, connector.principalID)
	require.NoError(t, err)
	nonOwnerID := "repo-binding-non-owner"
	_, err = pool.Exec(context.Background(), `
		insert into company_memberships (company_id, principal_type, principal_id, status, membership_role)
		values ($1, 'user', $2, 'active', 'member')
	`, connector.workspaceID, nonOwnerID)
	require.NoError(t, err)
	instanceAdminID := "repo-binding-instance-admin"
	_, err = pool.Exec(context.Background(), `
		insert into company_memberships (company_id, principal_type, principal_id, status, membership_role)
		values ($1, 'user', $2, 'active', 'member')
	`, connector.workspaceID, instanceAdminID)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), `
		insert into instance_user_roles (id, user_id, role)
		values ($1, $2, 'instance_admin')
	`, mustNewUUID(t), instanceAdminID)
	require.NoError(t, err)
	harness := &repoBindingTestHarness{
		connectorTestHarness: connector,
		nonOwnerID:           nonOwnerID,
		instanceAdminID:      instanceAdminID,
		noMemberID:           "repo-binding-no-member",
	}
	// Defensive: tests in this package run sequentially against one seeded
	// workspace and the connector harness cleanup already treats workspace
	// bindings as harness-owned, so drop any row a prior crashed run left.
	_, err = pool.Exec(context.Background(), `delete from verrail_github_repo_bindings where workspace_id=$1`, harness.workspaceID)
	require.NoError(t, err)
	return harness
}

func buildRepoBindingCommandAs(h *repoBindingTestHarness, principalID string, input CreateGithubRepoBindingInput) AgentLifecycleCommand[CreateGithubRepoBindingInput] {
	h.t.Helper()
	idempotencyKey := "repo-binding-it-" + mustNewUUID(h.t)
	switch principalID {
	case h.principalID:
		h.receiptKeys = append(h.receiptKeys, idempotencyKey)
	case h.nonOwnerID:
		h.nonOwnerKeys = append(h.nonOwnerKeys, idempotencyKey)
	case h.instanceAdminID:
		h.instanceAdminKeys = append(h.instanceAdminKeys, idempotencyKey)
	case h.noMemberID:
		h.noMemberKeys = append(h.noMemberKeys, idempotencyKey)
	}
	command := AgentLifecycleCommand[CreateGithubRepoBindingInput]{
		WorkspaceID:    h.workspaceID,
		Principal:      Principal{Type: "user", ID: principalID},
		IdempotencyKey: idempotencyKey,
		CommandType:    ConnectorRepoBindingCreateCommand,
		Input:          input,
	}
	if err := ValidateAgentLifecycleCommand(&command); err != nil {
		h.t.Fatalf("validate %s command: %v", ConnectorRepoBindingCreateCommand, err)
	}
	return command
}

func (h *repoBindingTestHarness) createBindingAs(principalID string, input CreateGithubRepoBindingInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	return h.store.CreateGithubRepoBinding(context.Background(), buildRepoBindingCommandAs(h, principalID, input))
}

// provisionConnection provisions a tool_application + tool_connection pair for
// the workspace, like the connector harness, and returns the connection id.
func (h *repoBindingTestHarness) provisionConnection(enabled bool) string {
	h.t.Helper()
	ctx := context.Background()
	applicationID := mustNewUUID(h.t)
	_, err := h.pool.Exec(ctx, `
		insert into tool_applications (id, company_id, name, type, status)
		values ($1, $2, $3, 'a2a', 'active')
	`, applicationID, h.workspaceID, "repo-binding-test-app-"+mustNewUUID(h.t)[:8])
	require.NoError(h.t, err)
	h.applicationIDs = append(h.applicationIDs, applicationID)
	connectionID := mustNewUUID(h.t)
	_, err = h.pool.Exec(ctx, `
		insert into tool_connections (id, company_id, application_id, name, uid, transport, status, enabled)
		values ($1, $2, $3, 'repo-binding-test-connection', $4, 'rest_api', 'active', $5)
	`, connectionID, h.workspaceID, applicationID, "repo-binding-test-"+mustNewUUID(h.t), enabled)
	require.NoError(h.t, err)
	h.connectionIDs = append(h.connectionIDs, connectionID)
	return connectionID
}

func (h *repoBindingTestHarness) bindingCount() int {
	h.t.Helper()
	var count int
	if err := h.pool.QueryRow(context.Background(), `select count(*) from verrail_github_repo_bindings where workspace_id=$1`, h.workspaceID).Scan(&count); err != nil {
		h.t.Fatalf("count repo bindings: %v", err)
	}
	return count
}

func (h *repoBindingTestHarness) cleanup(pool *pgxpool.Pool) {
	ctx := context.Background()
	cleanups := []func(){
		func() {
			_, _ = pool.Exec(ctx, `delete from instance_user_roles where user_id=$1`, h.instanceAdminID)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_command_receipts where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.nonOwnerID, h.nonOwnerKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_audit_events where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.nonOwnerID, h.nonOwnerKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_command_receipts where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.instanceAdminID, h.instanceAdminKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_audit_events where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.instanceAdminID, h.instanceAdminKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from company_memberships where company_id=$1 and principal_id=$2`, h.workspaceID, h.nonOwnerID)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from company_memberships where company_id=$1 and principal_id=$2`, h.workspaceID, h.instanceAdminID)
		},
	}
	for _, cleanup := range cleanups {
		cleanup()
	}
	h.connectorTestHarness.cleanup(pool)
}

func TestGithubRepoBindingContractsIntegration(t *testing.T) {
	databaseURL := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	require.NoError(t, err)
	defer pool.Close()

	harness := newRepoBindingTestHarness(t, pool)
	defer harness.cleanup(pool)

	connectionID := harness.provisionConnection(true)
	happyInput := CreateGithubRepoBindingInput{ConnectionID: connectionID, RepoOwner: "verrail", RepoName: "verrail"}

	t.Run("happy path creates the binding with receipt and audit event", func(t *testing.T) {
		command := buildRepoBindingCommandAs(harness, harness.principalID, happyInput)
		result, err := harness.store.CreateGithubRepoBinding(ctx, command)
		require.NoError(t, err)
		require.False(t, result.Replayed)
		require.Equal(t, "repo_binding", result.ResourceType)

		var connectionRef, repoOwner, repoName, createdByType, createdByID string
		require.NoError(t, pool.QueryRow(ctx, `
			select connection_id, repo_owner, repo_name, created_by_principal_type, created_by_principal_id
			from verrail_github_repo_bindings where id=$1
		`, result.ResourceID).Scan(&connectionRef, &repoOwner, &repoName, &createdByType, &createdByID))
		require.Equal(t, happyInput.ConnectionID, connectionRef)
		require.Equal(t, happyInput.RepoOwner, repoOwner)
		require.Equal(t, happyInput.RepoName, repoName)
		require.Equal(t, "user", createdByType)
		require.Equal(t, harness.principalID, createdByID)

		var eventType, aggregateType, aggregateID string
		require.NoError(t, pool.QueryRow(ctx, `
			select event_type, aggregate_type, aggregate_id from verrail_audit_events
			where workspace_id=$1 and principal_id=$2 and idempotency_key=$3
		`, harness.workspaceID, harness.principalID, command.IdempotencyKey).Scan(&eventType, &aggregateType, &aggregateID))
		require.Equal(t, "connector.repo_binding_created.v1", eventType)
		require.Equal(t, "repo_binding", aggregateType)
		require.Equal(t, result.ResourceID, aggregateID)
	})

	t.Run("identical repeat replays the existing binding", func(t *testing.T) {
		result, err := harness.createBindingAs(harness.principalID, happyInput)
		require.NoError(t, err)
		require.True(t, result.Replayed)
		require.Equal(t, "repo_binding", result.ResourceType)

		var storedID string
		require.NoError(t, pool.QueryRow(ctx, `select id from verrail_github_repo_bindings where workspace_id=$1`, harness.workspaceID).Scan(&storedID))
		require.Equal(t, storedID, result.ResourceID)
		require.Equal(t, 1, harness.bindingCount())
	})

	t.Run("different binding content conflicts", func(t *testing.T) {
		conflicting := happyInput
		conflicting.RepoName = "other-repo"
		_, err := harness.createBindingAs(harness.principalID, conflicting)
		requireLifecycleCode(t, err, "CONNECTOR_BINDING_CONFLICT")
		require.Equal(t, 409, AsError(err).Status)
		require.Equal(t, 1, harness.bindingCount(), "a conflicting command must not add a binding")

		var repoOwner, repoName string
		require.NoError(t, pool.QueryRow(ctx, `select repo_owner, repo_name from verrail_github_repo_bindings where workspace_id=$1`, harness.workspaceID).Scan(&repoOwner, &repoName))
		require.Equal(t, happyInput.RepoOwner, repoOwner, "the existing binding must stay untouched")
		require.Equal(t, happyInput.RepoName, repoName)
	})

	t.Run("instance admin passes the authority gate", func(t *testing.T) {
		// A plain active member whose instance_user_roles row marks them as
		// instance admin: the same content must replay (not 403), proving the
		// admin bypass reached the dedup comparison.
		result, err := harness.createBindingAs(harness.instanceAdminID, happyInput)
		require.NoError(t, err)
		require.True(t, result.Replayed)
		require.Equal(t, "repo_binding", result.ResourceType)
	})

	t.Run("active member without the owner role is rejected", func(t *testing.T) {
		_, err := harness.createBindingAs(harness.nonOwnerID, happyInput)
		requireLifecycleCode(t, err, "REPO_BINDING_NOT_OWNER")
		require.Equal(t, 403, AsError(err).Status)
		require.Equal(t, 1, harness.bindingCount())
	})

	t.Run("principal without membership is rejected by the first gate", func(t *testing.T) {
		_, err := harness.createBindingAs(harness.noMemberID, happyInput)
		requireLifecycleCode(t, err, "TARGET_CREATE_FORBIDDEN")
		require.Equal(t, 403, AsError(err).Status)
		require.Equal(t, 1, harness.bindingCount())
	})

	t.Run("unknown connection is not found and disabled connection is rejected", func(t *testing.T) {
		_, err := harness.createBindingAs(harness.principalID, CreateGithubRepoBindingInput{ConnectionID: mustNewUUID(t), RepoOwner: "verrail", RepoName: "verrail"})
		requireLifecycleCode(t, err, "CONNECTOR_RESOURCE_NOT_FOUND")
		require.Equal(t, 404, AsError(err).Status)

		disabledID := harness.provisionConnection(false)
		_, err = harness.createBindingAs(harness.principalID, CreateGithubRepoBindingInput{ConnectionID: disabledID, RepoOwner: "verrail", RepoName: "verrail"})
		requireLifecycleCode(t, err, "CONNECTOR_CONNECTION_DISABLED")
		require.Equal(t, 409, AsError(err).Status)
		require.Equal(t, 1, harness.bindingCount(), "connection validation runs before dedup so a disabled connection is surfaced even on a repeat")
	})

	// The provisioned binding must satisfy the connector ExecuteAction gate:
	// with a real (credential-less) GitHub client the execution proceeds past
	// CONNECTOR_NOT_BOUND and stops at the credential error instead.
	targetID, _, submissionID := harness.createAcceptedSubmission("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	params := PullRequestParams{Title: "Bound PR", Head: "feat/bound", Base: "main"}
	request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: targetID, SubmissionID: submissionID, Params: params})
	require.NoError(t, err)
	var storedParamsHash string
	require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))
	_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
	require.NoError(t, err)

	t.Run("ExecuteAction proceeds past the binding gate to the credential error", func(t *testing.T) {
		// harness.store keeps the real GitHub REST client with no credential,
		// so a satisfied binding gate surfaces as CONNECTOR_CREDENTIALS_NOT_CONFIGURED.
		_, err := harness.store.ExecuteAction(ctx, buildConnectorCommandAs(harness.connectorTestHarness, harness.principalID, ConnectorActionExecuteCommand, ExecuteActionInput{ActionRequestID: request.ResourceID}))
		requireLifecycleCode(t, err, "CONNECTOR_CREDENTIALS_NOT_CONFIGURED")
		require.Equal(t, 502, AsError(err).Status)
		require.Equal(t, "approved", harness.actionStatus(request.ResourceID), "the credential failure must leave the action approved")
		var receiptCount int
		require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_effect_receipts where action_request_id=$1`, request.ResourceID).Scan(&receiptCount))
		require.Equal(t, 0, receiptCount)
	})
}
