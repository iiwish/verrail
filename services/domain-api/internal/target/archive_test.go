package target

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestManageTargetArchiveValidation(t *testing.T) {
	version := 0
	command := ManageTargetCommand{WorkspaceID: "00000000-0000-4000-8000-000000000001", TargetID: "00000000-0000-4000-8000-000000000002", Principal: Principal{Type: "user", ID: "owner"}, IdempotencyKey: "archive-validation", Input: ManageTargetInput{Operation: "archive", ExpectedTargetRevisionID: "00000000-0000-4000-8000-000000000003", ExpectedArchiveVersion: &version}}
	require.NoError(t, ValidateManageTargetCommand(&command))
	command.Input.ExpectedArchiveVersion = nil
	require.Error(t, ValidateManageTargetCommand(&command))
	version = -1
	command.Input.ExpectedArchiveVersion = &version
	require.Error(t, ValidateManageTargetCommand(&command))
}

func TestManageTargetArchiveIntegration(t *testing.T) {
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
	for _, state := range []string{"active", "accepted", "canceled"} {
		t.Run(state, func(t *testing.T) {
			targetID, revisionID := h.createTarget()
			completion := "Verify archive preserves execution"
			graph := CreateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: Principal{Type: "user", ID: h.principalID}, IdempotencyKey: "archive-graph-" + state, Input: CreateGraphRevisionInput{ExpectedTargetRevisionID: revisionID, Nodes: []WorkNodeInput{{NodeKey: "check", Kind: "integration_task", Stage: "verify", Title: "Check", CompletionDefinition: &completion}}}}
			require.NoError(t, ValidateCreateGraphRevisionCommand(&graph))
			created, err := h.store.CreateGraphRevision(ctx, graph)
			require.NoError(t, err)
			activation := ActivateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, GraphRevisionID: created.GraphRevisionID, Principal: graph.Principal, IdempotencyKey: "archive-activate-" + state}
			require.NoError(t, ValidateActivationCommand(&activation))
			_, err = h.store.ActivateGraphRevision(ctx, activation)
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `update verrail_targets set status=$1 where id=$2`, state, targetID)
			require.NoError(t, err)
			if state == "active" {
				runID := mustNewUUID(t)
				_, err = pool.Exec(ctx, `insert into verrail_runs(id,workspace_id,target_id,target_revision_id,graph_revision_id,work_node_id,kind,status,actor_principal_type,actor_principal_id,idempotency_key) select $1,$2,$3,$4,$5,id,'integration','running','user',$6,$7 from verrail_work_nodes where graph_revision_id=$5 limit 1`, runID, h.workspaceID, targetID, revisionID, created.GraphRevisionID, h.principalID, "archive-fixture-run")
				require.NoError(t, err)
				defer func() { _, _ = pool.Exec(ctx, `delete from verrail_runs where id=$1`, runID) }()
			}
			snapshot := func() string {
				var raw []byte
				require.NoError(t, pool.QueryRow(ctx, `select jsonb_build_object('status',t.status,'revision',to_jsonb(r),'graph',to_jsonb(g),'runs',(select jsonb_agg(to_jsonb(run)) from verrail_runs run where run.target_id=t.id)) from verrail_targets t join verrail_target_revisions r on r.id=t.active_target_revision_id join verrail_work_graphs g on g.target_id=t.id where t.id=$1`, targetID).Scan(&raw))
				return string(raw)
			}
			before := snapshot()
			version := 0
			command := ManageTargetCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: graph.Principal, IdempotencyKey: "archive-" + state, Input: ManageTargetInput{Operation: "archive", ExpectedTargetRevisionID: revisionID, ExpectedArchiveVersion: &version}}
			result, err := h.store.ManageTarget(ctx, command)
			require.NoError(t, err)
			require.NotNil(t, result.ArchivedAt)
			require.Equal(t, 1, *result.ArchiveVersion)
			require.Equal(t, revisionID, result.TargetRevisionID)
			require.JSONEq(t, before, snapshot())
			replay, err := h.store.ManageTarget(ctx, command)
			require.NoError(t, err)
			require.True(t, replay.Replayed)
			restore := command
			restore.IdempotencyKey = "restore-" + state
			restore.Input.Operation = "restore"
			restore.Input.ExpectedArchiveVersion = result.ArchiveVersion
			restored, err := h.store.ManageTarget(ctx, restore)
			require.NoError(t, err)
			require.Nil(t, restored.ArchivedAt)
			require.Equal(t, 2, *restored.ArchiveVersion)
			require.JSONEq(t, before, snapshot())
			command.IdempotencyKey = "stale-archive-" + state
			_, err = h.store.ManageTarget(ctx, command)
			requireLifecycleCode(t, err, "TARGET_ARCHIVE_CONFLICT")
		})
	}
}
