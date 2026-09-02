package target

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const ExecutionSchemaVersion = 1

type ExecutorPrincipal struct {
	PrincipalType string `json:"principalType"`
	PrincipalID   string `json:"principalId"`
}

type CreateRunAttemptInput struct {
	RuntimeProfile       string            `json:"runtimeProfile"`
	Executor             ExecutorPrincipal `json:"executor"`
	LeaseDurationSeconds int               `json:"leaseDurationSeconds,omitempty"`
	GraceDurationSeconds int               `json:"graceDurationSeconds,omitempty"`
}

type CreateRunAttemptCommand struct {
	WorkspaceID, RunID, IdempotencyKey, RequestHash string
	Principal                                       Principal
	Input                                           CreateRunAttemptInput
}

type CreateRunAttemptResult struct {
	SchemaVersion int    `json:"schemaVersion"`
	RunID         string `json:"runId"`
	RunAttemptID  string `json:"runAttemptId"`
	LeaseID       string `json:"leaseId"`
	AttemptNumber int    `json:"attemptNumber"`
	FencingToken  int64  `json:"fencingToken"`
	Status        string `json:"status"`
	LeaseStatus   string `json:"leaseStatus"`
	ExpiresAt     string `json:"expiresAt"`
	Replayed      bool   `json:"replayed"`
}

type ReportRunEventInput struct {
	LeaseID            string         `json:"leaseId"`
	FencingToken       int64          `json:"fencingToken"`
	Cursor             int64          `json:"cursor"`
	EventType          string         `json:"eventType"`
	EmittedAt          time.Time      `json:"emittedAt"`
	Payload            map[string]any `json:"payload,omitempty"`
	ExtendLeaseSeconds int            `json:"extendLeaseSeconds,omitempty"`
}

type ReportRunEventCommand struct {
	WorkspaceID, RunID, RunAttemptID, IdempotencyKey, RequestHash string
	Principal                                                     Principal
	Input                                                         ReportRunEventInput
}

type ReportRunEventResult struct {
	SchemaVersion int     `json:"schemaVersion"`
	RunID         string  `json:"runId"`
	RunAttemptID  string  `json:"runAttemptId"`
	Cursor        int64   `json:"cursor"`
	EventType     string  `json:"eventType"`
	Authoritative bool    `json:"authoritative"`
	RejectionCode *string `json:"rejectionCode"`
	RunStatus     string  `json:"runStatus"`
	AttemptStatus string  `json:"attemptStatus"`
	LeaseStatus   string  `json:"leaseStatus"`
	Replayed      bool    `json:"replayed"`
}

type RequestRunCancellationCommand struct {
	WorkspaceID, RunID, IdempotencyKey, RequestHash string
	Principal                                       Principal
}

type RequestRunCancellationResult struct {
	SchemaVersion int    `json:"schemaVersion"`
	RunID         string `json:"runId"`
	RunAttemptID  string `json:"runAttemptId"`
	RunStatus     string `json:"runStatus"`
	AttemptStatus string `json:"attemptStatus"`
	Replayed      bool   `json:"replayed"`
}

func hashExecutionInput(input any) (string, error) {
	payload, err := json.Marshal(input)
	if err != nil {
		return "", fmt.Errorf("marshal execution command: %w", err)
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
}

func ValidateCreateRunAttemptCommand(command *CreateRunAttemptCommand) error {
	command.WorkspaceID, command.RunID = strings.TrimSpace(command.WorkspaceID), strings.TrimSpace(command.RunID)
	command.Principal.Type, command.Principal.ID = strings.TrimSpace(command.Principal.Type), strings.TrimSpace(command.Principal.ID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	if err := validateCommandIdentity(command.WorkspaceID, command.RunID, command.Principal, command.IdempotencyKey); err != nil {
		return err
	}
	if command.Input.RuntimeProfile != "host_trusted" {
		return validation("G2.2 supports only the host_trusted RuntimeProfile")
	}
	command.Input.Executor.PrincipalType = strings.TrimSpace(command.Input.Executor.PrincipalType)
	command.Input.Executor.PrincipalID = strings.TrimSpace(command.Input.Executor.PrincipalID)
	if command.Input.Executor.PrincipalType != "service" || command.Input.Executor.PrincipalID == "" || len(command.Input.Executor.PrincipalID) > 200 {
		return validation("executor must be a bounded service Principal")
	}
	if command.Input.LeaseDurationSeconds == 0 {
		command.Input.LeaseDurationSeconds = 120
	}
	if command.Input.GraceDurationSeconds == 0 {
		command.Input.GraceDurationSeconds = 30
	}
	if command.Input.LeaseDurationSeconds < 15 || command.Input.LeaseDurationSeconds > 3600 || command.Input.GraceDurationSeconds < 0 || command.Input.GraceDurationSeconds > 600 {
		return validation("lease or grace duration is outside the allowed range")
	}
	hash, err := hashExecutionInput(command.Input)
	command.RequestHash = hash
	return err
}

func ValidateReportRunEventCommand(command *ReportRunEventCommand) error {
	command.WorkspaceID, command.RunID, command.RunAttemptID = strings.TrimSpace(command.WorkspaceID), strings.TrimSpace(command.RunID), strings.TrimSpace(command.RunAttemptID)
	command.Principal.Type, command.Principal.ID = strings.TrimSpace(command.Principal.Type), strings.TrimSpace(command.Principal.ID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	if !uuidPattern.MatchString(command.WorkspaceID) || !uuidPattern.MatchString(command.RunID) || !uuidPattern.MatchString(command.RunAttemptID) || !uuidPattern.MatchString(strings.TrimSpace(command.Input.LeaseID)) {
		return validation("execution resource IDs must be UUIDs")
	}
	if command.Principal.Type != "service" || command.Principal.ID == "" {
		return forbidden("EXECUTION_COMMAND_FORBIDDEN", "A local executor service Principal is required")
	}
	if len(command.IdempotencyKey) < 8 || len(command.IdempotencyKey) > 128 || !idempotencyKeyPattern.MatchString(command.IdempotencyKey) {
		return validation("Idempotency-Key must contain 8 to 128 safe characters")
	}
	validType := command.Input.EventType == "claimed" || command.Input.EventType == "heartbeat" || command.Input.EventType == "started" || command.Input.EventType == "progress" || command.Input.EventType == "succeeded" || command.Input.EventType == "failed" || command.Input.EventType == "cancel_acknowledged" || command.Input.EventType == "terminated"
	if !validType || command.Input.FencingToken < 1 || command.Input.Cursor < 1 || command.Input.EmittedAt.IsZero() {
		return validation("Run event type, cursor, fencing token, and emittedAt are required")
	}
	if command.Input.ExtendLeaseSeconds != 0 && (command.Input.ExtendLeaseSeconds < 15 || command.Input.ExtendLeaseSeconds > 3600) {
		return validation("extendLeaseSeconds is outside the allowed range")
	}
	if command.Input.Payload == nil {
		command.Input.Payload = map[string]any{}
	}
	hash, err := hashExecutionInput(command.Input)
	command.RequestHash = hash
	return err
}

func ValidateRequestRunCancellationCommand(command *RequestRunCancellationCommand) error {
	command.WorkspaceID, command.RunID = strings.TrimSpace(command.WorkspaceID), strings.TrimSpace(command.RunID)
	command.Principal.Type, command.Principal.ID = strings.TrimSpace(command.Principal.Type), strings.TrimSpace(command.Principal.ID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	if err := validateCommandIdentity(command.WorkspaceID, command.RunID, command.Principal, command.IdempotencyKey); err != nil {
		return err
	}
	hash, err := hashExecutionInput(map[string]string{"runId": command.RunID})
	command.RequestHash = hash
	return err
}
