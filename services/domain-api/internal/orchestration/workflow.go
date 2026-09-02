package orchestration

import (
	"fmt"

	"go.temporal.io/sdk/workflow"
)

func TargetWorkflow(ctx workflow.Context, input TargetWorkflowInput) error {
	return runTargetWorkflow(ctx, input, DefaultContinueAfterEvent, TargetWorkflowName)
}

func RunWorkflow(ctx workflow.Context, input RunWorkflowInput) error {
	return runRunWorkflow(ctx, input, DefaultContinueAfterEvent, RunWorkflowName)
}

func runTargetWorkflow(ctx workflow.Context, input TargetWorkflowInput, continueAfter int, continueWorkflow interface{}) error {
	if input.SchemaVersion != SchemaVersion || input.WorkspaceID == "" || input.TargetID == "" {
		return fmt.Errorf("invalid TargetWorkflow input")
	}
	if continueAfter < 1 {
		return fmt.Errorf("continue-after threshold must be positive")
	}

	state := TargetWorkflowState{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   input.WorkspaceID,
		TargetID:      input.TargetID,
		Phase:         "waiting_for_target_event",
	}
	if input.State != nil {
		state = *input.State
		if state.SchemaVersion != SchemaVersion || state.WorkspaceID != input.WorkspaceID || state.TargetID != input.TargetID {
			return fmt.Errorf("invalid carried TargetWorkflow state")
		}
		state.EventsInRun = 0
	}

	if err := workflow.SetQueryHandler(ctx, TargetStateQueryName, func() (TargetWorkflowState, error) {
		return state, nil
	}); err != nil {
		return fmt.Errorf("register Target state query: %w", err)
	}

	signals := workflow.GetSignalChannel(ctx, TargetEventSignalName)
	for {
		var event TargetEvent
		if more := signals.Receive(ctx, &event); !more {
			return ctx.Err()
		}
		if !applyTargetEvent(&state, event) {
			continue
		}
		if state.EventsInRun >= continueAfter {
			for {
				var pending TargetEvent
				if !signals.ReceiveAsync(&pending) {
					break
				}
				applyTargetEvent(&state, pending)
			}
			next := state
			next.EventsInRun = 0
			return workflow.NewContinueAsNewError(ctx, continueWorkflow, TargetWorkflowInput{
				SchemaVersion: SchemaVersion,
				WorkspaceID:   input.WorkspaceID,
				TargetID:      input.TargetID,
				State:         &next,
			})
		}
	}
}

func applyTargetEvent(state *TargetWorkflowState, event TargetEvent) bool {
	if event.SchemaVersion != SchemaVersion ||
		event.EventID == "" ||
		(event.EventType != TargetCreatedEventType && event.EventType != GraphActivatedEventType) ||
		event.WorkspaceID != state.WorkspaceID ||
		event.TargetID != state.TargetID ||
		event.TargetRevisionID == "" ||
		containsEventID(state.ProcessedEventIDs, event.EventID) {
		state.IgnoredEventCount++
		return false
	}

	if event.EventType == GraphActivatedEventType {
		if event.GraphRevisionID == "" {
			state.IgnoredEventCount++
			return false
		}
		state.Phase = "orchestrating"
		state.ActiveGraphRevisionID = event.GraphRevisionID
	} else {
		state.Phase = "awaiting_graph"
	}
	state.AcceptedEventCount++
	state.EventsInRun++
	state.LastEventID = event.EventID
	state.ActiveTargetRevisionID = event.TargetRevisionID
	state.ProcessedEventIDs = append(state.ProcessedEventIDs, event.EventID)
	if len(state.ProcessedEventIDs) > maxRememberedEventIDs {
		state.ProcessedEventIDs = append([]string(nil), state.ProcessedEventIDs[len(state.ProcessedEventIDs)-maxRememberedEventIDs:]...)
	}
	return true
}

func runRunWorkflow(ctx workflow.Context, input RunWorkflowInput, continueAfter int, continueWorkflow interface{}) error {
	if input.SchemaVersion != SchemaVersion || input.WorkspaceID == "" || input.RunID == "" {
		return fmt.Errorf("invalid RunWorkflow input")
	}
	if continueAfter < 1 {
		return fmt.Errorf("continue-after threshold must be positive")
	}
	state := RunWorkflowState{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   input.WorkspaceID,
		RunID:         input.RunID,
		Phase:         "awaiting_attempt",
	}
	if input.State != nil {
		state = *input.State
		if state.SchemaVersion != SchemaVersion || state.WorkspaceID != input.WorkspaceID || state.RunID != input.RunID {
			return fmt.Errorf("invalid carried RunWorkflow state")
		}
		state.EventsInRun = 0
	}
	if err := workflow.SetQueryHandler(ctx, RunStateQueryName, func() (RunWorkflowState, error) {
		return state, nil
	}); err != nil {
		return fmt.Errorf("register Run state query: %w", err)
	}
	signals := workflow.GetSignalChannel(ctx, RunEventSignalName)
	for {
		var event RunEvent
		if more := signals.Receive(ctx, &event); !more {
			return ctx.Err()
		}
		if !applyRunEvent(&state, event) {
			continue
		}
		if state.EventsInRun >= continueAfter {
			for {
				var pending RunEvent
				if !signals.ReceiveAsync(&pending) {
					break
				}
				applyRunEvent(&state, pending)
			}
			next := state
			next.EventsInRun = 0
			return workflow.NewContinueAsNewError(ctx, continueWorkflow, RunWorkflowInput{
				SchemaVersion: SchemaVersion,
				WorkspaceID:   input.WorkspaceID,
				RunID:         input.RunID,
				State:         &next,
			})
		}
	}
}

func applyRunEvent(state *RunWorkflowState, event RunEvent) bool {
	if event.SchemaVersion != SchemaVersion || event.EventID == "" ||
		event.WorkspaceID != state.WorkspaceID || event.RunID != state.RunID ||
		!isRunEventType(event.EventType) || containsEventID(state.ProcessedEventIDs, event.EventID) {
		state.IgnoredEventCount++
		return false
	}
	if event.EventType != RunCreatedEventType && event.RunAttemptID == "" {
		state.IgnoredEventCount++
		return false
	}
	state.TargetID = event.TargetID
	if event.RunAttemptID != "" {
		state.CurrentAttemptID = event.RunAttemptID
	}
	switch event.EventType {
	case RunCreatedEventType:
		state.Phase = "awaiting_attempt"
	case RunCancellationRequestedEventType:
		state.Phase = "canceling"
	default:
		switch event.EventType {
		case "run.attempt_created":
			state.Phase = "awaiting_executor"
		case "run.event_succeeded":
			state.Phase = "succeeded"
		case "run.event_failed", "run.event_rejected_expired_lease":
			state.Phase = "failed"
		case "run.event_terminated":
			state.Phase = "canceled"
		default:
			state.Phase = "running"
		}
	}
	state.AcceptedEventCount++
	state.EventsInRun++
	state.LastEventID = event.EventID
	state.ProcessedEventIDs = append(state.ProcessedEventIDs, event.EventID)
	if len(state.ProcessedEventIDs) > maxRememberedEventIDs {
		state.ProcessedEventIDs = append([]string(nil), state.ProcessedEventIDs[len(state.ProcessedEventIDs)-maxRememberedEventIDs:]...)
	}
	return true
}

func isRunEventType(eventType string) bool {
	switch eventType {
	case RunCreatedEventType, RunCancellationRequestedEventType,
		"run.attempt_created", "run.event_claimed", "run.event_heartbeat", "run.event_started",
		"run.event_progress", "run.event_succeeded", "run.event_failed",
		"run.event_cancel_acknowledged", "run.event_terminated", "run.event_rejected_expired_lease":
		return true
	default:
		return false
	}
}

func containsEventID(eventIDs []string, candidate string) bool {
	for _, eventID := range eventIDs {
		if eventID == candidate {
			return true
		}
	}
	return false
}
