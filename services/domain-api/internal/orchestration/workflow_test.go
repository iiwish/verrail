package orchestration

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/converter"
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
}
