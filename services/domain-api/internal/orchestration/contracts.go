package orchestration

import (
	"fmt"
	"time"
)

const (
	SchemaVersion             = 1
	TargetCreatedEventType    = "verrail.target.created.v1"
	TargetWorkflowName        = "verrail.target.workflow.v1"
	TargetEventSignalName     = "verrail.target.event.v1"
	TargetStateQueryName      = "verrail.target.state.v1"
	DefaultTargetTaskQueue    = "verrail-target-v1"
	DefaultContinueAfterEvent = 256
	maxRememberedEventIDs     = 512
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
	ProcessedEventIDs      []string `json:"processedEventIds,omitempty"`
}

func TargetWorkflowID(workspaceID, targetID string) string {
	return fmt.Sprintf("verrail-target-v1:%s:%s", workspaceID, targetID)
}
