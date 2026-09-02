package target

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

type AgentLifecycleResult struct {
	SchemaVersion int    `json:"schemaVersion"`
	ResourceType  string `json:"resourceType"`
	ResourceID    string `json:"resourceId"`
	Replayed      bool   `json:"replayed"`
}

type AgentDefinitionInput struct {
	Name                 string  `json:"name"`
	Description          *string `json:"description,omitempty"`
	CompatibilityAgentID *string `json:"compatibilityAgentId,omitempty"`
}

type UpdateAgentDefinitionInput struct {
	Name               *string `json:"name,omitempty"`
	Description        *string `json:"description,omitempty"`
	DescriptionPresent bool    `json:"-"`
}

func (input *UpdateAgentDefinitionInput) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for key := range fields {
		if key != "name" && key != "description" {
			return fmt.Errorf("unknown AgentDefinition field %q", key)
		}
	}
	if raw, ok := fields["name"]; ok {
		var name *string
		if err := json.Unmarshal(raw, &name); err != nil {
			return err
		}
		if name == nil {
			return fmt.Errorf("AgentDefinition name cannot be null")
		}
		input.Name = name
	}
	if raw, ok := fields["description"]; ok {
		input.DescriptionPresent = true
		if string(raw) == "null" {
			input.Description = nil
		} else {
			var description string
			if err := json.Unmarshal(raw, &description); err != nil {
				return err
			}
			input.Description = &description
		}
	}
	return nil
}

type PublishAgentVersionInput struct {
	Runtime           string         `json:"runtime"`
	Model             string         `json:"model"`
	Prompt            string         `json:"prompt"`
	Skills            []string       `json:"skills"`
	Tools             []string       `json:"tools"`
	OutputSchema      map[string]any `json:"outputSchema"`
	CapabilityCeiling []string       `json:"capabilityCeiling"`
	SupplyChain       map[string]any `json:"supplyChain"`
}

type EvaluationRunInput struct {
	CandidateAgentVersionID string  `json:"candidateAgentVersionId"`
	BaselineAgentVersionID  *string `json:"baselineAgentVersionId,omitempty"`
	Status                  string  `json:"status"`
	QualityScore            *int    `json:"qualityScore,omitempty"`
	CostCents               *int    `json:"costCents,omitempty"`
	LatencyMS               *int    `json:"latencyMs,omitempty"`
	SafetyStatus            string  `json:"safetyStatus"`
	Summary                 *string `json:"summary,omitempty"`
}

type CreateDeploymentInput struct {
	AgentDefinitionID string         `json:"agentDefinitionId"`
	AgentVersionID    string         `json:"agentVersionId"`
	EvaluationRunID   string         `json:"evaluationRunId"`
	Name              string         `json:"name"`
	IsDefault         bool           `json:"isDefault"`
	RuntimeConfig     map[string]any `json:"runtimeConfig"`
}

type ReviseDeploymentInput struct {
	Action                     string         `json:"action"`
	AgentVersionID             *string        `json:"agentVersionId,omitempty"`
	EvaluationRunID            *string        `json:"evaluationRunId,omitempty"`
	SourceDeploymentRevisionID *string        `json:"sourceDeploymentRevisionId,omitempty"`
	RuntimeConfig              map[string]any `json:"runtimeConfig,omitempty"`
}

type AgentLifecycleCommand[T any] struct {
	WorkspaceID    string
	ResourceID     string
	Principal      Principal
	IdempotencyKey string
	CommandType    string
	Input          T
	RequestHash    string
}

func ValidateAgentLifecycleCommand[T any](command *AgentLifecycleCommand[T]) error {
	command.WorkspaceID = strings.TrimSpace(command.WorkspaceID)
	command.ResourceID = strings.TrimSpace(command.ResourceID)
	command.Principal.Type = strings.TrimSpace(command.Principal.Type)
	command.Principal.ID = strings.TrimSpace(command.Principal.ID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	if !uuidPattern.MatchString(command.WorkspaceID) {
		return validation("workspaceId must be a UUID")
	}
	if command.ResourceID != "" && !uuidPattern.MatchString(command.ResourceID) {
		return validation("resourceId must be a UUID")
	}
	if command.Principal.Type != "user" || command.Principal.ID == "" {
		return forbidden("AGENT_LIFECYCLE_FORBIDDEN", "A human Workspace member is required")
	}
	if len(command.IdempotencyKey) < 8 || len(command.IdempotencyKey) > 128 || !idempotencyKeyPattern.MatchString(command.IdempotencyKey) {
		return validation("Idempotency-Key must contain 8 to 128 safe characters")
	}
	payload, err := json.Marshal(command.Input)
	if err != nil {
		return validation("Invalid Agent lifecycle command")
	}
	digest := sha256.Sum256(payload)
	command.RequestHash = hex.EncodeToString(digest[:])
	return nil
}

func ValidateDefinitionInput(input *AgentDefinitionInput) error {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 200 {
		return validation("AgentDefinition name is required")
	}
	if input.Description != nil {
		value := strings.TrimSpace(*input.Description)
		if utf8.RuneCountInString(value) > 4_000 {
			return validation("AgentDefinition description is too long")
		}
		input.Description = &value
	}
	if input.CompatibilityAgentID != nil {
		value := strings.TrimSpace(*input.CompatibilityAgentID)
		if !uuidPattern.MatchString(value) {
			return validation("compatibilityAgentId must be a UUID")
		}
		input.CompatibilityAgentID = &value
	}
	return nil
}

func ValidateUpdateDefinitionInput(input *UpdateAgentDefinitionInput) error {
	if input.Name == nil && !input.DescriptionPresent {
		return validation("At least one AgentDefinition field is required")
	}
	if input.Name != nil {
		value := strings.TrimSpace(*input.Name)
		if value == "" || utf8.RuneCountInString(value) > 200 {
			return validation("AgentDefinition name is invalid")
		}
		input.Name = &value
	}
	if input.DescriptionPresent && input.Description != nil {
		value := strings.TrimSpace(*input.Description)
		if utf8.RuneCountInString(value) > 4_000 {
			return validation("AgentDefinition description is too long")
		}
		input.Description = &value
	}
	return nil
}

func ValidatePublishInput(input *PublishAgentVersionInput) error {
	input.Runtime, input.Model = strings.TrimSpace(input.Runtime), strings.TrimSpace(input.Model)
	if input.Runtime == "" || utf8.RuneCountInString(input.Runtime) > 200 ||
		input.Model == "" || utf8.RuneCountInString(input.Model) > 300 ||
		strings.TrimSpace(input.Prompt) == "" || utf8.RuneCountInString(input.Prompt) > 200_000 {
		return validation("Runtime, model, and prompt are required")
	}
	if input.Skills == nil {
		input.Skills = []string{}
	}
	if input.Tools == nil {
		input.Tools = []string{}
	}
	if input.OutputSchema == nil {
		input.OutputSchema = map[string]any{}
	}
	if input.CapabilityCeiling == nil {
		input.CapabilityCeiling = []string{}
	}
	if input.SupplyChain == nil {
		input.SupplyChain = map[string]any{}
	}
	if err := validateAgentStringList(&input.Skills, "skills"); err != nil {
		return err
	}
	if err := validateAgentStringList(&input.Tools, "tools"); err != nil {
		return err
	}
	if err := validateAgentStringList(&input.CapabilityCeiling, "capabilityCeiling"); err != nil {
		return err
	}
	return nil
}

func validateAgentStringList(values *[]string, field string) error {
	if len(*values) > 200 {
		return validation(field + " may contain at most 200 entries")
	}
	for index, value := range *values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || utf8.RuneCountInString(trimmed) > 200 {
			return validation(field + " entries must be non-empty and bounded")
		}
		(*values)[index] = trimmed
	}
	return nil
}

func ValidateEvaluationInput(input *EvaluationRunInput) error {
	if !uuidPattern.MatchString(input.CandidateAgentVersionID) {
		return validation("candidateAgentVersionId must be a UUID")
	}
	if input.BaselineAgentVersionID != nil && !uuidPattern.MatchString(*input.BaselineAgentVersionID) {
		return validation("baselineAgentVersionId must be a UUID")
	}
	if input.Status != "passed" && input.Status != "failed" && input.Status != "inconclusive" {
		return validation("Evaluation status is invalid")
	}
	if input.SafetyStatus != "passed" && input.SafetyStatus != "failed" && input.SafetyStatus != "not_run" {
		return validation("Evaluation safetyStatus is invalid")
	}
	if input.Status == "passed" && input.SafetyStatus != "passed" {
		return validation("A passing evaluation requires passing safety")
	}
	if input.QualityScore != nil && (*input.QualityScore < 0 || *input.QualityScore > 100) {
		return validation("qualityScore must be between 0 and 100")
	}
	if input.CostCents != nil && *input.CostCents < 0 {
		return validation("costCents must be non-negative")
	}
	if input.LatencyMS != nil && *input.LatencyMS < 0 {
		return validation("latencyMs must be non-negative")
	}
	if input.Summary != nil {
		value := strings.TrimSpace(*input.Summary)
		if utf8.RuneCountInString(value) > 10_000 {
			return validation("Evaluation summary is too long")
		}
		input.Summary = &value
	}
	return nil
}

func ValidateCreateDeploymentInput(input *CreateDeploymentInput) error {
	if !uuidPattern.MatchString(input.AgentDefinitionID) || !uuidPattern.MatchString(input.AgentVersionID) || !uuidPattern.MatchString(input.EvaluationRunID) {
		return validation("Deployment references must be UUIDs")
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 200 {
		return validation("Deployment name is required")
	}
	if input.RuntimeConfig == nil {
		input.RuntimeConfig = map[string]any{}
	}
	return nil
}

func ValidateReviseDeploymentInput(input *ReviseDeploymentInput) error {
	valid := input.Action == "pause" || input.Action == "resume" || input.Action == "upgrade" || input.Action == "rollback" || input.Action == "retire" || input.Action == "set_default"
	if !valid {
		return validation("Deployment action is invalid")
	}
	if input.Action == "upgrade" && (input.AgentVersionID == nil || input.EvaluationRunID == nil) {
		return validation("Upgrade requires agentVersionId and evaluationRunId")
	}
	if input.Action == "rollback" && input.SourceDeploymentRevisionID == nil {
		return validation("Rollback requires sourceDeploymentRevisionId")
	}
	if input.AgentVersionID != nil && !uuidPattern.MatchString(*input.AgentVersionID) {
		return validation("agentVersionId must be a UUID")
	}
	if input.EvaluationRunID != nil && !uuidPattern.MatchString(*input.EvaluationRunID) {
		return validation("evaluationRunId must be a UUID")
	}
	if input.SourceDeploymentRevisionID != nil && !uuidPattern.MatchString(*input.SourceDeploymentRevisionID) {
		return validation("sourceDeploymentRevisionId must be a UUID")
	}
	return nil
}
