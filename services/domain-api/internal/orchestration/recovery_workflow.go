package orchestration

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/workflow"
)

func runRecoveryWorkflow(ctx workflow.Context, input RunWorkflowInput, continueAfter int, continueWorkflow interface{}) error {
	state := RunWorkflowState{SchemaVersion: SchemaVersion, WorkspaceID: input.WorkspaceID, RunID: input.RunID, Phase: "recovering"}
	if input.State != nil {
		state = *input.State
		if state.SchemaVersion != SchemaVersion || state.WorkspaceID != input.WorkspaceID || state.RunID != input.RunID {
			return fmt.Errorf("invalid carried recovery state")
		}
		state.EventsInRun = 0
	}
	if err := workflow.SetQueryHandler(ctx, RunStateQueryName, func() (RunWorkflowState, error) { return state, nil }); err != nil {
		return err
	}
	signals := workflow.GetSignalChannel(ctx, RunEventSignalName)
	for {
		for {
			var event RunEvent
			if !signals.ReceiveAsync(&event) {
				break
			}
			recordRecoverySignal(&state, event)
		}
		state.RecoveryCycle++
		activityCtx := workflow.WithActivityOptions(ctx, orchestrationActivityOptions(fmt.Sprintf("observe-recovery:%s:%d", input.RunID, state.RecoveryCycle)))
		var snapshot ObserveRunRecoveryActivityResult
		if err := workflow.ExecuteActivity(activityCtx, ObserveRunRecoveryActivityName, ObserveRunRecoveryActivityInput{SchemaVersion: SchemaVersion, WorkspaceID: input.WorkspaceID, RunID: input.RunID}).Get(ctx, &snapshot); err != nil {
			return err
		}
		if snapshot.SchemaVersion != SchemaVersion || snapshot.WorkspaceID != input.WorkspaceID || snapshot.RunID != input.RunID {
			return fmt.Errorf("recovery snapshot does not match Run identity")
		}
		state.TargetID, state.CurrentAttemptID = snapshot.TargetID, snapshot.RunAttemptID
		state.AttemptNumber, state.FencingToken = snapshot.AttemptNumber, snapshot.FencingToken
		state.LeaseID, state.RecoverAfter = snapshot.LeaseID, snapshot.RecoverAfter
		state.CancellationRequested = snapshot.RunStatus == "cancel_requested"
		switch snapshot.RunStatus {
		case "queued":
			state.Phase = "awaiting_executor"
			if snapshot.RunAttemptID == "" {
				state.Phase = "awaiting_attempt"
			}
		case "cancel_requested":
			state.Phase = "canceling"
		case "running", "failed", "succeeded", "canceled":
			state.Phase = snapshot.RunStatus
		default:
			return fmt.Errorf("invalid recovery Run status")
		}
		terminal := snapshot.RunStatus == "succeeded" || snapshot.RunStatus == "canceled"
		if terminal && !snapshot.PendingEvents {
			return nil
		}
		if state.EventsInRun >= continueAfter {
			next := state
			next.EventsInRun = 0
			return workflow.NewContinueAsNewError(ctx, continueWorkflow, RunWorkflowInput{SchemaVersion: SchemaVersion, WorkspaceID: input.WorkspaceID, RunID: input.RunID, Recovery: true, State: &next})
		}
		selector := workflow.NewSelector(ctx)
		waitCtx, cancelWait := workflow.WithCancel(ctx)
		selector.AddReceive(signals, func(channel workflow.ReceiveChannel, more bool) {
			if !more {
				return
			}
			var event RunEvent
			channel.Receive(ctx, &event)
			recordRecoverySignal(&state, event)
		})
		live := snapshot.RunStatus == "queued" || snapshot.RunStatus == "running" || snapshot.RunStatus == "cancel_requested"
		if live && snapshot.RunAttemptID != "" {
			if snapshot.RecoverAfter.IsZero() {
				return fmt.Errorf("active recovery Attempt has no lease deadline")
			}
			delay := snapshot.RecoverAfter.Sub(workflow.Now(ctx))
			if delay < time.Second {
				delay = time.Second
			}
			selector.AddFuture(workflow.NewTimer(waitCtx, delay), func(workflow.Future) {})
		} else if terminal && snapshot.PendingEvents {
			selector.AddFuture(workflow.NewTimer(waitCtx, time.Second), func(workflow.Future) {})
		}
		selector.Select(ctx)
		cancelWait()
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

func recordRecoverySignal(state *RunWorkflowState, event RunEvent) {
	if event.SchemaVersion != SchemaVersion || event.EventID == "" || event.WorkspaceID != state.WorkspaceID || event.RunID != state.RunID || !isRunEventType(event.EventType) || containsEventID(state.ProcessedEventIDs, event.EventID) {
		state.IgnoredEventCount++
		return
	}
	// A notification can request a fresh snapshot but cannot set the Run's phase.
	state.AcceptedEventCount++
	state.EventsInRun++
	state.LastEventID = event.EventID
	state.ProcessedEventIDs = append(state.ProcessedEventIDs, event.EventID)
	if len(state.ProcessedEventIDs) > maxRememberedEventIDs {
		state.ProcessedEventIDs = append([]string(nil), state.ProcessedEventIDs[len(state.ProcessedEventIDs)-maxRememberedEventIDs:]...)
	}
}
