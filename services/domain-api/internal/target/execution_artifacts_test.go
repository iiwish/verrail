package target

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestRunArtifactInput(t *testing.T) {
	workspaceID := mustNewUUID(t)
	artifact := RunArtifactInput{Title: "Candidate", Kind: "report", ContentHash: strings.Repeat("a", 64), ContentRef: "storage:" + workspaceID + "/verrail/run-artifacts/sha256/" + strings.Repeat("a", 64)}
	build := func() ReportRunEventCommand {
		return ReportRunEventCommand{
			WorkspaceID: workspaceID, RunID: mustNewUUID(t), RunAttemptID: mustNewUUID(t), Principal: Principal{Type: "service", ID: "runner"}, IdempotencyKey: "artifact-validation",
			Input: ReportRunEventInput{LeaseID: mustNewUUID(t), FencingToken: 1, Cursor: 1, EventType: "succeeded", EmittedAt: time.Now().UTC(), Artifacts: []RunArtifactInput{artifact}},
		}
	}
	valid := build()
	require.NoError(t, ValidateReportRunEventCommand(&valid))
	for name, mutate := range map[string]func(*ReportRunEventCommand){
		"nonterminal":     func(c *ReportRunEventCommand) { c.Input.EventType = "progress" },
		"human":           func(c *ReportRunEventCommand) { c.Principal.Type = "user" },
		"cross-workspace": func(c *ReportRunEventCommand) { c.WorkspaceID = mustNewUUID(t) },
		"hash-mismatch":   func(c *ReportRunEventCommand) { c.Input.Artifacts[0].ContentHash = strings.Repeat("b", 64) },
		"external-url":    func(c *ReportRunEventCommand) { c.Input.Artifacts[0].ContentRef = "https://example.com/file" },
		"unknown-kind":    func(c *ReportRunEventCommand) { c.Input.Artifacts[0].Kind = "external_reference" },
		"blank-title":     func(c *ReportRunEventCommand) { c.Input.Artifacts[0].Title = " " },
		"too-many":        func(c *ReportRunEventCommand) { c.Input.Artifacts = make([]RunArtifactInput, 11) },
	} {
		t.Run(name, func(t *testing.T) { c := build(); mutate(&c); require.Error(t, ValidateReportRunEventCommand(&c)) })
	}
}

func verifyNativeArtifactCompletion(t *testing.T, store *Store, pool *pgxpool.Pool, workspaceID, runID, targetID, workNodeID string, staleAttempt, attempt CreateRunAttemptResult) {
	t.Helper()
	ctx := context.Background()
	hash := strings.Repeat("c", 64)
	command := ReportRunEventCommand{WorkspaceID: workspaceID, RunID: runID, RunAttemptID: attempt.RunAttemptID, Principal: Principal{Type: "service", ID: "verrail-host-runner"}, IdempotencyKey: "native-artifact-success", Input: ReportRunEventInput{LeaseID: attempt.LeaseID, FencingToken: attempt.FencingToken, Cursor: 3, EventType: "succeeded", EmittedAt: time.Now().UTC(), Artifacts: []RunArtifactInput{{Title: "Native candidate", Kind: "code_change", ContentHash: hash, ContentRef: "storage:" + workspaceID + "/verrail/run-artifacts/sha256/" + hash}}}}
	count := func() int {
		var count int
		require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_artifact_revisions where workspace_id=$1`, workspaceID).Scan(&count))
		return count
	}
	stale := command
	stale.RunAttemptID = staleAttempt.RunAttemptID
	stale.IdempotencyKey = "native-artifact-stale"
	stale.Input.LeaseID, stale.Input.FencingToken = staleAttempt.LeaseID, staleAttempt.FencingToken
	require.NoError(t, ValidateReportRunEventCommand(&stale))
	result, err := store.ReportRunEvent(ctx, stale)
	require.NoError(t, err)
	require.False(t, result.Authoritative)
	require.Equal(t, "STALE_FENCING_TOKEN", *result.RejectionCode)
	require.Zero(t, count())
	foreign := command
	foreign.Principal.ID = "another-executor"
	foreign.IdempotencyKey = "native-artifact-foreign"
	require.NoError(t, ValidateReportRunEventCommand(&foreign))
	_, err = store.ReportRunEvent(ctx, foreign)
	require.Error(t, err)
	require.Zero(t, count())
	require.NoError(t, ValidateReportRunEventCommand(&command))
	result, err = store.ReportRunEvent(ctx, command)
	require.NoError(t, err)
	require.True(t, result.Authoritative)
	require.Equal(t, "succeeded", result.RunStatus)
	require.Equal(t, 1, count())
	result, err = store.ReportRunEvent(ctx, command)
	require.NoError(t, err)
	require.True(t, result.Replayed)
	require.Equal(t, 1, count())
	command.IdempotencyKey = "native-artifact-cursor-replay"
	result, err = store.ReportRunEvent(ctx, command)
	require.NoError(t, err)
	require.True(t, result.Replayed)
	require.Equal(t, 1, count())
	var sourceRun, sourceNode, actualTarget, actorType, actorID, contentHash string
	require.NoError(t, pool.QueryRow(ctx, `select revision.source_run_id,revision.source_work_node_id,artifact.target_id,revision.created_by_principal_type,revision.created_by_principal_id,revision.content_hash from verrail_artifact_revisions revision join verrail_artifacts artifact on artifact.id=revision.artifact_id where revision.workspace_id=$1`, workspaceID).Scan(&sourceRun, &sourceNode, &actualTarget, &actorType, &actorID, &contentHash))
	require.Equal(t, runID, sourceRun)
	require.Equal(t, workNodeID, sourceNode)
	require.Equal(t, targetID, actualTarget)
	require.Equal(t, "service", actorType)
	require.Equal(t, "verrail-host-runner", actorID)
	require.Equal(t, hash, contentHash)
	var audits int
	require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_audit_events where workspace_id=$1 and event_type in ('assurance.artifact_created.v1','assurance.artifact_revision_added.v1') and principal_type='service' and principal_id='verrail-host-runner' and payload->>'runAttemptId'=$2`, workspaceID, attempt.RunAttemptID).Scan(&audits))
	require.Equal(t, 2, audits)
}
