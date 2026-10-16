package orchestration

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/verrail/verrail/services/domain-api/internal/target"
)

// The TypeScript integration suite overlays this file into the Go package and
// supplies only its own disposable PostgreSQL fixture and graph identities.
func TestRepositorySchedulingAdmissionBridge(t *testing.T) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("VERRAIL_TEST_DATABASE_URL"))
	require.NoError(t, err)
	defer pool.Close()
	var input ReconcileTargetActivityInput
	require.NoError(t, json.Unmarshal([]byte(os.Getenv("VERRAIL_TEST_REPOSITORY_GRAPH")), &input))
	activities := NewDomainActivities(target.NewStore(pool), DomainActivitiesConfig{
		RuntimeProfile: "repository_sandbox", ExecutorPrincipalID: "verrail-repository-runner",
		LeaseDuration: 120 * time.Second, GraceDuration: 30 * time.Second,
	})
	result, err := activities.ReconcileTarget(ctx, input)
	require.NoError(t, err)
	require.Empty(t, result.ScheduledRuns, "repository scheduling cannot invent a source selection")
	runID := os.Getenv("VERRAIL_TEST_REPOSITORY_RUN")
	if runID == "" {
		require.Len(t, result.WaitingTaskNodeIDs, 1)
		require.Empty(t, result.ActiveRunIDs)
		var runCount int
		require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_runs where workspace_id=$1 and graph_revision_id=$2`, input.WorkspaceID, input.GraphRevisionID).Scan(&runCount))
		require.Zero(t, runCount)
		var nodeStatus string
		require.NoError(t, pool.QueryRow(ctx, `select status from verrail_work_nodes where id=$1`, result.WaitingTaskNodeIDs[0]).Scan(&nodeStatus))
		require.Equal(t, "ready", nodeStatus)
	} else {
		require.Empty(t, result.WaitingTaskNodeIDs)
		require.Equal(t, []string{runID}, result.ActiveRunIDs)
		var sourceID string
		require.NoError(t, pool.QueryRow(ctx, `select repository_source_revision_id from verrail_run_sources where run_id=$1`, runID).Scan(&sourceID))
		require.NotEmpty(t, sourceID)
		attempt, err := activities.EnsureRunAttempt(ctx, EnsureRunAttemptActivityInput{
			SchemaVersion: SchemaVersion, WorkspaceID: input.WorkspaceID, RunID: runID, AttemptOrdinal: 1, MaxAttempts: 3,
		})
		require.NoError(t, err)
		require.NotEmpty(t, attempt.RunAttemptID)
	}
}
