package orchestration

import (
	"fmt"

	"go.temporal.io/sdk/workflow"
)

func TargetWorkflow(ctx workflow.Context, input TargetWorkflowInput) error {
	return runTargetWorkflow(ctx, input, DefaultContinueAfterEvent, TargetWorkflowName)
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
		event.EventType != TargetCreatedEventType ||
		event.WorkspaceID != state.WorkspaceID ||
		event.TargetID != state.TargetID ||
		event.TargetRevisionID == "" ||
		containsEventID(state.ProcessedEventIDs, event.EventID) {
		state.IgnoredEventCount++
		return false
	}

	state.Phase = "awaiting_graph"
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

func containsEventID(eventIDs []string, candidate string) bool {
	for _, eventID := range eventIDs {
		if eventID == candidate {
			return true
		}
	}
	return false
}
