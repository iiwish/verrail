package target

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	connectorResourceIntegrationRun      = "integration_run"
	connectorResourceActionRequest       = "action_request"
	connectorResourceActionApproval      = "action_approval"
	connectorResourceEffectReceipt       = "effect_receipt"
	connectorIntegrationRunRecordedEvent = "connector.integration_run_recorded.v1"
	connectorActionRequestCreatedEvent   = "connector.action_request_created.v1"
	connectorActionApprovedEvent         = "connector.action_approved.v1"
	connectorActionExecutedEvent         = "connector.action_executed.v1"
	ConnectorIntegrationRunRecordCommand = "connector.integration_run.record.v1"
	ConnectorActionRequestCreateCommand  = "connector.action_request.create.v1"
	ConnectorActionApproveCommand        = "connector.action.approve.v1"
	ConnectorActionExecuteCommand        = "connector.action.execute.v1"
)

// The connector producer identity for CI evidence recorded by integration
// runs: service principals are recorded by human members (spec.md product
// contract item 1).
const connectorProducerPrincipalID = "integration-run"

const connectorVerifierVersion = "integration-run.v1"

type PullRequestParams struct {
	Title string `json:"title"`
	Head  string `json:"head"`
	Base  string `json:"base"`
}

type RecordIntegrationRunInput struct {
	TargetID    string  `json:"targetId"`
	ClaimID     string  `json:"claimId"`
	WorkNodeID  *string `json:"workNodeId,omitempty"`
	Provider    string  `json:"provider"`
	ExternalRef string  `json:"externalRef"`
	Conclusion  string  `json:"conclusion"`
	ObjectHash  string  `json:"objectHash"`
	Reference   string  `json:"reference"`
}

type RequestPullRequestActionInput struct {
	TargetID     string            `json:"targetId"`
	SubmissionID string            `json:"submissionId"`
	Params       PullRequestParams `json:"params"`
}

// ApproveActionInput mirrors the review wire parity: the approver identity is
// carried on the wire but the store binds it to the command principal. The
// params hash is the digest of the parameters the approver reviewed; the
// store rejects a mismatch so the approval is parameter-bound.
type ApproveActionInput struct {
	ActionRequestID       string `json:"actionRequestId"`
	ApproverPrincipalType string `json:"approverPrincipalType"`
	ApproverPrincipalID   string `json:"approverPrincipalId"`
	ParamsHash            string `json:"paramsHash"`
}

type ExecuteActionInput struct {
	ActionRequestID string `json:"actionRequestId"`
}

func connectorNotFound(resource string) error {
	return &Error{Status: 404, Code: "CONNECTOR_RESOURCE_NOT_FOUND", Message: resource + " not found in this Workspace"}
}

func connectorCredentialsNotConfigured() error {
	return &Error{Status: 502, Code: "CONNECTOR_CREDENTIALS_NOT_CONFIGURED", Message: "connector credentials not configured", Retryable: false}
}

func connectorUpstreamError(message string) error {
	if strings.TrimSpace(message) == "" {
		message = "GitHub rejected the request"
	}
	return &Error{Status: 502, Code: "CONNECTOR_UPSTREAM_ERROR", Message: message, Retryable: true}
}

func ValidateRecordIntegrationRunInput(input *RecordIntegrationRunInput) error {
	if !uuidPattern.MatchString(input.TargetID) || !uuidPattern.MatchString(input.ClaimID) {
		return validation("targetId and claimId must be UUIDs")
	}
	if input.WorkNodeID != nil {
		value := strings.TrimSpace(*input.WorkNodeID)
		if !uuidPattern.MatchString(value) {
			return validation("workNodeId must be a UUID")
		}
		input.WorkNodeID = &value
	}
	input.Provider = strings.TrimSpace(input.Provider)
	if input.Provider != "github" {
		return validation("provider must be github")
	}
	input.ExternalRef = strings.TrimSpace(input.ExternalRef)
	if input.ExternalRef == "" || utf8.RuneCountInString(input.ExternalRef) > 300 {
		return validation("externalRef must contain 1 to 300 characters")
	}
	if input.Conclusion != "success" && input.Conclusion != "failure" && input.Conclusion != "neutral" {
		return validation("Integration run conclusion is invalid")
	}
	if err := validateAssuranceHash(&input.ObjectHash, "objectHash"); err != nil {
		return err
	}
	input.Reference = strings.TrimSpace(input.Reference)
	if input.Reference == "" || utf8.RuneCountInString(input.Reference) > 500 {
		return validation("reference must contain 1 to 500 characters")
	}
	return nil
}

func ValidatePullRequestParams(params *PullRequestParams) error {
	params.Title = strings.TrimSpace(params.Title)
	params.Head = strings.TrimSpace(params.Head)
	params.Base = strings.TrimSpace(params.Base)
	if params.Title == "" || utf8.RuneCountInString(params.Title) > 200 {
		return validation("params.title must contain 1 to 200 characters")
	}
	if params.Head == "" || utf8.RuneCountInString(params.Head) > 200 {
		return validation("params.head must contain 1 to 200 characters")
	}
	if params.Base == "" || utf8.RuneCountInString(params.Base) > 200 {
		return validation("params.base must contain 1 to 200 characters")
	}
	return nil
}

func ValidateRequestPullRequestActionInput(input *RequestPullRequestActionInput) error {
	if !uuidPattern.MatchString(input.TargetID) || !uuidPattern.MatchString(input.SubmissionID) {
		return validation("targetId and submissionId must be UUIDs")
	}
	return ValidatePullRequestParams(&input.Params)
}

func ValidateApproveActionInput(input *ApproveActionInput) error {
	if !uuidPattern.MatchString(input.ActionRequestID) {
		return validation("actionRequestId must be a UUID")
	}
	input.ApproverPrincipalType = strings.TrimSpace(input.ApproverPrincipalType)
	// G2 authority model: the approver is a human workspace member. The field
	// is kept on the wire for parity; only "user" is accepted.
	if input.ApproverPrincipalType != "user" {
		return validation("approverPrincipalType must be user")
	}
	input.ApproverPrincipalID = strings.TrimSpace(input.ApproverPrincipalID)
	if input.ApproverPrincipalID == "" || utf8.RuneCountInString(input.ApproverPrincipalID) > 200 {
		return validation("approverPrincipalId must contain 1 to 200 characters")
	}
	if err := validateAssuranceHash(&input.ParamsHash, "paramsHash"); err != nil {
		return err
	}
	return nil
}

func ValidateExecuteActionInput(input *ExecuteActionInput) error {
	if !uuidPattern.MatchString(input.ActionRequestID) {
		return validation("actionRequestId must be a UUID")
	}
	return nil
}

// pullRequestParamsHash derives the sha256 over the canonical JSON payload of
// {title, head, base}. The approval is parameter-bound to this digest.
func pullRequestParamsHash(params PullRequestParams) (string, error) {
	payload := map[string]any{
		"title": params.Title,
		"head":  params.Head,
		"base":  params.Base,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// effectHash derives the content hash of an EffectReceipt: sha256 over the
// canonical JSON payload of the request and the produced external object
// (invariant 9).
func effectHash(actionRequestID, paramsHash, externalObjectID string) (string, error) {
	payload := map[string]any{
		"actionRequestId":  actionRequestID,
		"paramsHash":       paramsHash,
		"externalObjectId": externalObjectID,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// GitHubClient abstracts the external GitHub API behind a single governed
// effect (spec.md product contract item 3). Tests use a fake; production uses
// the thin REST wrapper below.
type GitHubClient interface {
	CreatePullRequest(ctx context.Context, repo string, params PullRequestParams) (externalObjectID string, externalURL string, err error)
}

// GitHubRESTClient is the real thin REST wrapper against api.github.com. The
// token is injected at construction time by the control plane once workspace
// connection credentials can be resolved outside the Node secret provider;
// until then an empty token fails fast with a clear error and every test runs
// against a fake (documented deviation).
type GitHubRESTClient struct {
	apiBase    string
	token      string
	httpClient *http.Client
}

func NewGitHubRESTClient(apiBase, token string) *GitHubRESTClient {
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	return &GitHubRESTClient{apiBase: strings.TrimRight(apiBase, "/"), token: token, httpClient: &http.Client{Timeout: 30 * time.Second}}
}

func (client *GitHubRESTClient) CreatePullRequest(ctx context.Context, repo string, params PullRequestParams) (string, string, error) {
	if strings.TrimSpace(client.token) == "" {
		return "", "", connectorCredentialsNotConfigured()
	}
	body, err := json.Marshal(map[string]string{"title": params.Title, "head": params.Head, "base": params.Base})
	if err != nil {
		return "", "", connectorUpstreamError("encode pull request payload")
	}
	request, err := http.NewRequest(http.MethodPost, client.apiBase+"/repos/"+repo+"/pulls", strings.NewReader(string(body)))
	if err != nil {
		return "", "", connectorUpstreamError("build GitHub request")
	}
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("Content-Type", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return "", "", connectorUpstreamError(err.Error())
	}
	defer func() { _ = response.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", "", connectorUpstreamError("read GitHub response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", "", connectorUpstreamError(fmt.Sprintf("GitHub returned %d: %s", response.StatusCode, strings.TrimSpace(string(payload))))
	}
	var created struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.Unmarshal(payload, &created); err != nil || created.Number == 0 {
		return "", "", connectorUpstreamError("GitHub response did not contain a pull request number")
	}
	return fmt.Sprintf("%d", created.Number), created.HTMLURL, nil
}
