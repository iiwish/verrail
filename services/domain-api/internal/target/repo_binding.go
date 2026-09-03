package target

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const (
	connectorResourceRepoBinding      = "repo_binding"
	connectorRepoBindingCreatedEvent  = "connector.repo_binding_created.v1"
	ConnectorRepoBindingCreateCommand = "connector.repo_binding.create.v1"
)

// CreateGithubRepoBindingInput provisions the workspace-scoped GitHub repo
// binding (verrail_github_repo_bindings, one per workspace) that the connector
// ExecuteAction gate requires before producing a governed external effect.
type CreateGithubRepoBindingInput struct {
	ConnectionID string `json:"connectionId"`
	RepoOwner    string `json:"repoOwner"`
	RepoName     string `json:"repoName"`
}

// connectorConnectionDisabled: the connection exists in the workspace but is
// switched off, so a binding may not reference it (409).
func connectorConnectionDisabled() error {
	return &Error{Status: 409, Code: "CONNECTOR_CONNECTION_DISABLED", Message: "The referenced connector connection is disabled"}
}

// connectorBindingConflict: a binding already exists for the workspace with
// different content (one binding per workspace; a repeat with the same content
// replays instead, see the store).
func connectorBindingConflict() error {
	return &Error{Status: 409, Code: "CONNECTOR_BINDING_CONFLICT", Message: "A different GitHub repo binding already exists for this Workspace"}
}

// repoBindingNotOwner: the principal is an active workspace member but holds
// neither the owner role nor the instance-admin role (403 REPO_BINDING_NOT_OWNER).
func repoBindingNotOwner() error {
	return forbidden("REPO_BINDING_NOT_OWNER", "Only a Workspace owner or an instance admin can provision the GitHub repo binding")
}

func ValidateCreateGithubRepoBindingInput(input *CreateGithubRepoBindingInput) error {
	if !uuidPattern.MatchString(input.ConnectionID) {
		return validation("connectionId must be a UUID")
	}
	input.RepoOwner = strings.TrimSpace(input.RepoOwner)
	if input.RepoOwner == "" || utf8.RuneCountInString(input.RepoOwner) > 200 {
		return validation("repoOwner must contain 1 to 200 characters")
	}
	input.RepoName = strings.TrimSpace(input.RepoName)
	if input.RepoName == "" || utf8.RuneCountInString(input.RepoName) > 200 {
		return validation("repoName must contain 1 to 200 characters")
	}
	return nil
}

// repoBindingHash derives the sha256 over the canonical JSON payload of
// {connectionId, repoOwner, repoName}: the content address of a binding. The
// table carries no hash column (no migration), so the store never persists it
// — dedup reads the existing row's connection_id/repo_owner/repo_name and
// compares field-wise; the digest is the canonical contract reference.
func repoBindingHash(input CreateGithubRepoBindingInput) (string, error) {
	payload := map[string]any{
		"connectionId": input.ConnectionID,
		"repoOwner":    input.RepoOwner,
		"repoName":     input.RepoName,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
