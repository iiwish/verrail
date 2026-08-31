package target

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const SchemaVersion = 1

var (
	uuidPattern           = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
	idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
)

type Principal struct {
	Type string
	ID   string
}

type OutcomeOwner struct {
	PrincipalType string `json:"principalType"`
	PrincipalID   string `json:"principalId"`
}

type AcceptanceCriterionInput struct {
	Title       string  `json:"title"`
	Description *string `json:"description,omitempty"`
}

type CreateInput struct {
	ProjectID          string                     `json:"projectId"`
	Title              string                     `json:"title"`
	Summary            *string                    `json:"summary,omitempty"`
	OutcomeOwner       OutcomeOwner               `json:"outcomeOwner"`
	Goal               string                     `json:"goal"`
	Constraints        []string                   `json:"constraints"`
	AcceptanceCriteria []AcceptanceCriterionInput `json:"acceptanceCriteria"`
	RiskLevel          string                     `json:"riskLevel"`
	Deadline           *string                    `json:"deadline,omitempty"`
	PolicySummary      *string                    `json:"policySummary,omitempty"`
}

type AcceptanceCriterion struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
}

type CreateCommand struct {
	WorkspaceID    string
	Principal      Principal
	IdempotencyKey string
	Input          CreateInput
	RequestHash    string
}

type CreateResult struct {
	SchemaVersion    int    `json:"schemaVersion"`
	TargetID         string `json:"targetId"`
	TargetRevisionID string `json:"targetRevisionId"`
	WorkbenchHref    string `json:"workbenchHref"`
	Replayed         bool   `json:"replayed"`
}

type Error struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return e.Message }

func ValidateCommand(command *CreateCommand) error {
	command.WorkspaceID = strings.TrimSpace(command.WorkspaceID)
	command.Principal.Type = strings.TrimSpace(command.Principal.Type)
	command.Principal.ID = strings.TrimSpace(command.Principal.ID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	input := &command.Input
	input.ProjectID = strings.TrimSpace(input.ProjectID)
	input.Title = strings.TrimSpace(input.Title)
	input.Goal = strings.TrimSpace(input.Goal)
	input.RiskLevel = strings.TrimSpace(input.RiskLevel)
	input.OutcomeOwner.PrincipalType = strings.TrimSpace(input.OutcomeOwner.PrincipalType)
	input.OutcomeOwner.PrincipalID = strings.TrimSpace(input.OutcomeOwner.PrincipalID)

	if !uuidPattern.MatchString(command.WorkspaceID) || !uuidPattern.MatchString(input.ProjectID) {
		return validation("workspaceId and projectId must be UUIDs")
	}
	if command.Principal.Type != "user" || command.Principal.ID == "" || utf8.RuneCountInString(command.Principal.ID) > 200 {
		return forbidden("TARGET_CREATE_FORBIDDEN", "A human Workspace member is required")
	}
	if len(command.IdempotencyKey) < 8 || len(command.IdempotencyKey) > 128 || !idempotencyKeyPattern.MatchString(command.IdempotencyKey) {
		return validation("Idempotency-Key must contain 8 to 128 safe characters")
	}
	if input.Title == "" || utf8.RuneCountInString(input.Title) > 160 || input.Goal == "" || utf8.RuneCountInString(input.Goal) > 4000 {
		return validation("title and goal are required and must stay within their size limits")
	}
	if input.Summary != nil {
		value := strings.TrimSpace(*input.Summary)
		if value == "" || utf8.RuneCountInString(value) > 2000 {
			return validation("summary must contain 1 to 2000 characters")
		}
		input.Summary = &value
	}
	if input.OutcomeOwner.PrincipalID == "" || utf8.RuneCountInString(input.OutcomeOwner.PrincipalID) > 200 || (input.OutcomeOwner.PrincipalType != "user" && input.OutcomeOwner.PrincipalType != "agent") {
		return validation("outcomeOwner must identify a user or agent")
	}
	if input.OutcomeOwner.PrincipalType == "agent" && !uuidPattern.MatchString(input.OutcomeOwner.PrincipalID) {
		return validation("agent outcomeOwner principalId must be a UUID")
	}
	if len(input.Constraints) > 20 {
		return validation("constraints may contain at most 20 entries")
	}
	for index := range input.Constraints {
		input.Constraints[index] = strings.TrimSpace(input.Constraints[index])
		if input.Constraints[index] == "" || utf8.RuneCountInString(input.Constraints[index]) > 1000 {
			return validation("each constraint must contain 1 to 1000 characters")
		}
	}
	if len(input.AcceptanceCriteria) < 1 || len(input.AcceptanceCriteria) > 20 {
		return validation("acceptanceCriteria must contain 1 to 20 entries")
	}
	for index := range input.AcceptanceCriteria {
		criterion := &input.AcceptanceCriteria[index]
		criterion.Title = strings.TrimSpace(criterion.Title)
		if criterion.Title == "" || utf8.RuneCountInString(criterion.Title) > 200 {
			return validation("each acceptance criterion title must contain 1 to 200 characters")
		}
		if criterion.Description != nil {
			value := strings.TrimSpace(*criterion.Description)
			if value == "" || utf8.RuneCountInString(value) > 2000 {
				return validation("each acceptance criterion description must contain 1 to 2000 characters")
			}
			criterion.Description = &value
		}
	}
	if input.RiskLevel != "low" && input.RiskLevel != "medium" && input.RiskLevel != "high" && input.RiskLevel != "critical" {
		return validation("riskLevel is invalid")
	}
	if input.Deadline != nil {
		value := strings.TrimSpace(*input.Deadline)
		if _, err := time.Parse("2006-01-02", value); err != nil {
			return validation("deadline must use YYYY-MM-DD")
		}
		input.Deadline = &value
	}
	if input.PolicySummary != nil {
		value := strings.TrimSpace(*input.PolicySummary)
		if value == "" || utf8.RuneCountInString(value) > 4000 {
			return validation("policySummary must contain 1 to 4000 characters")
		}
		input.PolicySummary = &value
	}

	payload, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("marshal canonical Target command: %w", err)
	}
	digest := sha256.Sum256(payload)
	command.RequestHash = hex.EncodeToString(digest[:])
	return nil
}

func NewUUID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16]), nil
}

func AsError(err error) *Error {
	var domainError *Error
	if errors.As(err, &domainError) {
		return domainError
	}
	return &Error{Status: 500, Code: "TARGET_CREATE_FAILED", Message: "Target creation failed", Retryable: true}
}

func validation(message string) error {
	return &Error{Status: 400, Code: "TARGET_COMMAND_INVALID", Message: message}
}
func forbidden(code, message string) error { return &Error{Status: 403, Code: code, Message: message} }

func NotFound() error {
	return &Error{Status: 404, Code: "TARGET_CREATE_SCOPE_NOT_FOUND", Message: "Workspace or Project not found"}
}
func OwnerInvalid() error {
	return &Error{Status: 422, Code: "TARGET_OWNER_INVALID", Message: "Outcome owner is not active in this Workspace"}
}
func IdempotencyConflict() error {
	return &Error{Status: 409, Code: "TARGET_IDEMPOTENCY_CONFLICT", Message: "Idempotency key is already bound to another Target command"}
}
func CreateForbidden() error {
	return forbidden("TARGET_CREATE_FORBIDDEN", "Principal is not authorized to create Targets in this Workspace")
}
