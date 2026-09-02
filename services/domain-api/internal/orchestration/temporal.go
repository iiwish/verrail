package orchestration

import (
	"context"
	"encoding/json"
	"fmt"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"
)

type signalWithStartClient interface {
	SignalWithStartWorkflow(
		context.Context,
		string,
		string,
		interface{},
		client.StartWorkflowOptions,
		interface{},
		...interface{},
	) (client.WorkflowRun, error)
}

type TemporalDeliverer struct {
	client    signalWithStartClient
	taskQueue string
}

func NewTemporalDeliverer(temporalClient signalWithStartClient, taskQueue string) *TemporalDeliverer {
	return &TemporalDeliverer{client: temporalClient, taskQueue: taskQueue}
}

func (deliverer *TemporalDeliverer) Deliver(ctx context.Context, event OutboxEvent) (DeliveryResult, error) {
	switch event.AggregateType {
	case "target":
		return deliverer.deliverTarget(ctx, event)
	case "run":
		return deliverer.deliverRun(ctx, event)
	default:
		return DeliveryResult{}, Permanent(fmt.Errorf("invalid outbox aggregate identity"))
	}
}

func (deliverer *TemporalDeliverer) deliverTarget(ctx context.Context, event OutboxEvent) (DeliveryResult, error) {
	if event.AggregateID == "" || event.WorkspaceID == "" {
		return DeliveryResult{}, Permanent(fmt.Errorf("invalid Target outbox aggregate identity"))
	}
	var payload struct {
		SchemaVersion    int    `json:"schemaVersion"`
		TargetID         string `json:"targetId"`
		TargetRevisionID string `json:"targetRevisionId"`
		GraphRevisionID  string `json:"graphRevisionId"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return DeliveryResult{}, Permanent(fmt.Errorf("decode Target outbox payload: %w", err))
	}
	if payload.SchemaVersion != SchemaVersion || payload.TargetID != event.AggregateID || payload.TargetRevisionID == "" {
		return DeliveryResult{}, Permanent(fmt.Errorf("Target outbox payload does not match its aggregate"))
	}

	workflowID := TargetWorkflowID(event.WorkspaceID, event.AggregateID)
	signal := TargetEvent{
		SchemaVersion:    SchemaVersion,
		EventID:          event.ID,
		EventType:        event.EventType,
		WorkspaceID:      event.WorkspaceID,
		TargetID:         event.AggregateID,
		TargetRevisionID: payload.TargetRevisionID,
		GraphRevisionID:  payload.GraphRevisionID,
		OccurredAt:       event.CreatedAt,
	}
	input := TargetWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   event.WorkspaceID,
		TargetID:      event.AggregateID,
	}
	run, err := deliverer.client.SignalWithStartWorkflow(
		ctx,
		workflowID,
		TargetEventSignalName,
		signal,
		client.StartWorkflowOptions{
			ID:                       workflowID,
			TaskQueue:                deliverer.taskQueue,
			WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
			WorkflowIDReusePolicy:    enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
			Memo: map[string]interface{}{
				"schemaVersion": SchemaVersion,
				"workspaceId":   event.WorkspaceID,
				"targetId":      event.AggregateID,
			},
		},
		TargetWorkflowName,
		input,
	)
	if err != nil {
		return DeliveryResult{}, fmt.Errorf("signal TargetWorkflow: %w", err)
	}
	return DeliveryResult{WorkflowID: run.GetID(), RunID: run.GetRunID()}, nil
}

func (deliverer *TemporalDeliverer) deliverRun(ctx context.Context, event OutboxEvent) (DeliveryResult, error) {
	if event.AggregateID == "" || event.WorkspaceID == "" {
		return DeliveryResult{}, Permanent(fmt.Errorf("invalid Run outbox aggregate identity"))
	}
	var payload struct {
		SchemaVersion int    `json:"schemaVersion"`
		TargetID      string `json:"targetId"`
		RunID         string `json:"runId"`
		RunAttemptID  string `json:"runAttemptId"`
		EventType     string `json:"eventType"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		return DeliveryResult{}, Permanent(fmt.Errorf("decode Run outbox payload: %w", err))
	}
	if payload.SchemaVersion != SchemaVersion || payload.RunID != event.AggregateID || payload.TargetID == "" {
		return DeliveryResult{}, Permanent(fmt.Errorf("Run outbox payload does not match its aggregate"))
	}
	eventType := event.EventType
	if payload.EventType != "" {
		eventType = payload.EventType
	}
	if !isRunEventType(eventType) {
		return DeliveryResult{}, Permanent(fmt.Errorf("unsupported Run event type: %s", eventType))
	}
	workflowID := RunWorkflowID(event.WorkspaceID, event.AggregateID)
	signal := RunEvent{
		SchemaVersion: SchemaVersion,
		EventID:       event.ID,
		EventType:     eventType,
		WorkspaceID:   event.WorkspaceID,
		TargetID:      payload.TargetID,
		RunID:         event.AggregateID,
		RunAttemptID:  payload.RunAttemptID,
		OccurredAt:    event.CreatedAt,
	}
	input := RunWorkflowInput{SchemaVersion: SchemaVersion, WorkspaceID: event.WorkspaceID, RunID: event.AggregateID}
	run, err := deliverer.client.SignalWithStartWorkflow(
		ctx,
		workflowID,
		RunEventSignalName,
		signal,
		client.StartWorkflowOptions{
			ID:                       workflowID,
			TaskQueue:                deliverer.taskQueue,
			WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
			WorkflowIDReusePolicy:    enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
			Memo: map[string]interface{}{
				"schemaVersion": SchemaVersion,
				"workspaceId":   event.WorkspaceID,
				"runId":         event.AggregateID,
			},
		},
		RunWorkflowName,
		input,
	)
	if err != nil {
		return DeliveryResult{}, fmt.Errorf("signal RunWorkflow: %w", err)
	}
	return DeliveryResult{WorkflowID: run.GetID(), RunID: run.GetRunID()}, nil
}
