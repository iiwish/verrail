package target

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

type ResponsiblePrincipal struct {
	PrincipalType string `json:"principalType"`
	PrincipalID   string `json:"principalId"`
}

type WorkNodeInput struct {
	NodeKey              string                `json:"nodeKey"`
	Kind                 string                `json:"kind"`
	Stage                string                `json:"stage"`
	Title                string                `json:"title"`
	ResponsiblePrincipal *ResponsiblePrincipal `json:"responsiblePrincipal,omitempty"`
	DependencyNodeKeys   []string              `json:"dependencyNodeKeys,omitempty"`
	CompletionDefinition *string               `json:"completionDefinition,omitempty"`
}

type CreateGraphRevisionInput struct {
	ExpectedTargetRevisionID string          `json:"expectedTargetRevisionId"`
	Nodes                    []WorkNodeInput `json:"nodes"`
}

type CreateGraphRevisionCommand struct {
	WorkspaceID    string
	TargetID       string
	Principal      Principal
	IdempotencyKey string
	Input          CreateGraphRevisionInput
	RequestHash    string
}

type CreateGraphRevisionResult struct {
	SchemaVersion    int    `json:"schemaVersion"`
	TargetID         string `json:"targetId"`
	TargetRevisionID string `json:"targetRevisionId"`
	WorkGraphID      string `json:"workGraphId"`
	GraphRevisionID  string `json:"graphRevisionId"`
	RevisionNumber   int    `json:"revisionNumber"`
	Replayed         bool   `json:"replayed"`
}

type ActivateGraphRevisionCommand struct {
	WorkspaceID     string
	TargetID        string
	GraphRevisionID string
	Principal       Principal
	IdempotencyKey  string
	RequestHash     string
}

type ActivateGraphRevisionResult struct {
	CreateGraphRevisionResult
	ActivatedAt string `json:"activatedAt"`
}

type CreateRunInput struct {
	Kind  string               `json:"kind"`
	Actor ResponsiblePrincipal `json:"actor"`
}

type CreateRunCommand struct {
	WorkspaceID     string
	TargetID        string
	GraphRevisionID string
	WorkNodeID      string
	Principal       Principal
	IdempotencyKey  string
	Input           CreateRunInput
	RequestHash     string
}

type CreateRunResult struct {
	SchemaVersion        int     `json:"schemaVersion"`
	RunID                string  `json:"runId"`
	TargetID             string  `json:"targetId"`
	TargetRevisionID     string  `json:"targetRevisionId"`
	GraphRevisionID      string  `json:"graphRevisionId"`
	WorkNodeID           string  `json:"workNodeId"`
	DeploymentRevisionID *string `json:"deploymentRevisionId"`
	AgentVersionID       *string `json:"agentVersionId"`
	Status               string  `json:"status"`
	Replayed             bool    `json:"replayed"`
}

func validateCommandIdentity(workspaceID, targetID string, principal Principal, idempotencyKey string) error {
	if !uuidPattern.MatchString(strings.TrimSpace(workspaceID)) || !uuidPattern.MatchString(strings.TrimSpace(targetID)) {
		return validation("workspaceId and targetId must be UUIDs")
	}
	if strings.TrimSpace(principal.Type) != "user" || strings.TrimSpace(principal.ID) == "" {
		return forbidden("TARGET_COMMAND_FORBIDDEN", "A human Workspace member is required")
	}
	key := strings.TrimSpace(idempotencyKey)
	if len(key) < 8 || len(key) > 128 || !idempotencyKeyPattern.MatchString(key) {
		return validation("Idempotency-Key must contain 8 to 128 safe characters")
	}
	return nil
}

func ValidateCreateGraphRevisionCommand(command *CreateGraphRevisionCommand) error {
	command.WorkspaceID = strings.TrimSpace(command.WorkspaceID)
	command.TargetID = strings.TrimSpace(command.TargetID)
	command.Principal.Type = strings.TrimSpace(command.Principal.Type)
	command.Principal.ID = strings.TrimSpace(command.Principal.ID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	command.Input.ExpectedTargetRevisionID = strings.TrimSpace(command.Input.ExpectedTargetRevisionID)
	if err := validateCommandIdentity(command.WorkspaceID, command.TargetID, command.Principal, command.IdempotencyKey); err != nil {
		return err
	}
	if !uuidPattern.MatchString(command.Input.ExpectedTargetRevisionID) {
		return validation("expectedTargetRevisionId must be a UUID")
	}
	if len(command.Input.Nodes) > 200 {
		return validation("nodes may contain at most 200 entries")
	}
	keys := make(map[string]bool, len(command.Input.Nodes))
	for index := range command.Input.Nodes {
		node := &command.Input.Nodes[index]
		node.NodeKey = strings.TrimSpace(node.NodeKey)
		node.Kind = strings.TrimSpace(node.Kind)
		node.Stage = strings.TrimSpace(node.Stage)
		node.Title = strings.TrimSpace(node.Title)
		if node.NodeKey == "" || len(node.NodeKey) > 120 || keys[node.NodeKey] {
			return validation("nodeKey must be unique and bounded")
		}
		keys[node.NodeKey] = true
		validKind := node.Kind == "agent_task" || node.Kind == "integration_task" || node.Kind == "human_task" || node.Kind == "decision_gate" || node.Kind == "review_gate" || node.Kind == "acceptance_gate" || node.Kind == "policy_gate"
		if !validKind {
			return validation("WorkNode kind is invalid")
		}
		if node.Stage != "define" && node.Stage != "execute" && node.Stage != "verify" && node.Stage != "accept" {
			return validation("WorkNode stage is invalid")
		}
		if node.Title == "" || utf8.RuneCountInString(node.Title) > 300 {
			return validation("WorkNode title is required")
		}
		if node.CompletionDefinition == nil || strings.TrimSpace(*node.CompletionDefinition) == "" {
			return validation("completionDefinition is required")
		}
		if node.Kind == "agent_task" {
			if node.ResponsiblePrincipal == nil || node.ResponsiblePrincipal.PrincipalType != "agent" || !uuidPattern.MatchString(strings.TrimSpace(node.ResponsiblePrincipal.PrincipalID)) {
				return validation("AgentTask responsiblePrincipal must be an Agent DeploymentRevision")
			}
		}
	}
	for _, node := range command.Input.Nodes {
		for _, dependency := range node.DependencyNodeKeys {
			if dependency == node.NodeKey || !keys[dependency] {
				return validation("WorkNode dependency is invalid")
			}
		}
	}
	if graphHasCycle(command.Input.Nodes) {
		return validation("WorkGraph must be acyclic")
	}
	payload, err := json.Marshal(command.Input)
	if err != nil {
		return fmt.Errorf("marshal graph command: %w", err)
	}
	digest := sha256.Sum256(payload)
	command.RequestHash = hex.EncodeToString(digest[:])
	return nil
}

func graphHasCycle(nodes []WorkNodeInput) bool {
	dependencies := make(map[string][]string, len(nodes))
	for _, node := range nodes {
		dependencies[node.NodeKey] = node.DependencyNodeKeys
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(string) bool
	visit = func(key string) bool {
		if visiting[key] {
			return true
		}
		if visited[key] {
			return false
		}
		visiting[key] = true
		for _, dependency := range dependencies[key] {
			if visit(dependency) {
				return true
			}
		}
		visiting[key] = false
		visited[key] = true
		return false
	}
	for key := range dependencies {
		if visit(key) {
			return true
		}
	}
	return false
}

func ValidateCreateRunCommand(command *CreateRunCommand) error {
	command.WorkspaceID = strings.TrimSpace(command.WorkspaceID)
	command.TargetID = strings.TrimSpace(command.TargetID)
	command.GraphRevisionID = strings.TrimSpace(command.GraphRevisionID)
	command.WorkNodeID = strings.TrimSpace(command.WorkNodeID)
	command.Principal.Type = strings.TrimSpace(command.Principal.Type)
	command.Principal.ID = strings.TrimSpace(command.Principal.ID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	if err := validateCommandIdentity(command.WorkspaceID, command.TargetID, command.Principal, command.IdempotencyKey); err != nil {
		return err
	}
	if !uuidPattern.MatchString(command.GraphRevisionID) || !uuidPattern.MatchString(command.WorkNodeID) {
		return validation("graphRevisionId and workNodeId must be UUIDs")
	}
	if command.Input.Kind != "agent_run" && command.Input.Kind != "integration_run" {
		return validation("Run kind is invalid")
	}
	if command.Input.Actor.PrincipalType != "agent" && command.Input.Actor.PrincipalType != "service" {
		return validation("Run actor is invalid")
	}
	command.Input.Actor.PrincipalID = strings.TrimSpace(command.Input.Actor.PrincipalID)
	if command.Input.Actor.PrincipalID == "" {
		return validation("Run actor is required")
	}
	payload, err := json.Marshal(command.Input)
	if err != nil {
		return fmt.Errorf("marshal Run command: %w", err)
	}
	digest := sha256.Sum256(payload)
	command.RequestHash = hex.EncodeToString(digest[:])
	return nil
}

func ValidateActivationCommand(command *ActivateGraphRevisionCommand) error {
	command.WorkspaceID = strings.TrimSpace(command.WorkspaceID)
	command.TargetID = strings.TrimSpace(command.TargetID)
	command.GraphRevisionID = strings.TrimSpace(command.GraphRevisionID)
	command.Principal.Type = strings.TrimSpace(command.Principal.Type)
	command.Principal.ID = strings.TrimSpace(command.Principal.ID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	if err := validateCommandIdentity(command.WorkspaceID, command.TargetID, command.Principal, command.IdempotencyKey); err != nil {
		return err
	}
	if !uuidPattern.MatchString(command.GraphRevisionID) {
		return validation("graphRevisionId must be a UUID")
	}
	payload, err := json.Marshal(map[string]string{
		"targetId":        command.TargetID,
		"graphRevisionId": command.GraphRevisionID,
	})
	if err != nil {
		return fmt.Errorf("marshal graph activation command: %w", err)
	}
	digest := sha256.Sum256(payload)
	command.RequestHash = hex.EncodeToString(digest[:])
	return nil
}
