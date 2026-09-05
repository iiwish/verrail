package target

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestGraphOrchestrationContractsIntegration(t *testing.T) {
	databaseURL := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	require.NoError(t, err)
	defer pool.Close()

	workspaceID := mustNewUUID(t)
	principalID := "g2-7-graph-test-user"
	_, err = pool.Exec(ctx, `insert into companies(id,name,issue_prefix,status) values($1,'G2.7 Graph Test',$2,'active')`, workspaceID, "G27"+workspaceID[:5])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `insert into company_memberships(company_id,principal_type,principal_id,status,membership_role) values($1,'user',$2,'active','member')`, workspaceID, principalID)
	require.NoError(t, err)

	store := NewStore(pool)
	lifecycle := &lifecycleTestHarness{t: t, store: store, workspaceID: workspaceID, principalID: principalID}
	defer cleanupGraphOrchestrationHarness(pool, lifecycle)
	definitionID := lifecycle.createDefinition()
	versionID := lifecycle.publishVersion(definitionID, "version-bound orchestration integration prompt")
	evaluationID := lifecycle.recordPassingEvaluation(versionID)
	deploymentID := lifecycle.createDeployment(definitionID, versionID, evaluationID, "g2-7-graph-deployment")
	deploymentRevisionID := lifecycle.firstRevisionID(deploymentID)

	targetCommand := CreateCommand{
		WorkspaceID:    workspaceID,
		Principal:      Principal{Type: "user", ID: principalID},
		IdempotencyKey: "g2-7-target-create",
		Input: CreateInput{
			Title:        "Orchestration target",
			Goal:         "Prove dependency activation and recoverable Agent Runs",
			OutcomeOwner: OutcomeOwner{PrincipalType: "user", PrincipalID: principalID},
			AcceptanceCriteria: []AcceptanceCriterionInput{{
				Title: "The dependent node activates after its prerequisite completes",
			}},
			RiskLevel: "high",
		},
	}
	require.NoError(t, ValidateCommand(&targetCommand))
	targetResult, err := store.Create(ctx, targetCommand)
	require.NoError(t, err)

	completion := "persist a terminal result"
	graphCommand := CreateGraphRevisionCommand{
		WorkspaceID:    workspaceID,
		TargetID:       targetResult.TargetID,
		Principal:      Principal{Type: "user", ID: principalID},
		IdempotencyKey: "g2-7-graph-create",
		Input: CreateGraphRevisionInput{
			ExpectedTargetRevisionID: targetResult.TargetRevisionID,
			Nodes: []WorkNodeInput{
				{
					NodeKey: "service-agent", Kind: "agent_task", Stage: "execute", Title: "Service scheduled Agent",
					ResponsiblePrincipal: &ResponsiblePrincipal{PrincipalType: "agent", PrincipalID: deploymentRevisionID},
					CompletionDefinition: &completion,
				},
				{
					NodeKey: "human-agent", Kind: "agent_task", Stage: "execute", Title: "Human scheduled Agent",
					ResponsiblePrincipal: &ResponsiblePrincipal{PrincipalType: "agent", PrincipalID: deploymentRevisionID},
					CompletionDefinition: &completion,
				},
				{
					NodeKey: "dependent-human", Kind: "human_task", Stage: "verify", Title: "Dependent human verification",
					DependencyNodeKeys: []string{"service-agent"}, CompletionDefinition: &completion,
				},
			},
		},
	}
	require.NoError(t, ValidateCreateGraphRevisionCommand(&graphCommand))
	graphResult, err := store.CreateGraphRevision(ctx, graphCommand)
	require.NoError(t, err)
	activation := ActivateGraphRevisionCommand{
		WorkspaceID: workspaceID, TargetID: targetResult.TargetID, GraphRevisionID: graphResult.GraphRevisionID,
		Principal: Principal{Type: "user", ID: principalID}, IdempotencyKey: "g2-7-graph-activate",
	}
	require.NoError(t, ValidateActivationCommand(&activation))
	_, err = store.ActivateGraphRevision(ctx, activation)
	require.NoError(t, err)

	servicePrincipal := Principal{Type: "service", ID: "verrail-orchestration-worker"}
	firstReconcile := ReconcileGraphCommand{
		WorkspaceID: workspaceID, TargetID: targetResult.TargetID, TargetRevisionID: targetResult.TargetRevisionID,
		GraphRevisionID: graphResult.GraphRevisionID, Principal: servicePrincipal, IdempotencyKey: "g2-7-reconcile-cycle-1",
	}
	require.NoError(t, ValidateReconcileGraphCommand(&firstReconcile))
	firstGraphState, err := store.ReconcileGraph(ctx, firstReconcile)
	require.NoError(t, err)
	require.Len(t, firstGraphState.AgentNodes, 2)
	require.Empty(t, firstGraphState.ActivatedNodeIDs, "root nodes are activated by GraphRevision activation")

	serviceNodeID := workNodeIDByKey(t, pool, graphResult.GraphRevisionID, "service-agent")
	humanNodeID := workNodeIDByKey(t, pool, graphResult.GraphRevisionID, "human-agent")
	dependentNodeID := workNodeIDByKey(t, pool, graphResult.GraphRevisionID, "dependent-human")
	serviceRunCommand := buildGraphRunCommand(t, workspaceID, targetResult.TargetID, graphResult.GraphRevisionID, serviceNodeID, deploymentRevisionID, servicePrincipal, "g2-7-service-run")
	serviceRun, err := store.CreateRun(ctx, serviceRunCommand)
	require.NoError(t, err)
	replayedRun, err := store.CreateRun(ctx, serviceRunCommand)
	require.NoError(t, err)
	require.True(t, replayedRun.Replayed)
	require.Equal(t, serviceRun.RunID, replayedRun.RunID)

	humanRunCommand := buildGraphRunCommand(t, workspaceID, targetResult.TargetID, graphResult.GraphRevisionID, humanNodeID, deploymentRevisionID, Principal{Type: "user", ID: principalID}, "g2-7-human-run")
	_, err = store.CreateRun(ctx, humanRunCommand)
	require.NoError(t, err, "human board scheduling must remain compatible")

	attemptCommand := buildRunAttemptCommand(t, workspaceID, serviceRun.RunID, servicePrincipal, "g2-7-attempt-1")
	firstAttempt, err := store.CreateRunAttempt(ctx, attemptCommand)
	require.NoError(t, err)
	ensureCurrent := buildRunAttemptCommand(t, workspaceID, serviceRun.RunID, servicePrincipal, "g2-7-attempt-2")
	currentAttempt, err := store.CreateRunAttempt(ctx, ensureCurrent)
	require.NoError(t, err)
	require.True(t, currentAttempt.Replayed)
	require.Equal(t, firstAttempt.RunAttemptID, currentAttempt.RunAttemptID, "a recovery check must reuse a live Attempt")

	humanAttempt := buildRunAttemptCommand(t, workspaceID, serviceRun.RunID, Principal{Type: "user", ID: principalID}, "g2-7-human-attempt")
	_, err = store.CreateRunAttempt(ctx, humanAttempt)
	requireLifecycleCode(t, err, "ACTIVE_RUN_ATTEMPT_EXISTS")

	_, err = pool.Exec(ctx, `update verrail_execution_leases set expires_at=now()-interval '2 minutes',grace_expires_at=now()-interval '1 minute' where id=$1`, firstAttempt.LeaseID)
	require.NoError(t, err)
	exhaustedAttempt := buildRunAttemptCommand(t, workspaceID, serviceRun.RunID, servicePrincipal, "g2-7-attempt-exhausted")
	exhaustedAttempt.Input.MaxAttempts = 1
	require.NoError(t, ValidateCreateRunAttemptCommand(&exhaustedAttempt))
	_, err = store.CreateRunAttempt(ctx, exhaustedAttempt)
	requireLifecycleCode(t, err, "RUN_ATTEMPTS_EXHAUSTED")
	expiredSnapshot, err := store.ObserveRunForRecovery(ctx, workspaceID, serviceRun.RunID, servicePrincipal)
	require.NoError(t, err)
	require.Equal(t, firstAttempt.RunAttemptID, expiredSnapshot.RunAttemptID)
	require.Equal(t, "failed", expiredSnapshot.RunStatus)
	require.Equal(t, "expired", expiredSnapshot.LeaseStatus)
	_, err = store.ObserveRunForRecovery(ctx, workspaceID, serviceRun.RunID, servicePrincipal)
	require.NoError(t, err)
	var expiryAudits int
	require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_audit_events where workspace_id=$1 and event_type='run.lease_expired'`, workspaceID).Scan(&expiryAudits))
	require.Equal(t, 1, expiryAudits)
	recoveredAttempt, err := store.CreateRunAttempt(ctx, ensureCurrent)
	require.NoError(t, err)
	require.False(t, recoveredAttempt.Replayed)
	require.Equal(t, 2, recoveredAttempt.AttemptNumber)
	require.Greater(t, recoveredAttempt.FencingToken, firstAttempt.FencingToken)

	staleEvent := ReportRunEventCommand{
		WorkspaceID: workspaceID, RunID: serviceRun.RunID, RunAttemptID: firstAttempt.RunAttemptID,
		Principal: Principal{Type: "service", ID: "verrail-host-runner"}, IdempotencyKey: "g2-7-stale-event",
		Input: ReportRunEventInput{LeaseID: firstAttempt.LeaseID, FencingToken: firstAttempt.FencingToken, Cursor: 1, EventType: "heartbeat", EmittedAt: time.Now().UTC()},
	}
	require.NoError(t, ValidateReportRunEventCommand(&staleEvent))
	staleResult, err := store.ReportRunEvent(ctx, staleEvent)
	require.NoError(t, err)
	require.Equal(t, "STALE_FENCING_TOKEN", *staleResult.RejectionCode)
	require.False(t, staleResult.Authoritative)

	reportRunEvent(t, store, workspaceID, serviceRun.RunID, recoveredAttempt, 1, "claimed")
	reportRunEvent(t, store, workspaceID, serviceRun.RunID, recoveredAttempt, 2, "started")
	verifyNativeArtifactCompletion(t, store, pool, workspaceID, serviceRun.RunID, targetResult.TargetID, serviceNodeID, firstAttempt, recoveredAttempt)

	secondReconcile := firstReconcile
	secondReconcile.IdempotencyKey = "g2-7-reconcile-cycle-2"
	require.NoError(t, ValidateReconcileGraphCommand(&secondReconcile))
	secondGraphState, err := store.ReconcileGraph(ctx, secondReconcile)
	require.NoError(t, err)
	require.Equal(t, []string{dependentNodeID}, secondGraphState.ActivatedNodeIDs)
	require.Equal(t, []string{dependentNodeID}, secondGraphState.WaitingTaskNodeIDs)
	replayedGraphState, err := store.ReconcileGraph(ctx, secondReconcile)
	require.NoError(t, err)
	require.True(t, replayedGraphState.Replayed)

	thirdReconcile := firstReconcile
	thirdReconcile.IdempotencyKey = "g2-7-reconcile-cycle-3"
	require.NoError(t, ValidateReconcileGraphCommand(&thirdReconcile))
	thirdGraphState, err := store.ReconcileGraph(ctx, thirdReconcile)
	require.NoError(t, err)
	require.Empty(t, thirdGraphState.ActivatedNodeIDs, "a later cycle must not activate the same node again")
	var cycleTwoAuditCount int
	require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_audit_events where workspace_id=$1 and principal_type='service' and principal_id=$2 and idempotency_key=$3`, workspaceID, servicePrincipal.ID, secondReconcile.IdempotencyKey).Scan(&cycleTwoAuditCount))
	require.Equal(t, 1, cycleTwoAuditCount, "replaying a reconciliation must not duplicate audit facts")
	verifyRunOutboxRecovery(t, pool, store, workspaceID, serviceRun.RunID, principalID)
}

func buildGraphRunCommand(t *testing.T, workspaceID, targetID, graphRevisionID, workNodeID, deploymentRevisionID string, principal Principal, key string) CreateRunCommand {
	t.Helper()
	command := CreateRunCommand{
		WorkspaceID: workspaceID, TargetID: targetID, GraphRevisionID: graphRevisionID, WorkNodeID: workNodeID,
		Principal: principal, IdempotencyKey: key,
		Input: CreateRunInput{Kind: "agent_run", Actor: ResponsiblePrincipal{PrincipalType: "agent", PrincipalID: deploymentRevisionID}},
	}
	require.NoError(t, ValidateCreateRunCommand(&command))
	return command
}

func buildRunAttemptCommand(t *testing.T, workspaceID, runID string, principal Principal, key string) CreateRunAttemptCommand {
	t.Helper()
	command := CreateRunAttemptCommand{
		WorkspaceID: workspaceID, RunID: runID, Principal: principal, IdempotencyKey: key,
		Input: CreateRunAttemptInput{
			RuntimeProfile: "host_trusted", Executor: ExecutorPrincipal{PrincipalType: "service", PrincipalID: "verrail-host-runner"},
			LeaseDurationSeconds: 15, GraceDurationSeconds: 1,
		},
	}
	require.NoError(t, ValidateCreateRunAttemptCommand(&command))
	return command
}

func reportRunEvent(t *testing.T, store *Store, workspaceID, runID string, attempt CreateRunAttemptResult, cursor int64, eventType string) {
	t.Helper()
	command := ReportRunEventCommand{
		WorkspaceID: workspaceID, RunID: runID, RunAttemptID: attempt.RunAttemptID,
		Principal: Principal{Type: "service", ID: "verrail-host-runner"}, IdempotencyKey: "g2-7-run-event-" + eventType,
		Input: ReportRunEventInput{
			LeaseID: attempt.LeaseID, FencingToken: attempt.FencingToken, Cursor: cursor,
			EventType: eventType, EmittedAt: time.Now().UTC(), Payload: map[string]any{},
		},
	}
	require.NoError(t, ValidateReportRunEventCommand(&command))
	result, err := store.ReportRunEvent(context.Background(), command)
	require.NoError(t, err)
	require.True(t, result.Authoritative)
}

func workNodeIDByKey(t *testing.T, pool *pgxpool.Pool, graphRevisionID, nodeKey string) string {
	t.Helper()
	var nodeID string
	require.NoError(t, pool.QueryRow(context.Background(), `select id from verrail_work_nodes where graph_revision_id=$1 and node_key=$2`, graphRevisionID, nodeKey).Scan(&nodeID))
	return nodeID
}

func cleanupGraphOrchestrationHarness(pool *pgxpool.Pool, lifecycle *lifecycleTestHarness) {
	ctx := context.Background()
	workspaceID := lifecycle.workspaceID
	for _, statement := range []string{
		`delete from verrail_artifact_revisions where workspace_id=$1`,
		`delete from verrail_artifacts where workspace_id=$1`,
		`delete from verrail_run_events where workspace_id=$1`,
		`delete from verrail_execution_command_receipts where workspace_id=$1`,
		`delete from verrail_execution_leases where workspace_id=$1`,
		`delete from verrail_run_attempts where workspace_id=$1`,
		`delete from verrail_runs where workspace_id=$1`,
		`delete from verrail_work_nodes where workspace_id=$1`,
		`delete from verrail_graph_revisions where workspace_id=$1`,
		`delete from verrail_work_graphs where workspace_id=$1`,
		`delete from verrail_outbox_events where workspace_id=$1`,
		`delete from verrail_command_receipts where workspace_id=$1`,
		`delete from verrail_audit_events where workspace_id=$1`,
		`delete from verrail_target_revisions where workspace_id=$1`,
		`delete from verrail_targets where workspace_id=$1`,
	} {
		_, _ = pool.Exec(ctx, statement, workspaceID)
	}
	lifecycle.cleanup(pool)
	_, _ = pool.Exec(ctx, `delete from company_memberships where company_id=$1`, workspaceID)
	_, _ = pool.Exec(ctx, `delete from companies where id=$1`, workspaceID)
}
