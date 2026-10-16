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
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

func testObserveRunRecovery(context.Context, ObserveRunRecoveryActivityInput) (ObserveRunRecoveryActivityResult, error) {
	return ObserveRunRecoveryActivityResult{}, nil
}

func recoverySnapshot(status, attemptID string, number int, deadline time.Time) ObserveRunRecoveryActivityResult {
	return ObserveRunRecoveryActivityResult{SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID, TargetID: testRevisionID, RunStatus: status, RunAttemptID: attemptID, AttemptNumber: number, FencingToken: int64(number), LeaseID: "lease-" + attemptID, RecoverAfter: deadline, LeaseStatus: "active"}
}

func TestRecoveryModeDoesNotAllocateAttemptsOrApplyLateCancellation(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(testObserveRunRecovery, activity.RegisterOptions{Name: ObserveRunRecoveryActivityName})
	input := ObserveRunRecoveryActivityInput{SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID}
	env.OnActivity(ObserveRunRecoveryActivityName, mock.Anything, input).Return(recoverySnapshot("failed", "attempt-3", 3, env.Now()), nil).Once()
	env.OnActivity(ObserveRunRecoveryActivityName, mock.Anything, input).Return(recoverySnapshot("running", "attempt-4", 4, env.Now().Add(time.Hour)), nil).Once()
	env.OnActivity(ObserveRunRecoveryActivityName, mock.Anything, input).Return(recoverySnapshot("succeeded", "attempt-4", 4, env.Now().Add(time.Hour)), nil).Once()
	env.RegisterDelayedCallback(func() {
		env.SignalWorkflow(RunEventSignalName, RunEvent{SchemaVersion: SchemaVersion, EventID: "old-cancel", EventType: RunCancellationRequestedEventType, WorkspaceID: testWorkspaceID, RunID: testTargetID, TargetID: testRevisionID, RunAttemptID: "attempt-2"})
	}, time.Minute)
	env.RegisterDelayedCallback(func() {
		value, err := env.QueryWorkflow(RunStateQueryName)
		require.NoError(t, err)
		var state RunWorkflowState
		require.NoError(t, value.Get(&state))
		require.Equal(t, "running", state.Phase)
		require.Equal(t, "attempt-4", state.CurrentAttemptID)
		require.False(t, state.CancellationRequested)
		env.SignalWorkflow(RunEventSignalName, RunEvent{SchemaVersion: SchemaVersion, EventID: "success", EventType: "run.event_succeeded", WorkspaceID: testWorkspaceID, RunID: testTargetID, TargetID: testRevisionID, RunAttemptID: "attempt-4"})
	}, 2*time.Minute)
	env.ExecuteWorkflow(RunWorkflow, RunWorkflowInput{SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID, Recovery: true})
	require.NoError(t, env.GetWorkflowError())
	env.AssertExpectations(t)
}

func TestRecoveryModeExpiresViaDomainActivityAndWaitsForExplicitRetry(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(testObserveRunRecovery, activity.RegisterOptions{Name: ObserveRunRecoveryActivityName})
	env.OnActivity(ObserveRunRecoveryActivityName, mock.Anything, mock.Anything).Return(recoverySnapshot("queued", "attempt-3", 3, env.Now().Add(time.Minute)), nil).Once()
	env.OnActivity(ObserveRunRecoveryActivityName, mock.Anything, mock.Anything).Return(recoverySnapshot("failed", "attempt-3", 3, env.Now()), nil).Once()
	env.RegisterDelayedCallback(func() {
		value, err := env.QueryWorkflow(RunStateQueryName)
		require.NoError(t, err)
		var state RunWorkflowState
		require.NoError(t, value.Get(&state))
		require.Equal(t, "failed", state.Phase)
		require.Equal(t, 3, state.AttemptNumber)
		env.CancelWorkflow()
	}, 2*time.Minute)
	env.ExecuteWorkflow(RunWorkflow, RunWorkflowInput{SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID, Recovery: true})
	require.Error(t, env.GetWorkflowError())
	env.AssertExpectations(t)
}

func TestRecoveryWaitsForOutboxDrainBeforeCompletion(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(testObserveRunRecovery, activity.RegisterOptions{Name: ObserveRunRecoveryActivityName})
	pending := recoverySnapshot("succeeded", "attempt-3", 3, env.Now())
	pending.PendingEvents = true
	env.OnActivity(ObserveRunRecoveryActivityName, mock.Anything, mock.Anything).Return(pending, nil).Once()
	pending.PendingEvents = false
	env.OnActivity(ObserveRunRecoveryActivityName, mock.Anything, mock.Anything).Return(pending, nil).Once()
	env.ExecuteWorkflow(RunWorkflow, RunWorkflowInput{SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID, Recovery: true})
	require.NoError(t, env.GetWorkflowError())
	env.AssertExpectations(t)
}

func TestRecoveryContinuesAsNewWithoutLosingModeOrDeduplication(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(testObserveRunRecovery, activity.RegisterOptions{Name: ObserveRunRecoveryActivityName})
	env.OnActivity(ObserveRunRecoveryActivityName, mock.Anything, mock.Anything).Return(recoverySnapshot("failed", "attempt-3", 3, env.Now()), nil).Times(3)
	for index, eventID := range []string{"first", "second"} {
		eventID := eventID
		env.RegisterDelayedCallback(func() {
			env.SignalWorkflow(RunEventSignalName, RunEvent{SchemaVersion: SchemaVersion, EventID: eventID, EventType: "run.event_failed", WorkspaceID: testWorkspaceID, RunID: testTargetID, TargetID: testRevisionID, RunAttemptID: "attempt-3"})
		}, time.Duration(index+1)*time.Second)
	}
	env.ExecuteWorkflow(runWorkflowWithTwoEventHistory, RunWorkflowInput{SchemaVersion: SchemaVersion, WorkspaceID: testWorkspaceID, RunID: testTargetID, Recovery: true})
	var continued *workflow.ContinueAsNewError
	require.True(t, errors.As(env.GetWorkflowError(), &continued))
	var next RunWorkflowInput
	require.NoError(t, converter.GetDefaultDataConverter().FromPayloads(continued.Input, &next))
	require.True(t, next.Recovery)
	require.Equal(t, 3, next.State.RecoveryCycle)
	require.Equal(t, []string{"first", "second"}, next.State.ProcessedEventIDs)
	require.Equal(t, 0, next.State.EventsInRun)
	env.AssertExpectations(t)
}
