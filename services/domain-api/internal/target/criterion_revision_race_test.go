package target

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestTargetRevisionCreateRunRaceIntegration(t *testing.T) {
	url := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	defer pool.Close()
	h := newConnectorTestHarness(t, pool)
	defer h.cleanup(pool)
	lifecycle := &lifecycleTestHarness{t: t, store: h.store, workspaceID: h.workspaceID, principalID: h.principalID}
	definition := lifecycle.createDefinition()
	version := lifecycle.publishVersion(definition, "revision race")
	deployment := lifecycle.createDeployment(definition, version, lifecycle.recordPassingEvaluation(version), "revision-race")
	deploymentRevision := lifecycle.firstRevisionID(deployment)
	targetID, revisionID := h.createTarget()
	var criterionID string
	require.NoError(t, pool.QueryRow(ctx, `select acceptance_criteria->0->>'id' from verrail_target_revisions where id=$1`, revisionID).Scan(&criterionID))
	completion := "Record version-bound output"
	graph := CreateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: Principal{Type: "user", ID: h.principalID}, IdempotencyKey: "race-graph", Input: CreateGraphRevisionInput{ExpectedTargetRevisionID: revisionID, Nodes: []WorkNodeInput{{NodeKey: "work", Kind: "agent_task", Stage: "execute", Title: "Work", CompletionDefinition: &completion, ResponsiblePrincipal: &ResponsiblePrincipal{PrincipalType: "agent", PrincipalID: deploymentRevision}}}}}
	require.NoError(t, ValidateCreateGraphRevisionCommand(&graph))
	created, err := h.store.CreateGraphRevision(ctx, graph)
	require.NoError(t, err)
	activate := ActivateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, GraphRevisionID: created.GraphRevisionID, Principal: graph.Principal, IdempotencyKey: "race-activate"}
	require.NoError(t, ValidateActivationCommand(&activate))
	_, err = h.store.ActivateGraphRevision(ctx, activate)
	require.NoError(t, err)
	nodeID := workNodeIDByKey(t, pool, created.GraphRevisionID, "work")
	revision := ReviseTargetProofCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: graph.Principal, IdempotencyKey: "race-revise", Input: ReviseTargetProofInput{ExpectedTargetRevisionID: revisionID, Criteria: []CriterionProofChange{{CriterionID: criterionID, ProofContract: CriterionProofContract{SchemaVersion: 1, AllOf: []CriterionProofRequirement{{ID: "technical", Kind: "independent_verification", Phase: "pre_acceptance", Assertions: []string{"CI"}}}}}}}}
	require.NoError(t, ValidateReviseTargetProofCommand(&revision))
	run := buildGraphRunCommand(t, h.workspaceID, targetID, created.GraphRevisionID, nodeID, deploymentRevision, Principal{Type: "service", ID: "orchestration"}, "race-create-run")
	newPool := func(name string) *pgxpool.Pool {
		config, err := pgxpool.ParseConfig(url)
		require.NoError(t, err)
		config.MaxConns = 1
		config.ConnConfig.RuntimeParams["application_name"] = name
		p, err := pgxpool.NewWithConfig(ctx, config)
		require.NoError(t, err)
		t.Cleanup(p.Close)
		return p
	}
	runPool := newPool("t037-race-run")
	revisionPool := newPool("t037-race-revise")
	barrier, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = barrier.Rollback(ctx) }()
	_, err = barrier.Exec(ctx, `select id from verrail_work_graphs where target_id=$1 for update`, targetID)
	require.NoError(t, err)
	_, err = barrier.Exec(ctx, `select id from verrail_work_nodes where id=$1 for update`, nodeID)
	require.NoError(t, err)
	runDone := make(chan error, 1)
	revisionDone := make(chan error, 1)
	go func() { _, err := NewStore(runPool).CreateRun(ctx, run); runDone <- err }()
	go func() { _, err := NewStore(revisionPool).ReviseTargetProof(ctx, revision); revisionDone <- err }()
	require.Eventually(t, func() bool {
		var count int
		err := pool.QueryRow(ctx, `select count(*) from pg_stat_activity where application_name in ('t037-race-run','t037-race-revise') and wait_event_type='Lock'`).Scan(&count)
		return err == nil && count == 2
	}, 5*time.Second, 10*time.Millisecond, "both independent domain transactions reached the barrier")
	require.NoError(t, barrier.Commit(ctx))
	runErr, revisionErr := <-runDone, <-revisionDone
	require.False(t, runErr == nil && revisionErr == nil, "a new revision and an old-version active Run cannot both commit")
	for _, err := range []error{runErr, revisionErr} {
		if err == nil {
			continue
		}
		var pgError *pgconn.PgError
		var domainError *Error
		require.True(t, errors.As(err, &pgError) && pgError.Code == "40001" || errors.As(err, &domainError) && (domainError.Status == 409 || domainError.Status == 404), "expected conflict or serialization retry: %v", err)
	}
	if runErr == nil {
		revision.IdempotencyKey = "race-sequential-guard"
		require.NoError(t, ValidateReviseTargetProofCommand(&revision))
		_, err = h.store.ReviseTargetProof(ctx, revision)
		requireLifecycleCode(t, err, "TARGET_EXECUTION_UNSETTLED")
	}
	var activeRevision string
	require.NoError(t, pool.QueryRow(ctx, `select active_target_revision_id from verrail_targets where id=$1`, targetID).Scan(&activeRevision))
	var staleRuns int
	require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_runs where target_id=$1 and target_revision_id<>$2 and status in ('queued','running','cancel_requested')`, targetID, activeRevision).Scan(&staleRuns))
	require.Zero(t, staleRuns)
}
