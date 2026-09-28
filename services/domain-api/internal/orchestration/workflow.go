package orchestration

import (
	"fmt"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	activeTargetOrchestrationChangeID = "active-target-orchestration"
	activeRunOrchestrationChangeID    = "active-run-orchestration"
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
		if state.ActiveGraphRevisionID == "" {
			var event TargetEvent
			if more := signals.Receive(ctx, &event); !more {
				return ctx.Err()
			}
			applyTargetEvent(&state, event)
			if state.EventsInRun >= continueAfter {
				return continueTargetWorkflow(ctx, input, &state, signals, continueWorkflow)
			}
			continue
		}

		if workflow.GetVersion(ctx, activeTargetOrchestrationChangeID, workflow.DefaultVersion, 1) == workflow.DefaultVersion {
			return runLegacyTargetWorkflow(ctx, input, &state, signals, continueAfter, continueWorkflow)
		}
		state.ReconcileCycle++
		activityCtx := workflow.WithActivityOptions(ctx, orchestrationActivityOptions(TargetReconcileActivityID(state.ActiveGraphRevisionID, state.ReconcileCycle)))
		var reconciled ReconcileTargetActivityResult
		err := workflow.ExecuteActivity(activityCtx, ReconcileTargetActivityName, ReconcileTargetActivityInput{
			SchemaVersion:    SchemaVersion,
			WorkspaceID:      input.WorkspaceID,
			TargetID:         input.TargetID,
			TargetRevisionID: state.ActiveTargetRevisionID,
			GraphRevisionID:  state.ActiveGraphRevisionID,
			Cycle:            state.ReconcileCycle,
		}).Get(ctx, &reconciled)
		if err != nil {
			state.LastError = err.Error()
		} else {
			state.LastError = ""
			state.ActiveRunIDs = append([]string(nil), reconciled.ActiveRunIDs...)
			state.WaitingTaskNodeIDs = append([]string(nil), reconciled.WaitingTaskNodeIDs...)
			state.WaitingGateNodeIDs = append([]string(nil), reconciled.WaitingGateNodeIDs...)
			state.BlockedNodeIDs = append([]string(nil), reconciled.BlockedNodeIDs...)
			state.StartedRunIDs = retainStrings(state.StartedRunIDs, state.ActiveRunIDs)
			for _, run := range reconciled.ScheduledRuns {
				if containsEventID(state.StartedRunIDs, run.RunID) {
					continue
				}
				childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
					WorkflowID:            RunWorkflowID(input.WorkspaceID, run.RunID),
					ParentClosePolicy:     enumspb.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
					WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
				})
				child := workflow.ExecuteChildWorkflow(childCtx, RunWorkflowName, RunWorkflowInput{
					SchemaVersion: SchemaVersion,
					WorkspaceID:   input.WorkspaceID,
					RunID:         run.RunID,
					MaxAttempts:   DefaultRunMaxAttempts,
				})
				var execution workflow.Execution
				if startErr := child.GetChildWorkflowExecution().Get(ctx, &execution); startErr != nil {
					state.LastError = startErr.Error()
				} else {
					state.StartedRunIDs = append(state.StartedRunIDs, run.RunID)
				}
			}
			if reconciled.AllCompleted {
				state.Phase = "completed"
				return nil
			}
			state.Phase = "orchestrating"
		}
		if state.EventsInRun >= continueAfter && len(state.ActiveRunIDs) == 0 {
			return continueTargetWorkflow(ctx, input, &state, signals, continueWorkflow)
		}

		selector := workflow.NewSelector(ctx)
		selector.AddReceive(signals, func(channel workflow.ReceiveChannel, more bool) {
			if !more {
				return
			}
			var event TargetEvent
			channel.Receive(ctx, &event)
			applyTargetEvent(&state, event)
		})
		selector.AddFuture(workflow.NewTimer(ctx, DefaultTargetPollInterval), func(workflow.Future) {})
		selector.Select(ctx)
	}
}

func runLegacyTargetWorkflow(ctx workflow.Context, input TargetWorkflowInput, state *TargetWorkflowState, signals workflow.ReceiveChannel, continueAfter int, continueWorkflow interface{}) error {
	if state.EventsInRun >= continueAfter {
		return continueTargetWorkflow(ctx, input, state, signals, continueWorkflow)
	}
	for {
		var event TargetEvent
		if more := signals.Receive(ctx, &event); !more {
			return ctx.Err()
		}
		if !applyTargetEvent(state, event) {
			continue
		}
		if state.EventsInRun >= continueAfter {
			return continueTargetWorkflow(ctx, input, state, signals, continueWorkflow)
		}
	}
}

func continueTargetWorkflow(ctx workflow.Context, input TargetWorkflowInput, state *TargetWorkflowState, signals workflow.ReceiveChannel, continueWorkflow interface{}) error {
	for {
		var pending TargetEvent
		if !signals.ReceiveAsync(&pending) {
			break
		}
		applyTargetEvent(state, pending)
	}
	next := *state
	next.EventsInRun = 0
	return workflow.NewContinueAsNewError(ctx, continueWorkflow, TargetWorkflowInput{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   input.WorkspaceID,
		TargetID:      input.TargetID,
		State:         &next,
	})
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
		state.ReconcileCycle = 0
		state.ActiveRunIDs = nil
		state.StartedRunIDs = nil
		state.WaitingTaskNodeIDs = nil
		state.WaitingGateNodeIDs = nil
		state.BlockedNodeIDs = nil
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
	if input.Recovery {
		return runRecoveryWorkflow(ctx, input, continueAfter, continueWorkflow)
	}
	state := RunWorkflowState{
		SchemaVersion: SchemaVersion,
		WorkspaceID:   input.WorkspaceID,
		RunID:         input.RunID,
		Phase:         "awaiting_attempt",
		MaxAttempts:   input.MaxAttempts,
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
	if workflow.GetVersion(ctx, activeRunOrchestrationChangeID, workflow.DefaultVersion, 1) == workflow.DefaultVersion {
		return runLegacyRunWorkflow(ctx, input, &state, signals, continueAfter, continueWorkflow)
	}
	if state.MaxAttempts < 1 {
		state.MaxAttempts = DefaultRunMaxAttempts
	}
	completed, continuing := false, false
	defer func() {
		if completed || continuing || state.AttemptNumber == 0 {
			return
		}
		disconnected, _ := workflow.NewDisconnectedContext(ctx)
		cancelCtx := workflow.WithActivityOptions(disconnected, orchestrationActivityOptions(RunCancellationActivityID(input.RunID)))
		_ = workflow.ExecuteActivity(cancelCtx, RequestRunCancellationActivityName, RequestRunCancellationActivityInput{
			SchemaVersion: SchemaVersion,
			WorkspaceID:   input.WorkspaceID,
			RunID:         input.RunID,
		}).Get(disconnected, nil)
	}()
	for {
		if state.AttemptNumber == 0 || state.Phase == "recovering" {
			ordinal := state.AttemptNumber + 1
			activityCtx := workflow.WithActivityOptions(ctx, orchestrationActivityOptions(RunAttemptActivityID(input.RunID, ordinal, state.RetryCount)))
			var attempt EnsureRunAttemptActivityResult
			if err := workflow.ExecuteActivity(activityCtx, EnsureRunAttemptActivityName, EnsureRunAttemptActivityInput{
				SchemaVersion:  SchemaVersion,
				WorkspaceID:    input.WorkspaceID,
				RunID:          input.RunID,
				AttemptOrdinal: ordinal,
				MaxAttempts:    state.MaxAttempts,
			}).Get(ctx, &attempt); err != nil {
				state.LastError = err.Error()
				return err
			}
			state.AttemptNumber = attempt.AttemptNumber
			state.CurrentAttemptID = attempt.RunAttemptID
			state.LeaseID = attempt.LeaseID
			state.FencingToken = attempt.FencingToken
			state.RecoverAfter = attempt.RecoverAfter
			state.Phase = "awaiting_executor"
			state.LastError = ""
		}
		if state.Phase == "succeeded" || state.Phase == "canceled" {
			completed = true
			return nil
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
			continuing = true
			return workflow.NewContinueAsNewError(ctx, continueWorkflow, RunWorkflowInput{
				SchemaVersion: SchemaVersion,
				WorkspaceID:   input.WorkspaceID,
				RunID:         input.RunID,
				MaxAttempts:   state.MaxAttempts,
				State:         &next,
			})
		}

		selector := workflow.NewSelector(ctx)
		selector.AddReceive(signals, func(channel workflow.ReceiveChannel, more bool) {
			if !more {
				return
			}
			var event RunEvent
			channel.Receive(ctx, &event)
			applyRunEvent(&state, event)
		})
		if state.Phase == "canceling" {
			selector.AddFuture(workflow.NewTimer(ctx, DefaultTargetPollInterval), func(workflow.Future) {})
		} else {
			delay := state.RecoverAfter.Sub(workflow.Now(ctx))
			if delay < 0 {
				delay = 0
			}
			selector.AddFuture(workflow.NewTimer(ctx, delay), func(workflow.Future) {
				if state.Phase != "succeeded" && state.Phase != "canceled" && state.Phase != "canceling" {
					state.Phase = "recovering"
					state.RetryCount++
				}
			})
		}
		selector.Select(ctx)
		if state.Phase == "failed" {
			if state.AttemptNumber >= state.MaxAttempts {
				return temporal.NewNonRetryableApplicationError("Run attempts exhausted", "RUN_ATTEMPTS_EXHAUSTED", nil)
			}
			state.Phase = "recovering"
			state.RetryCount++
		}
	}
}

func runLegacyRunWorkflow(ctx workflow.Context, input RunWorkflowInput, state *RunWorkflowState, signals workflow.ReceiveChannel, continueAfter int, continueWorkflow interface{}) error {
	for {
		var event RunEvent
		if more := signals.Receive(ctx, &event); !more {
			return ctx.Err()
		}
		if !applyLegacyRunEvent(state, event) {
			continue
		}
		if state.EventsInRun < continueAfter {
			continue
		}
		for {
			var pending RunEvent
			if !signals.ReceiveAsync(&pending) {
				break
			}
			applyLegacyRunEvent(state, pending)
		}
		next := *state
		next.EventsInRun = 0
		return workflow.NewContinueAsNewError(ctx, continueWorkflow, RunWorkflowInput{
			SchemaVersion: SchemaVersion,
			WorkspaceID:   input.WorkspaceID,
			RunID:         input.RunID,
			State:         &next,
		})
	}
}

func applyLegacyRunEvent(state *RunWorkflowState, event RunEvent) bool {
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
	if event.EventType != RunCreatedEventType && state.CurrentAttemptID != "" && event.RunAttemptID != state.CurrentAttemptID {
		state.IgnoredEventCount++
		return false
	}
	state.TargetID = event.TargetID
	if event.RunAttemptID != "" {
		state.CurrentAttemptID = event.RunAttemptID
	}
	switch event.EventType {
	case RunCreatedEventType:
		if state.AttemptNumber == 0 {
			state.Phase = "awaiting_attempt"
		}
	case RunCancellationRequestedEventType:
		state.Phase = "canceling"
		state.CancellationRequested = true
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

func orchestrationActivityOptions(activityID string) workflow.ActivityOptions {
	return workflow.ActivityOptions{
		ActivityID:             activityID,
		ScheduleToCloseTimeout: 2 * time.Minute,
		StartToCloseTimeout:    30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    5,
		},
	}
}

func retainStrings(values, allowed []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if containsEventID(allowed, value) {
			result = append(result, value)
		}
	}
	return result
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
