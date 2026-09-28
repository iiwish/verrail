package orchestration

import (
	"fmt"
	"github.com/verrail/verrail/services/domain-api/internal/target"
	"time"
)

const (
	SchemaVersion                      = 1
	TargetCreatedEventType             = "verrail.target.created.v1"
	GraphActivatedEventType            = "verrail.graph.activated.v1"
	RunCreatedEventType                = "verrail.run.created.v1"
	RunAttemptChangedEventType         = "verrail.run.attempt_changed.v1"
	RunCancellationRequestedEventType  = "verrail.run.cancellation_requested.v1"
	TargetWorkflowName                 = "verrail.target.workflow.v1"
	RunWorkflowName                    = "verrail.run.workflow.v1"
	TargetEventSignalName              = "verrail.target.event.v1"
	RunEventSignalName                 = "verrail.run.event.v1"
	TargetStateQueryName               = "verrail.target.state.v1"
	RunStateQueryName                  = "verrail.run.state.v1"
	ReconcileTargetActivityName        = "verrail.target.reconcile-activity.v1"
	EnsureRunAttemptActivityName       = "verrail.run.ensure-attempt-activity.v1"
	ObserveRunRecoveryActivityName     = "verrail.run.observe-recovery-activity.v1"
	RequestRunCancellationActivityName = "verrail.run.request-cancellation-activity.v1"
	DefaultTargetTaskQueue             = "verrail-target-v1"
	DefaultContinueAfterEvent          = 256
	DefaultTargetPollInterval          = 30 * time.Second
	DefaultRunMaxAttempts              = 3
	maxRememberedEventIDs              = 512
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
	ReconcileCycle         int      `json:"reconcileCycle,omitempty"`
	ActiveRunIDs           []string `json:"activeRunIds,omitempty"`
	StartedRunIDs          []string `json:"startedRunIds,omitempty"`
	WaitingTaskNodeIDs     []string `json:"waitingTaskNodeIds,omitempty"`
	WaitingGateNodeIDs     []string `json:"waitingGateNodeIds,omitempty"`
	BlockedNodeIDs         []string `json:"blockedNodeIds,omitempty"`
	LastError              string   `json:"lastError,omitempty"`
}

type ReconcileTargetActivityInput struct {
	SchemaVersion    int    `json:"schemaVersion"`
	WorkspaceID      string `json:"workspaceId"`
	TargetID         string `json:"targetId"`
	TargetRevisionID string `json:"targetRevisionId"`
	GraphRevisionID  string `json:"graphRevisionId"`
	Cycle            int    `json:"cycle"`
}

type ScheduledAgentRun struct {
	RunID                string `json:"runId"`
	TargetID             string `json:"targetId"`
	TargetRevisionID     string `json:"targetRevisionId"`
	GraphRevisionID      string `json:"graphRevisionId"`
	WorkNodeID           string `json:"workNodeId"`
	DeploymentRevisionID string `json:"deploymentRevisionId"`
}

type ReconcileTargetActivityResult struct {
	SchemaVersion      int                 `json:"schemaVersion"`
	ActivatedNodeIDs   []string            `json:"activatedNodeIds"`
	ScheduledRuns      []ScheduledAgentRun `json:"scheduledRuns"`
	ActiveRunIDs       []string            `json:"activeRunIds"`
	WaitingTaskNodeIDs []string            `json:"waitingTaskNodeIds"`
	WaitingGateNodeIDs []string            `json:"waitingGateNodeIds"`
	BlockedNodeIDs     []string            `json:"blockedNodeIds"`
	AllCompleted       bool                `json:"allCompleted"`
}

type RunWorkflowInput struct {
	Recovery      bool              `json:"recovery,omitempty"`
	SchemaVersion int               `json:"schemaVersion"`
	WorkspaceID   string            `json:"workspaceId"`
	RunID         string            `json:"runId"`
	MaxAttempts   int               `json:"maxAttempts,omitempty"`
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
	RecoveryCycle         int       `json:"recoveryCycle,omitempty"`
	SchemaVersion         int       `json:"schemaVersion"`
	WorkspaceID           string    `json:"workspaceId"`
	RunID                 string    `json:"runId"`
	TargetID              string    `json:"targetId,omitempty"`
	CurrentAttemptID      string    `json:"currentAttemptId,omitempty"`
	Phase                 string    `json:"phase"`
	AcceptedEventCount    int       `json:"acceptedEventCount"`
	IgnoredEventCount     int       `json:"ignoredEventCount"`
	EventsInRun           int       `json:"eventsInRun"`
	LastEventID           string    `json:"lastEventId,omitempty"`
	ProcessedEventIDs     []string  `json:"processedEventIds,omitempty"`
	AttemptNumber         int       `json:"attemptNumber,omitempty"`
	RetryCount            int       `json:"retryCount,omitempty"`
	MaxAttempts           int       `json:"maxAttempts,omitempty"`
	LeaseID               string    `json:"leaseId,omitempty"`
	FencingToken          int64     `json:"fencingToken,omitempty"`
	RecoverAfter          time.Time `json:"recoverAfter,omitempty,omitzero"`
	CancellationRequested bool      `json:"cancellationRequested,omitempty"`
	LastError             string    `json:"lastError,omitempty"`
}

type EnsureRunAttemptActivityInput struct {
	SchemaVersion  int    `json:"schemaVersion"`
	WorkspaceID    string `json:"workspaceId"`
	RunID          string `json:"runId"`
	AttemptOrdinal int    `json:"attemptOrdinal"`
	MaxAttempts    int    `json:"maxAttempts"`
}

type EnsureRunAttemptActivityResult struct {
	SchemaVersion int       `json:"schemaVersion"`
	RunID         string    `json:"runId"`
	RunAttemptID  string    `json:"runAttemptId"`
	LeaseID       string    `json:"leaseId"`
	AttemptNumber int       `json:"attemptNumber"`
	FencingToken  int64     `json:"fencingToken"`
	RecoverAfter  time.Time `json:"recoverAfter"`
	Replayed      bool      `json:"replayed"`
}

type RequestRunCancellationActivityInput struct {
	SchemaVersion int    `json:"schemaVersion"`
	WorkspaceID   string `json:"workspaceId"`
	RunID         string `json:"runId"`
}

type ObserveRunRecoveryActivityInput struct {
	SchemaVersion int    `json:"schemaVersion"`
	WorkspaceID   string `json:"workspaceId"`
	RunID         string `json:"runId"`
}

type ObserveRunRecoveryActivityResult = target.RunRecoverySnapshot

func TargetWorkflowID(workspaceID, targetID string) string {
	return fmt.Sprintf("verrail-target-v1:%s:%s", workspaceID, targetID)
}

func RunWorkflowID(workspaceID, runID string) string {
	return fmt.Sprintf("verrail-run-v1:%s:%s", workspaceID, runID)
}

func TargetReconcileActivityID(graphRevisionID string, cycle int) string {
	return fmt.Sprintf("reconcile:%s:%d", graphRevisionID, cycle)
}

func RunAttemptActivityID(runID string, attemptOrdinal, recoveryCycle int) string {
	return fmt.Sprintf("ensure-attempt:%s:%d:%d", runID, attemptOrdinal, recoveryCycle)
}

func RunCancellationActivityID(runID string) string {
	return "request-cancel:" + runID
}
