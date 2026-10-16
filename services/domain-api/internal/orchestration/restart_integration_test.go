package orchestration

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	temporallog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

func TestFailedRunRecoveryUsesAuthoritativeObserverAndReplaysHistory(t *testing.T) {
	address := os.Getenv("VERRAIL_TEST_TEMPORAL_ADDRESS")
	if address == "" {
		t.Skip("VERRAIL_TEST_TEMPORAL_ADDRESS is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	c, err := client.DialContext(ctx, client.Options{HostPort: address, Namespace: "default"})
	require.NoError(t, err)
	defer c.Close()
	workspaceID, err := newUUID()
	require.NoError(t, err)
	runID, err := newUUID()
	require.NoError(t, err)
	workflowID := RunWorkflowID(workspaceID, runID)
	queue := "recovery-test-" + runID
	var completed atomic.Bool
	var observations atomic.Int32
	w := worker.New(c, queue, worker.Options{})
	w.RegisterWorkflowWithOptions(func(workflow.Context) error {
		return temporal.NewNonRetryableApplicationError("injected failure", "RECOVERY_FIXTURE", nil)
	}, workflow.RegisterOptions{Name: "recovery.fixture.fail"})
	w.RegisterWorkflowWithOptions(RunWorkflow, workflow.RegisterOptions{Name: RunWorkflowName})
	w.RegisterActivityWithOptions(func(context.Context, ObserveRunRecoveryActivityInput) (ObserveRunRecoveryActivityResult, error) {
		observations.Add(1)
		status := "failed"
		if completed.Load() {
			status = "succeeded"
		}
		return ObserveRunRecoveryActivityResult{SchemaVersion: SchemaVersion, WorkspaceID: workspaceID, RunID: runID, TargetID: testTargetID, RunStatus: status, RunAttemptID: "current-attempt", AttemptNumber: 3, FencingToken: 3}, nil
	}, activity.RegisterOptions{Name: ObserveRunRecoveryActivityName})
	require.NoError(t, w.Start())
	defer w.Stop()
	failed, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: workflowID, TaskQueue: queue}, "recovery.fixture.fail")
	require.NoError(t, err)
	require.Error(t, failed.Get(ctx, nil))
	event := OutboxEvent{ID: "recovery-event", WorkspaceID: workspaceID, AggregateType: "run", AggregateID: runID, EventType: RunCancellationRequestedEventType,
		Payload: []byte(`{"schemaVersion":1,"targetId":"` + testTargetID + `","runId":"` + runID + `","runAttemptId":"old-attempt","eventType":"run.cancellation_requested"}`)}
	deliverer := NewTemporalDeliverer(c, queue)
	_, err = deliverer.Deliver(ctx, event)
	require.Error(t, err, "an ordinary event cannot restart a failed Workflow")
	event.RecoveryRequested = true
	recovered, err := deliverer.Deliver(ctx, event)
	require.NoError(t, err)
	require.NotEqual(t, failed.GetRunID(), recovered.RunID)
	for {
		encoded, queryErr := c.QueryWorkflow(ctx, workflowID, recovered.RunID, RunStateQueryName)
		if queryErr == nil {
			var state RunWorkflowState
			if encoded.Get(&state) == nil && state.Phase == "failed" && state.CurrentAttemptID == "current-attempt" {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("recovery state not observed")
		case <-time.After(20 * time.Millisecond):
		}
	}
	completed.Store(true)
	require.NoError(t, c.SignalWorkflow(ctx, workflowID, recovered.RunID, RunEventSignalName, RunEvent{SchemaVersion: SchemaVersion, EventID: "done", EventType: "run.event_succeeded", WorkspaceID: workspaceID, RunID: runID, TargetID: testTargetID, RunAttemptID: "current-attempt"}))
	require.NoError(t, c.GetWorkflow(ctx, workflowID, recovered.RunID).Get(ctx, nil))
	require.GreaterOrEqual(t, observations.Load(), int32(2))
	iterator := c.GetWorkflowHistory(ctx, workflowID, recovered.RunID, false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	history := &historypb.History{}
	for iterator.HasNext() {
		event, err := iterator.Next()
		require.NoError(t, err)
		history.Events = append(history.Events, event)
	}
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflowWithOptions(RunWorkflow, workflow.RegisterOptions{Name: RunWorkflowName})
	logger := temporallog.NewStructuredLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, replayer.ReplayWorkflowHistory(logger, history))
}

func TestTargetWorkflowSurvivesWorkerRestartAndReplaysLiveHistory(t *testing.T) {
	address := os.Getenv("VERRAIL_TEST_TEMPORAL_ADDRESS")
	if address == "" {
		t.Skip("VERRAIL_TEST_TEMPORAL_ADDRESS is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	temporalClient, err := client.DialContext(ctx, client.Options{HostPort: address, Namespace: "default"})
	require.NoError(t, err)
	defer temporalClient.Close()

	unique := time.Now().UnixNano()
	taskQueue := fmt.Sprintf("verrail-restart-test-%d", unique)
	workflowID := fmt.Sprintf("verrail-restart-target-%d", unique)
	workspaceID := "1081b57b-22a5-4508-b12e-24f6ca1c0d6c"
	targetID := "65af7b92-2634-47ea-9ca7-8150f8bf6a01"
	targetRevisionID := "c4254a50-8707-4d4b-865b-ddfe1566d544"
	graphRevisionID := "52d76f13-d7f5-42b7-8385-bc995147a28d"

	var reconciliations atomic.Int32
	firstReconciliation := make(chan struct{})
	reconcile := func(context.Context, ReconcileTargetActivityInput) (ReconcileTargetActivityResult, error) {
		count := reconciliations.Add(1)
		if count == 1 {
			close(firstReconciliation)
			return ReconcileTargetActivityResult{SchemaVersion: SchemaVersion, WaitingGateNodeIDs: []string{"gate-1"}}, nil
		}
		return ReconcileTargetActivityResult{SchemaVersion: SchemaVersion, AllCompleted: true}, nil
	}
	startWorker := func() worker.Worker {
		temporalWorker := worker.New(temporalClient, taskQueue, worker.Options{})
		temporalWorker.RegisterWorkflowWithOptions(TargetWorkflow, workflow.RegisterOptions{Name: TargetWorkflowName})
		temporalWorker.RegisterActivityWithOptions(reconcile, activity.RegisterOptions{Name: ReconcileTargetActivityName})
		require.NoError(t, temporalWorker.Start())
		return temporalWorker
	}

	firstWorker := startWorker()
	run, err := temporalClient.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: workflowID, TaskQueue: taskQueue}, TargetWorkflowName, TargetWorkflowInput{
		SchemaVersion: SchemaVersion, WorkspaceID: workspaceID, TargetID: targetID,
	})
	require.NoError(t, err)
	require.NoError(t, temporalClient.SignalWorkflow(ctx, workflowID, run.GetRunID(), TargetEventSignalName, TargetEvent{
		SchemaVersion: SchemaVersion, EventID: "graph-activated", EventType: GraphActivatedEventType,
		WorkspaceID: workspaceID, TargetID: targetID, TargetRevisionID: targetRevisionID, GraphRevisionID: graphRevisionID,
	}))
	select {
	case <-firstReconciliation:
	case <-ctx.Done():
		t.Fatal("first reconciliation did not complete before timeout")
	}
	for {
		encoded, queryErr := temporalClient.QueryWorkflow(ctx, workflowID, run.GetRunID(), TargetStateQueryName)
		if queryErr == nil {
			var state TargetWorkflowState
			if encoded.Get(&state) == nil && state.ReconcileCycle == 1 {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("workflow did not persist its first reconciliation before timeout")
		case <-time.After(20 * time.Millisecond):
		}
	}
	firstWorker.Stop()

	secondWorker := startWorker()
	defer secondWorker.Stop()
	require.NoError(t, temporalClient.SignalWorkflow(ctx, workflowID, run.GetRunID(), TargetEventSignalName, TargetEvent{
		SchemaVersion: SchemaVersion, EventID: "restart-wakeup", EventType: TargetCreatedEventType,
		WorkspaceID: workspaceID, TargetID: targetID, TargetRevisionID: targetRevisionID,
	}))
	require.NoError(t, run.Get(ctx, nil))
	require.Equal(t, int32(2), reconciliations.Load())

	historyIterator := temporalClient.GetWorkflowHistory(ctx, workflowID, run.GetRunID(), false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	history := &historypb.History{}
	for historyIterator.HasNext() {
		event, historyErr := historyIterator.Next()
		require.NoError(t, historyErr)
		history.Events = append(history.Events, event)
	}
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflowWithOptions(TargetWorkflow, workflow.RegisterOptions{Name: TargetWorkflowName})
	logger := temporallog.NewStructuredLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, replayer.ReplayWorkflowHistory(logger, history))
}

func TestRunWorkflowSurvivesWorkerRestartAndReplaysLiveHistory(t *testing.T) {
	address := os.Getenv("VERRAIL_TEST_TEMPORAL_ADDRESS")
	if address == "" {
		t.Skip("VERRAIL_TEST_TEMPORAL_ADDRESS is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	temporalClient, err := client.DialContext(ctx, client.Options{HostPort: address, Namespace: "default"})
	require.NoError(t, err)
	defer temporalClient.Close()

	unique := time.Now().UnixNano()
	taskQueue := fmt.Sprintf("verrail-run-restart-test-%d", unique)
	workflowID := fmt.Sprintf("verrail-restart-run-%d", unique)
	workspaceID := "1081b57b-22a5-4508-b12e-24f6ca1c0d6c"
	runID := "65af7b92-2634-47ea-9ca7-8150f8bf6a01"
	attemptID := "c4254a50-8707-4d4b-865b-ddfe1566d544"
	attemptReady := make(chan struct{})
	var ensureCalls atomic.Int32
	ensure := func(context.Context, EnsureRunAttemptActivityInput) (EnsureRunAttemptActivityResult, error) {
		if ensureCalls.Add(1) == 1 {
			close(attemptReady)
		}
		return EnsureRunAttemptActivityResult{
			SchemaVersion: SchemaVersion, RunID: runID, RunAttemptID: attemptID,
			LeaseID: "52d76f13-d7f5-42b7-8385-bc995147a28d", AttemptNumber: 1, FencingToken: 1,
			RecoverAfter: time.Now().Add(time.Hour),
		}, nil
	}
	startWorker := func() worker.Worker {
		temporalWorker := worker.New(temporalClient, taskQueue, worker.Options{})
		temporalWorker.RegisterWorkflowWithOptions(RunWorkflow, workflow.RegisterOptions{Name: RunWorkflowName})
		temporalWorker.RegisterActivityWithOptions(ensure, activity.RegisterOptions{Name: EnsureRunAttemptActivityName})
		require.NoError(t, temporalWorker.Start())
		return temporalWorker
	}

	firstWorker := startWorker()
	run, err := temporalClient.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: workflowID, TaskQueue: taskQueue}, RunWorkflowName, RunWorkflowInput{
		SchemaVersion: SchemaVersion, WorkspaceID: workspaceID, RunID: runID, MaxAttempts: 3,
	})
	require.NoError(t, err)
	select {
	case <-attemptReady:
	case <-ctx.Done():
		t.Fatal("RunAttempt was not ensured before timeout")
	}
	for {
		encoded, queryErr := temporalClient.QueryWorkflow(ctx, workflowID, run.GetRunID(), RunStateQueryName)
		if queryErr == nil {
			var state RunWorkflowState
			if encoded.Get(&state) == nil && state.CurrentAttemptID == attemptID {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("RunWorkflow did not persist its Attempt before timeout")
		case <-time.After(20 * time.Millisecond):
		}
	}
	firstWorker.Stop()

	secondWorker := startWorker()
	defer secondWorker.Stop()
	require.NoError(t, temporalClient.SignalWorkflow(ctx, workflowID, run.GetRunID(), RunEventSignalName, RunEvent{
		SchemaVersion: SchemaVersion, EventID: "run-succeeded", EventType: "run.event_succeeded",
		WorkspaceID: workspaceID, TargetID: "target-1", RunID: runID, RunAttemptID: attemptID,
	}))
	require.NoError(t, run.Get(ctx, nil))
	require.Equal(t, int32(1), ensureCalls.Load(), "replay after restart must not duplicate the Ensure Activity")

	historyIterator := temporalClient.GetWorkflowHistory(ctx, workflowID, run.GetRunID(), false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	history := &historypb.History{}
	for historyIterator.HasNext() {
		event, historyErr := historyIterator.Next()
		require.NoError(t, historyErr)
		history.Events = append(history.Events, event)
	}
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflowWithOptions(RunWorkflow, workflow.RegisterOptions{Name: RunWorkflowName})
	logger := temporallog.NewStructuredLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, replayer.ReplayWorkflowHistory(logger, history))
}
