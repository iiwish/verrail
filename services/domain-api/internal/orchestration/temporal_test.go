package orchestration

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"
)

type recordedSignalWithStartClient struct {
	workflowID   string
	signalName   string
	signal       interface{}
	options      client.StartWorkflowOptions
	workflowType interface{}
	workflowArgs []interface{}
	run          client.WorkflowRun
	err          error
}

func (recorded *recordedSignalWithStartClient) SignalWithStartWorkflow(
	_ context.Context,
	workflowID string,
	signalName string,
	signal interface{},
	options client.StartWorkflowOptions,
	workflowType interface{},
	workflowArgs ...interface{},
) (client.WorkflowRun, error) {
	recorded.workflowID = workflowID
	recorded.signalName = signalName
	recorded.signal = signal
	recorded.options = options
	recorded.workflowType = workflowType
	recorded.workflowArgs = workflowArgs
	return recorded.run, recorded.err
}

type fakeWorkflowRun struct {
	id    string
	runID string
}

func (run fakeWorkflowRun) GetID() string                          { return run.id }
func (run fakeWorkflowRun) GetRunID() string                       { return run.runID }
func (run fakeWorkflowRun) GetFirstExecutionRunID() string         { return run.runID }
func (run fakeWorkflowRun) Get(context.Context, interface{}) error { return nil }
func (run fakeWorkflowRun) GetWithOptions(context.Context, interface{}, client.WorkflowRunGetOptions) error {
	return nil
}

func TestTemporalDelivererUsesVersionedSignalWithStartContract(t *testing.T) {
	event := *claimedTargetEvent(1)
	recorded := &recordedSignalWithStartClient{
		run: fakeWorkflowRun{id: TargetWorkflowID(event.WorkspaceID, event.AggregateID), runID: "run-1"},
	}
	deliverer := NewTemporalDeliverer(recorded, DefaultTargetTaskQueue)

	result, err := deliverer.Deliver(context.Background(), event)

	require.NoError(t, err)
	require.Equal(t, DeliveryResult{WorkflowID: recorded.workflowID, RunID: "run-1"}, result)
	require.Equal(t, TargetWorkflowID(event.WorkspaceID, event.AggregateID), recorded.workflowID)
	require.Equal(t, TargetEventSignalName, recorded.signalName)
	require.Equal(t, TargetWorkflowName, recorded.workflowType)
	require.Equal(t, DefaultTargetTaskQueue, recorded.options.TaskQueue)
	require.Equal(t, enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING, recorded.options.WorkflowIDConflictPolicy)
	require.Equal(t, enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE, recorded.options.WorkflowIDReusePolicy)
	require.Equal(t, TargetEvent{
		SchemaVersion:    SchemaVersion,
		EventID:          event.ID,
		EventType:        event.EventType,
		WorkspaceID:      event.WorkspaceID,
		TargetID:         event.AggregateID,
		TargetRevisionID: testRevisionID,
		OccurredAt:       event.CreatedAt,
	}, recorded.signal)
	require.Equal(t, []interface{}{TargetWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   event.WorkspaceID,
		TargetID:      event.AggregateID,
	}}, recorded.workflowArgs)
}

func TestTemporalDelivererClassifiesContractsAndAvailability(t *testing.T) {
	invalid := *claimedTargetEvent(1)
	invalid.Payload = []byte(`{"schemaVersion":2}`)
	_, err := NewTemporalDeliverer(&recordedSignalWithStartClient{}, DefaultTargetTaskQueue).Deliver(context.Background(), invalid)
	require.Error(t, err)
	require.True(t, isPermanent(err))

	unavailable := errors.New("temporal unavailable")
	recorded := &recordedSignalWithStartClient{err: unavailable}
	_, err = NewTemporalDeliverer(recorded, DefaultTargetTaskQueue).Deliver(context.Background(), *claimedTargetEvent(1))
	require.Error(t, err)
	require.False(t, isPermanent(err))
	require.ErrorIs(t, err, unavailable)
}

func TestTemporalDelivererRoutesRunEventsToRunWorkflow(t *testing.T) {
	event := OutboxEvent{
		ID: "run-event-1", WorkspaceID: testWorkspaceID, AggregateType: "run", AggregateID: testTargetID,
		EventType: RunAttemptChangedEventType,
		Payload:   []byte(`{"schemaVersion":1,"targetId":"` + testRevisionID + `","runId":"` + testTargetID + `","runAttemptId":"attempt-1","eventType":"run.event_started"}`),
	}
	recorded := &recordedSignalWithStartClient{run: fakeWorkflowRun{id: RunWorkflowID(testWorkspaceID, testTargetID), runID: "temporal-run-1"}}
	result, err := NewTemporalDeliverer(recorded, DefaultTargetTaskQueue).Deliver(context.Background(), event)
	require.NoError(t, err)
	require.Equal(t, RunWorkflowID(testWorkspaceID, testTargetID), result.WorkflowID)
	require.Equal(t, RunEventSignalName, recorded.signalName)
	require.Equal(t, RunWorkflowName, recorded.workflowType)
	require.Equal(t, RunEvent{
		SchemaVersion: SchemaVersion, EventID: event.ID, EventType: "run.event_started", WorkspaceID: testWorkspaceID,
		TargetID: testRevisionID, RunID: testTargetID, RunAttemptID: "attempt-1",
	}, recorded.signal)
}
