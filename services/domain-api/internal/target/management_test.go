package target

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestManageTargetValidation(t *testing.T) {
	title := "Updated"
	command := ManageTargetCommand{WorkspaceID: "00000000-0000-4000-8000-000000000001", TargetID: "00000000-0000-4000-8000-000000000002", Principal: Principal{Type: "user", ID: "owner"}, IdempotencyKey: "management-test", Input: ManageTargetInput{Operation: "update", ExpectedTargetRevisionID: "00000000-0000-4000-8000-000000000003", Title: &title}}
	require.NoError(t, ValidateManageTargetCommand(&command))
	require.NotEmpty(t, command.RequestHash)
	command.Input.Operation = "cancel"
	require.Error(t, ValidateManageTargetCommand(&command))
	command.Input.Title = nil
	require.NoError(t, ValidateManageTargetCommand(&command))
	command.Principal.Type = "agent"
	require.Error(t, ValidateManageTargetCommand(&command))
}

func TestManageTargetIntegration(t *testing.T) {
	url := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	defer pool.Close()
	h := newConnectorTestHarness(t, pool)
	defer h.cleanup(pool)
	targetID, revisionID := h.createTarget()
	var originalTitle, originalHash string
	require.NoError(t, pool.QueryRow(ctx, `select title,content_hash from verrail_target_revisions where id=$1`, revisionID).Scan(&originalTitle, &originalHash))
	title := "Director revised title"
	command := ManageTargetCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: Principal{Type: "user", ID: h.principalID}, IdempotencyKey: "director-update", Input: ManageTargetInput{Operation: "update", ExpectedTargetRevisionID: revisionID, Title: &title}}
	result, err := h.store.ManageTarget(ctx, command)
	require.NoError(t, err)
	require.NotEqual(t, revisionID, result.TargetRevisionID)
	replay, err := h.store.ManageTarget(ctx, command)
	require.NoError(t, err)
	require.True(t, replay.Replayed)
	require.Equal(t, result.TargetRevisionID, replay.TargetRevisionID)
	var preservedTitle, preservedHash, newTitle string
	require.NoError(t, pool.QueryRow(ctx, `select title,content_hash from verrail_target_revisions where id=$1`, revisionID).Scan(&preservedTitle, &preservedHash))
	require.Equal(t, originalTitle, preservedTitle)
	require.Equal(t, originalHash, preservedHash)
	require.NoError(t, pool.QueryRow(ctx, `select title from verrail_target_revisions where id=$1`, result.TargetRevisionID).Scan(&newTitle))
	require.Equal(t, title, newTitle)
	command.IdempotencyKey = "stale-update"
	_, err = h.store.ManageTarget(ctx, command)
	requireLifecycleCode(t, err, "TARGET_REVISION_CONFLICT")
	command.IdempotencyKey = "director-update"
	otherTitle := "different payload"
	command.Input.Title = &otherTitle
	_, err = h.store.ManageTarget(ctx, command)
	require.Error(t, err)
	command.Input = ManageTargetInput{Operation: "cancel", ExpectedTargetRevisionID: result.TargetRevisionID}
	command.IdempotencyKey = "director-cancel"
	_, err = h.store.ManageTarget(ctx, command)
	require.NoError(t, err)
	var status string
	require.NoError(t, pool.QueryRow(ctx, `select status from verrail_targets where id=$1`, targetID).Scan(&status))
	require.Equal(t, "canceled", status)
	replay, err = h.store.ManageTarget(ctx, command)
	require.NoError(t, err)
	require.True(t, replay.Replayed)
	command.IdempotencyKey = "cannot-revise-canceled"
	command.Input.Operation = "update"
	command.Input.Title = &title
	_, err = h.store.ManageTarget(ctx, command)
	requireLifecycleCode(t, err, "TARGET_MANAGEMENT_REQUIRES_DRAFT")

	// Cancellation cannot be bypassed by activating an already-created draft graph.
	var graphID string
	require.NoError(t, pool.QueryRow(ctx, `select id from verrail_graph_revisions where target_id=$1 order by revision_number desc limit 1`, targetID).Scan(&graphID))
	activate := ActivateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, GraphRevisionID: graphID, Principal: command.Principal, IdempotencyKey: "cancel-activation"}
	require.NoError(t, ValidateActivationCommand(&activate))
	_, err = h.store.ActivateGraphRevision(ctx, activate)
	// Its graph is bound to the superseded definition; it cannot become active.
	require.Error(t, err)

	otherTarget, otherRevision := h.createTarget()
	command.TargetID = otherTarget
	command.Input = ManageTargetInput{Operation: "cancel", ExpectedTargetRevisionID: otherRevision}
	command.IdempotencyKey = "active-graph-refused"
	require.NoError(t, pool.QueryRow(ctx, `select id from verrail_graph_revisions where target_id=$1 limit 1`, otherTarget).Scan(&graphID))
	activate.TargetID, activate.GraphRevisionID, activate.IdempotencyKey = otherTarget, graphID, "activate-management-fixture"
	require.NoError(t, ValidateActivationCommand(&activate))
	_, err = h.store.ActivateGraphRevision(ctx, activate)
	require.NoError(t, err)
	_, err = h.store.ManageTarget(ctx, command)
	requireLifecycleCode(t, err, "TARGET_MANAGEMENT_REQUIRES_DRAFT")

	cancelTarget, cancelRevision := h.createTarget()
	cancelCommand := ManageTargetCommand{WorkspaceID: h.workspaceID, TargetID: cancelTarget, Principal: command.Principal, IdempotencyKey: "cancel-before-activation", Input: ManageTargetInput{Operation: "cancel", ExpectedTargetRevisionID: cancelRevision}}
	_, err = h.store.ManageTarget(ctx, cancelCommand)
	require.NoError(t, err)
	var canceledGraphID string
	require.NoError(t, pool.QueryRow(ctx, `select id from verrail_graph_revisions where target_id=$1 limit 1`, cancelTarget).Scan(&canceledGraphID))
	canceledActivation := ActivateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: cancelTarget, GraphRevisionID: canceledGraphID, Principal: command.Principal, IdempotencyKey: "reject-canceled-activation"}
	require.NoError(t, ValidateActivationCommand(&canceledActivation))
	_, err = h.store.ActivateGraphRevision(ctx, canceledActivation)
	requireLifecycleCode(t, err, "TARGET_CANCELED")
	_, err = h.store.CreateGraphRevision(ctx, CreateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: cancelTarget, Principal: command.Principal, IdempotencyKey: "reject-canceled-graph", Input: CreateGraphRevisionInput{ExpectedTargetRevisionID: cancelRevision}})
	requireLifecycleCode(t, err, "TARGET_CANCELED")

	command.Principal.ID = "not-a-member"
	_, err = h.store.ManageTarget(ctx, command)
	require.Error(t, err)
	command.Principal.ID = h.principalID
	_, err = pool.Exec(ctx, `update company_memberships set membership_role='viewer' where company_id=$1 and principal_id=$2`, h.workspaceID, h.principalID)
	require.NoError(t, err)
	_, err = h.store.ManageTarget(ctx, command)
	require.Error(t, err)
}
