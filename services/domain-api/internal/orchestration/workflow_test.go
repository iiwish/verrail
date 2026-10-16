package orchestration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

const (
	testWorkspaceID = "1081b57b-22a5-4508-b12e-24f6ca1c0d6c"
	testTargetID    = "65af7b92-2634-47ea-9ca7-8150f8bf6a01"
	testRevisionID  = "c4254a50-8707-4d4b-865b-ddfe1566d544"
)

func targetWorkflowWithTwoEventHistory(ctx workflow.Context, input TargetWorkflowInput) error {
	return runTargetWorkflow(ctx, input, 2, targetWorkflowWithTwoEventHistory)
}

func runWorkflowWithTwoEventHistory(ctx workflow.Context, input RunWorkflowInput) error {
	return runRunWorkflow(ctx, input, 2, runWorkflowWithTwoEventHistory)
}

func testReconcileTargetActivity(context.Context, ReconcileTargetActivityInput) (ReconcileTargetActivityResult, error) {
	return ReconcileTargetActivityResult{}, nil
}

func testEnsureRunAttemptActivity(context.Context, EnsureRunAttemptActivityInput) (EnsureRunAttemptActivityResult, error) {
	return EnsureRunAttemptActivityResult{}, nil
}

func testRequestRunCancellationActivity(context.Context, RequestRunCancellationActivityInput) error {
	return nil
}

func testCompletedRunWorkflow(workflow.Context, RunWorkflowInput) error {
	return nil
}

func TestTargetWorkflowTracksOneAggregateAndDeduplicatesSignals(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()

	valid := TargetEvent{
		SchemaVersion:    SchemaVersion,
		EventID:          "942ebec0-ebec-4ba1-8e5a-dd2585f313fa",
		EventType:        TargetCreatedEventType,
		WorkspaceID:      testWorkspaceID,
		TargetID:         testTargetID,
		TargetRevisionID: testRevisionID,
		OccurredAt:       time.Date(2026, time.August, 26, 22, 0, 0, 0, time.UTC),
	}

	environment.RegisterDelayedCallback(func() {
		environment.SignalWorkflow(TargetEventSignalName, valid)
	}, 0)
	environment.RegisterDelayedCallback(func() {
		environment.SignalWorkflow(TargetEventSignalName, valid)
	}, time.Minute)
	environment.RegisterDelayedCallback(func() {
		crossAggregate := valid
		crossAggregate.EventID = "dd455108-8baa-4458-8d49-680408c750fb"
		crossAggregate.TargetID = "64e571ad-dd91-48d9-9e6a-640841c85a0c"
		environment.SignalWorkflow(TargetEventSignalName, crossAggregate)
	}, 2*time.Minute)
	environment.RegisterDelayedCallback(func() {
		encoded, err := environment.QueryWorkflow(TargetStateQueryName)
		require.NoError(t, err)
		var state TargetWorkflowState
		require.NoError(t, encoded.Get(&state))
		require.Equal(t, "awaiting_graph", state.Phase)
		require.Equal(t, 1, state.AcceptedEventCount)
		require.Equal(t, 2, state.IgnoredEventCount)
		require.Equal(t, valid.EventID, state.LastEventID)
		require.Equal(t, testRevisionID, state.ActiveTargetRevisionID)
		environment.CancelWorkflow()
	}, 3*time.Minute)

	environment.ExecuteWorkflow(TargetWorkflow, TargetWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   testWorkspaceID,
		TargetID:      testTargetID,
	})

	require.True(t, environment.IsWorkflowCompleted())
	require.Error(t, environment.GetWorkflowError())
}

func TestTargetWorkflowContinuesAsNewWithBoundedState(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()

	events := make([]TargetEvent, 0, 3)
	for _, eventID := range []string{
		"942ebec0-ebec-4ba1-8e5a-dd2585f313fa",
		"dd455108-8baa-4458-8d49-680408c750fb",
		"b1a54734-4f12-4a94-a539-69ee79aeef0a",
	} {
		events = append(events, TargetEvent{
			SchemaVersion:    SchemaVersion,
			EventID:          eventID,
			EventType:        TargetCreatedEventType,
			WorkspaceID:      testWorkspaceID,
			TargetID:         testTargetID,
			TargetRevisionID: testRevisionID,
		})
	}
	environment.RegisterDelayedCallback(func() {
		for _, event := range events {
			environment.SignalWorkflow(TargetEventSignalName, event)
		}
	}, 0)

	environment.ExecuteWorkflow(targetWorkflowWithTwoEventHistory, TargetWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   testWorkspaceID,
		TargetID:      testTargetID,
	})

	workflowErr := environment.GetWorkflowError()
	require.True(t, workflow.IsContinueAsNewError(workflowErr))
	var continueErr *workflow.ContinueAsNewError
	require.True(t, errors.As(workflowErr, &continueErr))
	var next TargetWorkflowInput
	require.NoError(t, converter.GetDefaultDataConverter().FromPayloads(continueErr.Input, &next))
	require.NotNil(t, next.State)
	require.Equal(t, 3, next.State.AcceptedEventCount, "queued signals must be drained before Continue-As-New")
}

func TestWorkflowIDIsStableAndWorkspaceScoped(t *testing.T) {
	first := TargetWorkflowID(testWorkspaceID, testTargetID)
	second := TargetWorkflowID(testWorkspaceID, testTargetID)
	require.Equal(t, first, second)
	require.Equal(t, "verrail-target-v1:"+testWorkspaceID+":"+testTargetID, first)
	require.Equal(t, "reconcile:graph-1:4", TargetReconcileActivityID("graph-1", 4))
	require.Equal(t, "ensure-attempt:run-1:2:3", RunAttemptActivityID("run-1", 2, 3))
	require.Equal(t, "request-cancel:run-1", RunCancellationActivityID("run-1"))
}

func TestTargetWorkflowRetriesReconciliationAndStartsStableRunChild(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.RegisterActivityWithOptions(testReconcileTargetActivity, activity.RegisterOptions{Name: ReconcileTargetActivityName})
	environment.RegisterWorkflowWithOptions(testCompletedRunWorkflow, workflow.RegisterOptions{Name: RunWorkflowName})

	graphRevisionID := "52d76f13-d7f5-42b7-8385-bc995147a28d"
	runID := "c7bb8f5c-8fdc-4b84-81d6-2866a597a45c"
	waitingResult := ReconcileTargetActivityResult{
		SchemaVersion:      SchemaVersion,
		WaitingTaskNodeIDs: []string{"dependency-node"},
	}
	readyResult := ReconcileTargetActivityResult{
		SchemaVersion: SchemaVersion,
		ScheduledRuns: []ScheduledAgentRun{{RunID: runID}},
		ActiveRunIDs:  []string{runID},
		AllCompleted:  true,
	}
	expectedFirst := ReconcileTargetActivityInput{
		SchemaVersion:    SchemaVersion,
		WorkspaceID:      testWorkspaceID,
		TargetID:         testTargetID,
		TargetRevisionID: testRevisionID,
		GraphRevisionID:  graphRevisionID,
		Cycle:            1,
	}
	environment.OnActivity(ReconcileTargetActivityName, mock.Anything, expectedFirst).
		Return(ReconcileTargetActivityResult{}, temporal.NewApplicationError("retry", "TRANSIENT")).Once()
	environment.OnActivity(ReconcileTargetActivityName, mock.Anything, expectedFirst).
		Return(waitingResult, nil).Once()
	environment.OnActivity(ReconcileTargetActivityName, mock.Anything, mock.MatchedBy(func(input ReconcileTargetActivityInput) bool {
		return input.Cycle == 2 && input.GraphRevisionID == graphRevisionID
	})).Return(readyResult, nil).Once()

	activityIDs := make([]string, 0, 3)
	environment.SetOnActivityStartedListener(func(info *activity.Info, _ context.Context, _ converter.EncodedValues) {
		activityIDs = append(activityIDs, info.ActivityID)
	})
	var childWorkflowID string
	environment.SetOnChildWorkflowStartedListener(func(info *workflow.Info, _ workflow.Context, _ converter.EncodedValues) {
		childWorkflowID = info.WorkflowExecution.ID
	})
	environment.RegisterDelayedCallback(func() {
		environment.SignalWorkflow(TargetEventSignalName, TargetEvent{
			SchemaVersion:    SchemaVersion,
			EventID:          "graph-activated",
			EventType:        GraphActivatedEventType,
			WorkspaceID:      testWorkspaceID,
			TargetID:         testTargetID,
			TargetRevisionID: testRevisionID,
			GraphRevisionID:  graphRevisionID,
		})
	}, 0)

	environment.ExecuteWorkflow(TargetWorkflow, TargetWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   testWorkspaceID,
		TargetID:      testTargetID,
	})

	require.NoError(t, environment.GetWorkflowError())
	require.Equal(t, RunWorkflowID(testWorkspaceID, runID), childWorkflowID)
	require.Equal(t, []string{
		TargetReconcileActivityID(graphRevisionID, 1),
		TargetReconcileActivityID(graphRevisionID, 1),
		TargetReconcileActivityID(graphRevisionID, 2),
	}, activityIDs)
	environment.AssertExpectations(t)
}

func TestTargetWorkflowKeepsLegacyHistoryOnDefaultVersion(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.OnGetVersion(activeTargetOrchestrationChangeID, workflow.DefaultVersion, 1).Return(workflow.DefaultVersion).Once()
	environment.RegisterDelayedCallback(func() {
		environment.SignalWorkflow(TargetEventSignalName, TargetEvent{
			SchemaVersion: SchemaVersion, EventID: "legacy-graph", EventType: GraphActivatedEventType,
			WorkspaceID: testWorkspaceID, TargetID: testTargetID, TargetRevisionID: testRevisionID,
			GraphRevisionID: "52d76f13-d7f5-42b7-8385-bc995147a28d",
		})
	}, 0)
	environment.RegisterDelayedCallback(func() {
		encoded, err := environment.QueryWorkflow(TargetStateQueryName)
		require.NoError(t, err)
		var state TargetWorkflowState
		require.NoError(t, encoded.Get(&state))
		require.Equal(t, "orchestrating", state.Phase)
		require.Zero(t, state.ReconcileCycle)
		environment.CancelWorkflow()
	}, time.Minute)

	environment.ExecuteWorkflow(TargetWorkflow, TargetWorkflowInput{
		SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, TargetID: testTargetID,
	})

	require.Error(t, environment.GetWorkflowError())
	environment.AssertExpectations(t)
}

func TestRunWorkflowRecoversExpiredAttemptAndIgnoresStaleAttemptSignal(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.SetStartTime(time.Date(2026, time.September, 4, 8, 0, 0, 0, time.UTC))
	environment.RegisterActivityWithOptions(testEnsureRunAttemptActivity, activity.RegisterOptions{Name: EnsureRunAttemptActivityName})

	attemptOne := EnsureRunAttemptActivityResult{
		SchemaVersion: SchemaVersion,
		RunID:         testTargetID,
		RunAttemptID:  "attempt-1",
		LeaseID:       "lease-1",
		AttemptNumber: 1,
		FencingToken:  1,
		RecoverAfter:  environment.Now().Add(time.Minute),
	}
	attemptTwo := EnsureRunAttemptActivityResult{
		SchemaVersion: SchemaVersion,
		RunID:         testTargetID,
		RunAttemptID:  "attempt-2",
		LeaseID:       "lease-2",
		AttemptNumber: 2,
		FencingToken:  2,
		RecoverAfter:  environment.Now().Add(time.Hour),
	}
	environment.OnActivity(EnsureRunAttemptActivityName, mock.Anything, EnsureRunAttemptActivityInput{
		SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID, AttemptOrdinal: 1, MaxAttempts: 2,
	}).Return(attemptOne, nil).Once()
	environment.OnActivity(EnsureRunAttemptActivityName, mock.Anything, EnsureRunAttemptActivityInput{
		SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID, AttemptOrdinal: 2, MaxAttempts: 2,
	}).Return(attemptTwo, nil).Once()

	activityIDs := make([]string, 0, 2)
	environment.SetOnActivityStartedListener(func(info *activity.Info, _ context.Context, _ converter.EncodedValues) {
		activityIDs = append(activityIDs, info.ActivityID)
	})
	environment.RegisterDelayedCallback(func() {
		environment.SignalWorkflow(RunEventSignalName, RunEvent{
			SchemaVersion: SchemaVersion,
			EventID:       "stale-attempt",
			EventType:     "run.attempt_created",
			WorkspaceID:   testWorkspaceID,
			TargetID:      testRevisionID,
			RunID:         testTargetID,
			RunAttemptID:  "attempt-1",
		})
		environment.SignalWorkflow(RunEventSignalName, RunEvent{
			SchemaVersion: SchemaVersion,
			EventID:       "attempt-succeeded",
			EventType:     "run.event_succeeded",
			WorkspaceID:   testWorkspaceID,
			TargetID:      testRevisionID,
			RunID:         testTargetID,
			RunAttemptID:  "attempt-2",
		})
	}, 2*time.Minute)

	environment.ExecuteWorkflow(RunWorkflow, RunWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   testWorkspaceID,
		RunID:         testTargetID,
		MaxAttempts:   2,
	})

	require.NoError(t, environment.GetWorkflowError())
	require.Equal(t, []string{
		RunAttemptActivityID(testTargetID, 1, 0),
		RunAttemptActivityID(testTargetID, 2, 1),
	}, activityIDs)
	environment.AssertExpectations(t)
}

func TestRunWorkflowContinuesAsNewWithCurrentAttemptState(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.RegisterActivityWithOptions(testEnsureRunAttemptActivity, activity.RegisterOptions{Name: EnsureRunAttemptActivityName})
	environment.OnActivity(EnsureRunAttemptActivityName, mock.Anything, mock.Anything).Return(EnsureRunAttemptActivityResult{
		SchemaVersion: SchemaVersion,
		RunID:         testTargetID,
		RunAttemptID:  "attempt-1",
		LeaseID:       "lease-1",
		AttemptNumber: 1,
		FencingToken:  1,
		RecoverAfter:  time.Now().Add(time.Hour),
	}, nil).Once()
	for index, delay := range []time.Duration{time.Second, 2 * time.Second} {
		index := index
		environment.RegisterDelayedCallback(func() {
			environment.SignalWorkflow(RunEventSignalName, RunEvent{
				SchemaVersion: SchemaVersion,
				EventID:       "progress-" + string(rune('1'+index)),
				EventType:     "run.event_progress",
				WorkspaceID:   testWorkspaceID,
				TargetID:      testRevisionID,
				RunID:         testTargetID,
				RunAttemptID:  "attempt-1",
			})
		}, delay)
	}

	environment.ExecuteWorkflow(runWorkflowWithTwoEventHistory, RunWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   testWorkspaceID,
		RunID:         testTargetID,
	})

	workflowErr := environment.GetWorkflowError()
	require.True(t, workflow.IsContinueAsNewError(workflowErr))
	var continueErr *workflow.ContinueAsNewError
	require.True(t, errors.As(workflowErr, &continueErr))
	var next RunWorkflowInput
	require.NoError(t, converter.GetDefaultDataConverter().FromPayloads(continueErr.Input, &next))
	require.NotNil(t, next.State)
	require.Equal(t, "attempt-1", next.State.CurrentAttemptID)
	require.Equal(t, 2, next.State.AcceptedEventCount)
	require.Equal(t, 0, next.State.EventsInRun)
}

func TestRunWorkflowCancellationRequestsDomainCancellation(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.RegisterActivityWithOptions(testEnsureRunAttemptActivity, activity.RegisterOptions{Name: EnsureRunAttemptActivityName})
	environment.RegisterActivityWithOptions(testRequestRunCancellationActivity, activity.RegisterOptions{Name: RequestRunCancellationActivityName})
	environment.OnActivity(EnsureRunAttemptActivityName, mock.Anything, mock.Anything).Return(EnsureRunAttemptActivityResult{
		SchemaVersion: SchemaVersion,
		RunID:         testTargetID,
		RunAttemptID:  "attempt-1",
		LeaseID:       "lease-1",
		AttemptNumber: 1,
		FencingToken:  1,
		RecoverAfter:  time.Now().Add(time.Hour),
	}, nil).Once()
	environment.OnActivity(RequestRunCancellationActivityName, mock.Anything, RequestRunCancellationActivityInput{
		SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID,
	}).Return(nil).Once()
	var cancellationActivityID string
	environment.SetOnActivityStartedListener(func(info *activity.Info, _ context.Context, _ converter.EncodedValues) {
		if info.ActivityType.Name == RequestRunCancellationActivityName {
			cancellationActivityID = info.ActivityID
		}
	})
	environment.RegisterDelayedCallback(environment.CancelWorkflow, time.Minute)

	environment.ExecuteWorkflow(RunWorkflow, RunWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   testWorkspaceID,
		RunID:         testTargetID,
	})

	require.Error(t, environment.GetWorkflowError())
	require.Equal(t, RunCancellationActivityID(testTargetID), cancellationActivityID)
	environment.AssertExpectations(t)
}

func TestRunWorkflowKeepsLegacyHistoryOnDefaultVersion(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.OnGetVersion(activeRunOrchestrationChangeID, workflow.DefaultVersion, 1).Return(workflow.DefaultVersion).Once()
	environment.RegisterDelayedCallback(func() {
		environment.SignalWorkflow(RunEventSignalName, RunEvent{
			SchemaVersion: SchemaVersion, EventID: "legacy-started", EventType: "run.event_started",
			WorkspaceID: testWorkspaceID, TargetID: testRevisionID, RunID: testTargetID, RunAttemptID: "attempt-1",
		})
	}, 0)
	environment.RegisterDelayedCallback(func() {
		encoded, err := environment.QueryWorkflow(RunStateQueryName)
		require.NoError(t, err)
		var state RunWorkflowState
		require.NoError(t, encoded.Get(&state))
		require.Equal(t, "running", state.Phase)
		require.Zero(t, state.AttemptNumber)
		environment.CancelWorkflow()
	}, time.Minute)

	environment.ExecuteWorkflow(RunWorkflow, RunWorkflowInput{
		SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID,
	})

	require.Error(t, environment.GetWorkflowError())
	environment.AssertExpectations(t)
}

func TestRunWorkflowTracksRecoveryAndObservableCancellation(t *testing.T) {
	state := RunWorkflowState{SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID, Phase: "awaiting_attempt"}
	events := []RunEvent{
		{SchemaVersion: SchemaVersion, EventID: "run-created", EventType: RunCreatedEventType, WorkspaceID: testWorkspaceID, TargetID: testRevisionID, RunID: testTargetID},
		{SchemaVersion: SchemaVersion, EventID: "attempt-created", EventType: "run.attempt_created", WorkspaceID: testWorkspaceID, TargetID: testRevisionID, RunID: testTargetID, RunAttemptID: "attempt-1"},
		{SchemaVersion: SchemaVersion, EventID: "started", EventType: "run.event_started", WorkspaceID: testWorkspaceID, TargetID: testRevisionID, RunID: testTargetID, RunAttemptID: "attempt-1"},
		{SchemaVersion: SchemaVersion, EventID: "cancel", EventType: RunCancellationRequestedEventType, WorkspaceID: testWorkspaceID, TargetID: testRevisionID, RunID: testTargetID, RunAttemptID: "attempt-1"},
		{SchemaVersion: SchemaVersion, EventID: "terminated", EventType: "run.event_terminated", WorkspaceID: testWorkspaceID, TargetID: testRevisionID, RunID: testTargetID, RunAttemptID: "attempt-1"},
	}
	for _, event := range events {
		require.True(t, applyRunEvent(&state, event))
	}
	require.Equal(t, "canceled", state.Phase)
	require.True(t, state.CancellationRequested)
	require.Equal(t, "attempt-1", state.CurrentAttemptID)
	require.Equal(t, len(events), state.AcceptedEventCount)
	require.False(t, applyRunEvent(&state, events[len(events)-1]))
	require.Equal(t, 1, state.IgnoredEventCount)
	require.Equal(t, "verrail-run-v1:"+testWorkspaceID+":"+testTargetID, RunWorkflowID(testWorkspaceID, testTargetID))
	state.CurrentAttemptID = "attempt-2"
	staleAttempt := events[1]
	staleAttempt.EventID = "late-attempt-created"
	require.False(t, applyRunEvent(&state, staleAttempt))
	require.Equal(t, "attempt-2", state.CurrentAttemptID)
}
