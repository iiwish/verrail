package orchestration

import (
	"fmt"
	"time"
)

const (
	SchemaVersion                     = 1
	TargetCreatedEventType            = "verrail.target.created.v1"
	GraphActivatedEventType           = "verrail.graph.activated.v1"
	RunCreatedEventType               = "verrail.run.created.v1"
	RunAttemptChangedEventType        = "verrail.run.attempt_changed.v1"
	RunCancellationRequestedEventType = "verrail.run.cancellation_requested.v1"
	TargetWorkflowName                = "verrail.target.workflow.v1"
	RunWorkflowName                   = "verrail.run.workflow.v1"
	TargetEventSignalName             = "verrail.target.event.v1"
	RunEventSignalName                = "verrail.run.event.v1"
	TargetStateQueryName              = "verrail.target.state.v1"
	RunStateQueryName                 = "verrail.run.state.v1"
	DefaultTargetTaskQueue            = "verrail-target-v1"
	DefaultContinueAfterEvent         = 256
	maxRememberedEventIDs             = 512
)

type TargetWorkflowInput struct {
	SchemaVersion int                  `json:"schemaVersion"`
	WorkspaceID   string               `json:"workspaceId"`
	TargetID      string               `json:"targetId"`
	State         *TargetWorkflowState `json:"state,omitempty"`
}

type TargetEvent struct {
	SchemaVersion    int       `json:"schemaVersion"`
	EventID          string    `json:"eventId"`
	EventType        string    `json:"eventType"`
	WorkspaceID      string    `json:"workspaceId"`
	TargetID         string    `json:"targetId"`
	TargetRevisionID string    `json:"targetRevisionId"`
	GraphRevisionID  string    `json:"graphRevisionId,omitempty"`
	OccurredAt       time.Time `json:"occurredAt"`
}

type TargetWorkflowState struct {
	SchemaVersion          int      `json:"schemaVersion"`
	WorkspaceID            string   `json:"workspaceId"`
	TargetID               string   `json:"targetId"`
	Phase                  string   `json:"phase"`
	AcceptedEventCount     int      `json:"acceptedEventCount"`
	IgnoredEventCount      int      `json:"ignoredEventCount"`
	EventsInRun            int      `json:"eventsInRun"`
	LastEventID            string   `json:"lastEventId,omitempty"`
	ActiveTargetRevisionID string   `json:"activeTargetRevisionId,omitempty"`
	ActiveGraphRevisionID  string   `json:"activeGraphRevisionId,omitempty"`
	ProcessedEventIDs      []string `json:"processedEventIds,omitempty"`
}

type RunWorkflowInput struct {
	SchemaVersion int               `json:"schemaVersion"`
	WorkspaceID   string            `json:"workspaceId"`
	RunID         string            `json:"runId"`
	State         *RunWorkflowState `json:"state,omitempty"`
}

type RunEvent struct {
	SchemaVersion int       `json:"schemaVersion"`
	EventID       string    `json:"eventId"`
	EventType     string    `json:"eventType"`
	WorkspaceID   string    `json:"workspaceId"`
	TargetID      string    `json:"targetId"`
	RunID         string    `json:"runId"`
	RunAttemptID  string    `json:"runAttemptId,omitempty"`
	OccurredAt    time.Time `json:"occurredAt"`
}

type RunWorkflowState struct {
	SchemaVersion      int      `json:"schemaVersion"`
	WorkspaceID        string   `json:"workspaceId"`
	RunID              string   `json:"runId"`
	TargetID           string   `json:"targetId,omitempty"`
	CurrentAttemptID   string   `json:"currentAttemptId,omitempty"`
	Phase              string   `json:"phase"`
	AcceptedEventCount int      `json:"acceptedEventCount"`
	IgnoredEventCount  int      `json:"ignoredEventCount"`
	EventsInRun        int      `json:"eventsInRun"`
	LastEventID        string   `json:"lastEventId,omitempty"`
	ProcessedEventIDs  []string `json:"processedEventIds,omitempty"`
}

func TargetWorkflowID(workspaceID, targetID string) string {
	return fmt.Sprintf("verrail-target-v1:%s:%s", workspaceID, targetID)
}

func RunWorkflowID(workspaceID, runID string) string {
	return fmt.Sprintf("verrail-run-v1:%s:%s", workspaceID, runID)
}
