package target

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	connectorResourceIntegrationRun       = "integration_run"
	connectorResourceHumanWorkResult      = "human_work_result"
	connectorResourceActionRequest        = "action_request"
	connectorResourceActionApproval       = "action_approval"
	connectorResourceEffectReceipt        = "effect_receipt"
	connectorIntegrationRunRecordedEvent  = "connector.integration_run_recorded.v1"
	connectorHumanWorkResultRecordedEvent = "connector.human_work_result_recorded.v1"
	connectorActionRequestCreatedEvent    = "connector.action_request_created.v1"
	connectorActionApprovedEvent          = "connector.action_approved.v1"
	connectorActionExecutedEvent          = "connector.action_executed.v1"
	ConnectorIntegrationRunRecordCommand  = "connector.integration_run.record.v1"
	ConnectorHumanWorkResultRecordCommand = "connector.human_work_result.record.v1"
	ConnectorActionRequestCreateCommand   = "connector.action_request.create.v1"
	ConnectorActionApproveCommand         = "connector.action.approve.v1"
	ConnectorActionExecuteCommand         = "connector.action.execute.v1"
)

// Stable producer identity for CI evidence recorded by integration runs.
const connectorProducerPrincipalID = "integration-run"

const connectorVerifierVersion = "integration-run.v1"

type PullRequestParams struct {
	Title string `json:"title"`
	Head  string `json:"head"`
	Base  string `json:"base"`
	Body  string `json:"body"`
}

type RecordIntegrationRunInput struct {
	TargetID         string         `json:"targetId"`
	TargetRevisionID string         `json:"targetRevisionId"`
	GraphRevisionID  string         `json:"graphRevisionId"`
	ClaimID          string         `json:"claimId"`
	WorkNodeID       string         `json:"workNodeId"`
	ConnectorVersion string         `json:"connectorVersion"`
	ConnectionID     string         `json:"connectionId"`
	Provider         string         `json:"provider"`
	ExternalRef      string         `json:"externalRef"`
	CommitRef        string         `json:"commitRef"`
	CriterionKey     string         `json:"criterionKey"`
	EnvironmentRef   string         `json:"environmentRef"`
	Conclusion       string         `json:"conclusion"`
	ObjectHash       string         `json:"objectHash"`
	Reference        string         `json:"reference"`
	ProviderReceipt  map[string]any `json:"providerReceipt"`
}

type RecordHumanWorkResultInput struct {
	TargetID           string         `json:"targetId"`
	TargetRevisionID   string         `json:"targetRevisionId"`
	GraphRevisionID    string         `json:"graphRevisionId"`
	WorkNodeID         string         `json:"workNodeId"`
	InputHash          string         `json:"inputHash"`
	Result             map[string]any `json:"result"`
	ArtifactRevisionID *string        `json:"artifactRevisionId,omitempty"`
	AttachmentHashes   []string       `json:"attachmentHashes"`
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

func connectorUnknownEffect(message string) error {
	if strings.TrimSpace(message) == "" {
		message = "GitHub effect outcome is unknown; retry will reconcile before creating"
	}
	return &Error{Status: 502, Code: "CONNECTOR_EFFECT_UNKNOWN", Message: message, Retryable: true}
}

func ValidateRecordIntegrationRunInput(input *RecordIntegrationRunInput) error {
	if !uuidPattern.MatchString(input.TargetID) || !uuidPattern.MatchString(input.TargetRevisionID) || !uuidPattern.MatchString(input.GraphRevisionID) || !uuidPattern.MatchString(input.ClaimID) || !uuidPattern.MatchString(input.WorkNodeID) || !uuidPattern.MatchString(input.ConnectionID) {
		return validation("Integration run binding IDs must be UUIDs")
	}
	input.ConnectorVersion = strings.TrimSpace(input.ConnectorVersion)
	if input.ConnectorVersion == "" || utf8.RuneCountInString(input.ConnectorVersion) > 200 {
		return validation("connectorVersion must contain 1 to 200 characters")
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
	for _, field := range []struct {
		value string
		name  string
		max   int
	}{
		{input.CommitRef, "commitRef", 500},
		{input.CriterionKey, "criterionKey", 100},
		{input.EnvironmentRef, "environmentRef", 500},
	} {
		trimmed := strings.TrimSpace(field.value)
		if trimmed == "" || utf8.RuneCountInString(trimmed) > field.max {
			return validation(field.name + " is required and bounded")
		}
		switch field.name {
		case "commitRef":
			input.CommitRef = trimmed
		case "criterionKey":
			input.CriterionKey = trimmed
		case "environmentRef":
			input.EnvironmentRef = trimmed
		}
	}
	if input.ProviderReceipt == nil || containsSensitiveProviderField(input.ProviderReceipt) {
		return validation("providerReceipt is required and must not contain credentials")
	}
	return nil
}

func ValidateResultLifecycleCommand[T any](command *AgentLifecycleCommand[T]) error {
	return validateLifecycleCommand(
		command,
		func(principalType string) bool { return principalType == "user" || principalType == "service" },
		"WORK_RESULT_COMMAND_FORBIDDEN",
		"An authenticated user or service Principal is required",
		"Invalid work result command",
	)
}

func containsSensitiveProviderField(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			lower := strings.ToLower(key)
			if strings.Contains(lower, "authorization") || strings.Contains(lower, "credential") || strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "token") {
				return true
			}
			if containsSensitiveProviderField(item) {
				return true
			}
		}
	case []any:
		for _, item := range typed {
			if containsSensitiveProviderField(item) {
				return true
			}
		}
	}
	return false
}

func ValidateRecordHumanWorkResultInput(input *RecordHumanWorkResultInput) error {
	if !uuidPattern.MatchString(input.TargetID) || !uuidPattern.MatchString(input.TargetRevisionID) || !uuidPattern.MatchString(input.GraphRevisionID) || !uuidPattern.MatchString(input.WorkNodeID) {
		return validation("Human work result binding IDs must be UUIDs")
	}
	if err := validateAssuranceHash(&input.InputHash, "inputHash"); err != nil {
		return err
	}
	if input.Result == nil {
		return validation("result is required")
	}
	if containsSensitiveProviderField(input.Result) {
		return validation("result must not contain credentials")
	}
	if input.ArtifactRevisionID != nil {
		value := strings.TrimSpace(*input.ArtifactRevisionID)
		if !uuidPattern.MatchString(value) {
			return validation("artifactRevisionId must be a UUID")
		}
		input.ArtifactRevisionID = &value
	}
	if len(input.AttachmentHashes) > 100 {
		return validation("attachmentHashes may contain at most 100 entries")
	}
	if input.AttachmentHashes == nil {
		input.AttachmentHashes = []string{}
	}
	for index := range input.AttachmentHashes {
		if err := validateAssuranceHash(&input.AttachmentHashes[index], "attachmentHashes"); err != nil {
			return err
		}
	}
	return nil
}

func humanWorkResultHash(input RecordHumanWorkResultInput) (string, error) {
	payload, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), nil
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
	if utf8.RuneCountInString(params.Body) > 65536 {
		return validation("params.body must contain at most 65536 characters")
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

func ValidateGitHubCredentialTransport(connectionID, authorization string) error {
	if !uuidPattern.MatchString(strings.TrimSpace(connectionID)) {
		return validation("X-Verrail-GitHub-Connection-Id must be a UUID")
	}
	authorization = strings.TrimSpace(authorization)
	if len(authorization) > 8192 || strings.ContainsAny(authorization, "\r\n\x00") {
		return connectorCredentialsNotConfigured()
	}
	lower := strings.ToLower(authorization)
	if (!strings.HasPrefix(lower, "bearer ") && !strings.HasPrefix(lower, "token ")) || len(strings.Fields(authorization)) != 2 {
		return connectorCredentialsNotConfigured()
	}
	return nil
}

// pullRequestParamsHash derives the sha256 over the canonical JSON payload of
// {title, head, base, body}. The approval is parameter-bound to this digest.
func pullRequestParamsHash(params PullRequestParams) (string, error) {
	payload := map[string]any{
		"title": params.Title,
		"head":  params.Head,
		"base":  params.Base,
		"body":  params.Body,
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

func providerMarker(actionRequestID, paramsHash string) string {
	digest := sha256.Sum256([]byte("github:create_pull_request:" + actionRequestID + ":" + paramsHash))
	return hex.EncodeToString(digest[:])
}

func githubMarkerComment(marker string) string {
	return "<!-- verrail-effect:" + marker + " -->"
}

func githubPullRequestBody(body, marker string) string {
	comment := githubMarkerComment(marker)
	content := strings.TrimSpace(strings.ReplaceAll(body, comment, ""))
	if content == "" {
		return comment
	}
	return content + "\n\n" + comment
}

type PullRequestLookupStatus string

const (
	PullRequestFound        PullRequestLookupStatus = "found"
	PullRequestAbsent       PullRequestLookupStatus = "absent"
	PullRequestInconclusive PullRequestLookupStatus = "inconclusive"
)

type PullRequestLookup struct {
	Status           PullRequestLookupStatus
	ExternalObjectID string
	ExternalURL      string
}

type GitHubProviderError struct {
	Message   string
	Uncertain bool
}

func (err *GitHubProviderError) Error() string { return err.Message }

// GitHubClient abstracts the external GitHub API behind a single governed
// effect (spec.md product contract item 3). Tests use a fake; production uses
// the thin REST wrapper below.
type GitHubClient interface {
	LookupPullRequest(ctx context.Context, repo string, params PullRequestParams, marker string) (PullRequestLookup, error)
	CreatePullRequest(ctx context.Context, repo string, params PullRequestParams, marker string) (externalObjectID string, externalURL string, err error)
}

// GitHubRESTClient is the real thin REST wrapper against api.github.com. The
// token is injected at construction time by the control plane once workspace
// connection credentials can be resolved outside the Node secret provider;
// until then an empty token fails fast with a clear error and every test runs
// against a fake (documented deviation).
type GitHubRESTClient struct {
	apiBase       string
	authorization string
	httpClient    *http.Client
}

func NewGitHubRESTClient(apiBase, authorization string) *GitHubRESTClient {
	if apiBase == "" {
		apiBase = "https://api.github.com"
	}
	trimmed := strings.TrimSpace(authorization)
	if trimmed != "" && !strings.Contains(trimmed, " ") {
		trimmed = "Bearer " + trimmed
	}
	return &GitHubRESTClient{apiBase: strings.TrimRight(apiBase, "/"), authorization: trimmed, httpClient: &http.Client{Timeout: 30 * time.Second}}
}

func (client *GitHubRESTClient) setHeaders(request *http.Request) error {
	if strings.TrimSpace(client.authorization) == "" {
		return connectorCredentialsNotConfigured()
	}
	if !strings.HasPrefix(strings.ToLower(client.authorization), "bearer ") && !strings.HasPrefix(strings.ToLower(client.authorization), "token ") {
		return connectorCredentialsNotConfigured()
	}
	request.Header.Set("Authorization", client.authorization)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	return nil
}

func (client *GitHubRESTClient) LookupPullRequest(ctx context.Context, repo string, params PullRequestParams, marker string) (PullRequestLookup, error) {
	if strings.TrimSpace(client.authorization) == "" {
		return PullRequestLookup{}, connectorCredentialsNotConfigured()
	}
	repoOwner, _, ok := strings.Cut(repo, "/")
	if !ok || repoOwner == "" {
		return PullRequestLookup{Status: PullRequestInconclusive}, connectorUpstreamError("invalid GitHub repository binding")
	}
	head := params.Head
	if !strings.Contains(head, ":") {
		head = repoOwner + ":" + head
	}
	for page := 1; page <= 100; page++ {
		query := url.Values{
			"state":    {"all"},
			"head":     {head},
			"base":     {params.Base},
			"per_page": {"100"},
			"page":     {strconv.Itoa(page)},
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, client.apiBase+"/repos/"+repo+"/pulls?"+query.Encode(), nil)
		if err != nil {
			return PullRequestLookup{Status: PullRequestInconclusive}, connectorUpstreamError("build GitHub lookup request")
		}
		if err := client.setHeaders(request); err != nil {
			return PullRequestLookup{}, err
		}
		response, err := client.httpClient.Do(request)
		if err != nil {
			return PullRequestLookup{Status: PullRequestInconclusive}, &GitHubProviderError{Message: err.Error(), Uncertain: true}
		}
		payload, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
		_ = response.Body.Close()
		if readErr != nil {
			return PullRequestLookup{Status: PullRequestInconclusive}, &GitHubProviderError{Message: "read GitHub lookup response", Uncertain: true}
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return PullRequestLookup{Status: PullRequestInconclusive}, &GitHubProviderError{Message: fmt.Sprintf("GitHub lookup returned %d", response.StatusCode), Uncertain: response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500}
		}
		var pulls []struct {
			Number  int    `json:"number"`
			HTMLURL string `json:"html_url"`
			Body    string `json:"body"`
		}
		if err := json.Unmarshal(payload, &pulls); err != nil {
			return PullRequestLookup{Status: PullRequestInconclusive}, &GitHubProviderError{Message: "decode GitHub lookup response", Uncertain: true}
		}
		comment := githubMarkerComment(marker)
		for _, pull := range pulls {
			if pull.Number > 0 && strings.Contains(pull.Body, comment) {
				return PullRequestLookup{Status: PullRequestFound, ExternalObjectID: strconv.Itoa(pull.Number), ExternalURL: pull.HTMLURL}, nil
			}
		}
		if len(pulls) < 100 {
			return PullRequestLookup{Status: PullRequestAbsent}, nil
		}
	}
	return PullRequestLookup{Status: PullRequestInconclusive}, &GitHubProviderError{Message: "GitHub lookup exceeded the bounded page limit", Uncertain: true}
}

func (client *GitHubRESTClient) CreatePullRequest(ctx context.Context, repo string, params PullRequestParams, marker string) (string, string, error) {
	if strings.TrimSpace(client.authorization) == "" {
		return "", "", connectorCredentialsNotConfigured()
	}
	body, err := json.Marshal(map[string]string{"title": params.Title, "head": params.Head, "base": params.Base, "body": githubPullRequestBody(params.Body, marker)})
	if err != nil {
		return "", "", connectorUpstreamError("encode pull request payload")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.apiBase+"/repos/"+repo+"/pulls", strings.NewReader(string(body)))
	if err != nil {
		return "", "", connectorUpstreamError("build GitHub request")
	}
	if err := client.setHeaders(request); err != nil {
		return "", "", err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return "", "", &GitHubProviderError{Message: err.Error(), Uncertain: true}
	}
	defer func() { _ = response.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", "", &GitHubProviderError{Message: "read GitHub response", Uncertain: true}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", "", &GitHubProviderError{Message: fmt.Sprintf("GitHub returned %d: %s", response.StatusCode, strings.TrimSpace(string(payload))), Uncertain: response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500}
	}
	var created struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.Unmarshal(payload, &created); err != nil || created.Number == 0 {
		return "", "", &GitHubProviderError{Message: "GitHub response did not contain a pull request number", Uncertain: true}
	}
	return fmt.Sprintf("%d", created.Number), created.HTMLURL, nil
}
