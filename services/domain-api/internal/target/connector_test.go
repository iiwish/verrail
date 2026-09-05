package target

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestRecordIntegrationRunInputValidation(t *testing.T) {
	valid := RecordIntegrationRunInput{
		TargetID:         "22222222-2222-4222-8222-222222222222",
		TargetRevisionID: "33333333-3333-4333-8333-333333333333",
		GraphRevisionID:  "44444444-4444-4444-8444-444444444444",
		ClaimID:          "55555555-5555-4555-8555-555555555555",
		WorkNodeID:       "66666666-6666-4666-8666-666666666666",
		ConnectorVersion: "github-actions.v1",
		ConnectionID:     "77777777-7777-4777-8777-777777777777",
		Provider:         "github",
		ExternalRef:      "run/1234",
		CommitRef:        "abc123",
		CriterionKey:     "ac-1",
		EnvironmentRef:   "github-actions:ubuntu-24.04",
		Conclusion:       "success",
		ObjectHash:       assuranceTestHash,
		Reference:        "ci/build/1234",
		ProviderReceipt:  map[string]any{"runId": 1234},
	}
	require.NoError(t, ValidateRecordIntegrationRunInput(&valid))

	badProvider := valid
	badProvider.Provider = "gitlab"
	require.Error(t, ValidateRecordIntegrationRunInput(&badProvider))

	badConclusion := valid
	badConclusion.Conclusion = "skipped"
	require.Error(t, ValidateRecordIntegrationRunInput(&badConclusion))

	badHash := valid
	badHash.ObjectHash = "XYZ"
	require.Error(t, ValidateRecordIntegrationRunInput(&badHash))

	badWorkNode := valid
	badWorkNode.WorkNodeID = "not-a-uuid"
	require.Error(t, ValidateRecordIntegrationRunInput(&badWorkNode))

	emptyRef := valid
	emptyRef.ExternalRef = ""
	require.Error(t, ValidateRecordIntegrationRunInput(&emptyRef))

	longReference := valid
	longReference.Reference = strings.Repeat("x", 501)
	require.Error(t, ValidateRecordIntegrationRunInput(&longReference))

	secretReceipt := valid
	secretReceipt.ProviderReceipt = map[string]any{"nested": map[string]any{"accessToken": "do-not-store"}}
	require.Error(t, ValidateRecordIntegrationRunInput(&secretReceipt))
}

func TestRecordHumanWorkResultInputValidation(t *testing.T) {
	valid := RecordHumanWorkResultInput{
		TargetID:         "22222222-2222-4222-8222-222222222222",
		TargetRevisionID: "33333333-3333-4333-8333-333333333333",
		GraphRevisionID:  "44444444-4444-4444-8444-444444444444",
		WorkNodeID:       "55555555-5555-4555-8555-555555555555",
		InputHash:        assuranceTestHash,
		Result:           map[string]any{"decision": "ready"},
		AttachmentHashes: []string{"2222222222222222222222222222222222222222222222222222222222222222"},
	}
	require.NoError(t, ValidateRecordHumanWorkResultInput(&valid))

	badNode := valid
	badNode.WorkNodeID = "not-a-uuid"
	require.Error(t, ValidateRecordHumanWorkResultInput(&badNode))

	badInput := valid
	badInput.InputHash = "bad"
	require.Error(t, ValidateRecordHumanWorkResultInput(&badInput))

	missingResult := valid
	missingResult.Result = nil
	require.Error(t, ValidateRecordHumanWorkResultInput(&missingResult))

	secretResult := valid
	secretResult.Result = map[string]any{"nested": map[string]any{"secret": "do-not-store"}}
	require.Error(t, ValidateRecordHumanWorkResultInput(&secretResult))
}

func TestAgentRunRejectsIntegrationRunKind(t *testing.T) {
	command := CreateRunCommand{
		WorkspaceID:     "11111111-1111-4111-8111-111111111111",
		TargetID:        "22222222-2222-4222-8222-222222222222",
		GraphRevisionID: "33333333-3333-4333-8333-333333333333",
		WorkNodeID:      "44444444-4444-4444-8444-444444444444",
		Principal:       Principal{Type: "user", ID: "human-1"},
		IdempotencyKey:  "agent-run-kind-test",
		Input: CreateRunInput{
			Kind:  "integration_run",
			Actor: ResponsiblePrincipal{PrincipalType: "service", PrincipalID: "connector-1"},
		},
	}
	requireLifecycleCode(t, ValidateCreateRunCommand(&command), "TARGET_COMMAND_INVALID")
}

func TestResultLifecyclePrincipalBoundary(t *testing.T) {
	base := AgentLifecycleCommand[RecordIntegrationRunInput]{
		WorkspaceID:    "11111111-1111-4111-8111-111111111111",
		Principal:      Principal{Type: "service", ID: "github-connector"},
		IdempotencyKey: "integration-result-principal",
		CommandType:    ConnectorIntegrationRunRecordCommand,
	}
	require.NoError(t, ValidateResultLifecycleCommand(&base))

	agent := base
	agent.Principal = Principal{Type: "agent", ID: "agent-1"}
	requireLifecycleCode(t, ValidateResultLifecycleCommand(&agent), "WORK_RESULT_COMMAND_FORBIDDEN")
}

func TestRequestPullRequestActionInputValidation(t *testing.T) {
	valid := RequestPullRequestActionInput{
		TargetID:     "22222222-2222-4222-8222-222222222222",
		SubmissionID: "33333333-3333-4333-8333-333333333333",
		Params:       PullRequestParams{Title: "Merge feature", Head: "feat/x", Base: "main"},
	}
	require.NoError(t, ValidateRequestPullRequestActionInput(&valid))

	badSubmission := valid
	badSubmission.SubmissionID = "not-a-uuid"
	require.Error(t, ValidateRequestPullRequestActionInput(&badSubmission))

	blankHead := valid
	blankHead.Params.Head = "   "
	require.Error(t, ValidateRequestPullRequestActionInput(&blankHead))

	longBase := valid
	longBase.Params.Base = strings.Repeat("x", 201)
	require.Error(t, ValidateRequestPullRequestActionInput(&longBase))
}

func TestApproveActionInputValidation(t *testing.T) {
	valid := ApproveActionInput{
		ActionRequestID:       "22222222-2222-4222-8222-222222222222",
		ApproverPrincipalType: "user",
		ApproverPrincipalID:   "approver-1",
		ParamsHash:            assuranceTestHash,
	}
	require.NoError(t, ValidateApproveActionInput(&valid))

	badRequest := valid
	badRequest.ActionRequestID = "not-a-uuid"
	require.Error(t, ValidateApproveActionInput(&badRequest))

	agentApprover := valid
	agentApprover.ApproverPrincipalType = "agent"
	require.Error(t, ValidateApproveActionInput(&agentApprover))

	emptyApprover := valid
	emptyApprover.ApproverPrincipalID = ""
	require.Error(t, ValidateApproveActionInput(&emptyApprover))

	badHash := valid
	badHash.ParamsHash = "nope"
	require.Error(t, ValidateApproveActionInput(&badHash))
}

func TestExecuteActionInputValidation(t *testing.T) {
	valid := ExecuteActionInput{ActionRequestID: "22222222-2222-4222-8222-222222222222"}
	require.NoError(t, ValidateExecuteActionInput(&valid))
	bad := valid
	bad.ActionRequestID = "not-a-uuid"
	require.Error(t, ValidateExecuteActionInput(&bad))
}

func TestConnectorConclusionVerdict(t *testing.T) {
	verdict, ok := connectorConclusionVerdict("success")
	require.True(t, ok)
	require.Equal(t, "passed", verdict)

	verdict, ok = connectorConclusionVerdict("failure")
	require.True(t, ok)
	require.Equal(t, "failed", verdict)

	_, ok = connectorConclusionVerdict("neutral")
	require.False(t, ok, "neutral runs must not assert a verification result")
}

func TestPullRequestParamsHashCanonical(t *testing.T) {
	base, err := pullRequestParamsHash(PullRequestParams{Title: "Merge feature", Head: "feat/x", Base: "main"})
	require.NoError(t, err)
	require.Regexp(t, `^[0-9a-f]{64}$`, base)

	again, err := pullRequestParamsHash(PullRequestParams{Title: "Merge feature", Head: "feat/x", Base: "main"})
	require.NoError(t, err)
	require.Equal(t, base, again)

	changed, err := pullRequestParamsHash(PullRequestParams{Title: "Merge feature", Head: "feat/x", Base: "develop"})
	require.NoError(t, err)
	require.NotEqual(t, base, changed)

	changedBody, err := pullRequestParamsHash(PullRequestParams{Title: "Merge feature", Head: "feat/x", Base: "main", Body: "A reviewed body"})
	require.NoError(t, err)
	require.NotEqual(t, base, changedBody)
}

func TestEffectHashCanonical(t *testing.T) {
	base, err := effectHash("22222222-2222-4222-8222-222222222222", assuranceTestHash, "42")
	require.NoError(t, err)
	require.Regexp(t, `^[0-9a-f]{64}$`, base)

	again, err := effectHash("22222222-2222-4222-8222-222222222222", assuranceTestHash, "42")
	require.NoError(t, err)
	require.Equal(t, base, again)

	changed, err := effectHash("22222222-2222-4222-8222-222222222222", assuranceTestHash, "43")
	require.NoError(t, err)
	require.NotEqual(t, base, changed)
}

func TestGitHubRESTClientWithoutTokenFailsFast(t *testing.T) {
	client := NewGitHubRESTClient("", "")
	_, _, err := client.CreatePullRequest(context.Background(), "owner/repo", PullRequestParams{Title: "t", Head: "h", Base: "b"}, "marker")
	domainError := AsError(err)
	require.Equal(t, 502, domainError.Status)
	require.Equal(t, "CONNECTOR_CREDENTIALS_NOT_CONFIGURED", domainError.Code)
}

func TestGitHubPullRequestBodyContainsMarkerExactlyOnce(t *testing.T) {
	const marker = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	comment := githubMarkerComment(marker)
	require.Equal(t, comment, githubPullRequestBody("", marker))
	require.Equal(t, "Template\n\n"+comment, githubPullRequestBody("Template\n", marker))
	require.Equal(t, "Template\n\n"+comment, githubPullRequestBody("Template\n\n"+comment+"\n"+comment, marker))
}

func TestGitHubCredentialTransportValidation(t *testing.T) {
	require.NoError(t, ValidateGitHubCredentialTransport("22222222-2222-4222-8222-222222222222", "Bearer short-lived"))
	require.Equal(t, "TARGET_COMMAND_INVALID", AsError(ValidateGitHubCredentialTransport("not-a-uuid", "Bearer short-lived")).Code)
	require.Equal(t, "CONNECTOR_CREDENTIALS_NOT_CONFIGURED", AsError(ValidateGitHubCredentialTransport("22222222-2222-4222-8222-222222222222", "")).Code)
	require.Equal(t, "CONNECTOR_CREDENTIALS_NOT_CONFIGURED", AsError(ValidateGitHubCredentialTransport("22222222-2222-4222-8222-222222222222", "Bearer value\nleak")).Code)
}

func TestGitHubRESTClientMarkerCreateAndLookup(t *testing.T) {
	const marker = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		require.Equal(t, "Bearer ephemeral", request.Header.Get("Authorization"))
		response.Header().Set("Content-Type", "application/json")
		switch request.Method {
		case http.MethodGet:
			require.Equal(t, "owner:feat/marker", request.URL.Query().Get("head"))
			_ = json.NewEncoder(response).Encode([]map[string]any{{
				"number":   42,
				"html_url": "https://github.com/owner/repo/pull/42",
				"body":     githubMarkerComment(marker),
			}})
		case http.MethodPost:
			var body map[string]string
			require.NoError(t, json.NewDecoder(request.Body).Decode(&body))
			require.Equal(t, "## Verification\n\n- Passed\n\n"+githubMarkerComment(marker), body["body"])
			_ = json.NewEncoder(response).Encode(map[string]any{"number": 42, "html_url": "https://github.com/owner/repo/pull/42"})
		default:
			response.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	client := NewGitHubRESTClient(server.URL, "Bearer ephemeral")
	params := PullRequestParams{Title: "Marker", Head: "feat/marker", Base: "main", Body: "## Verification\n\n- Passed"}

	lookup, err := client.LookupPullRequest(context.Background(), "owner/repo", params, marker)
	require.NoError(t, err)
	require.Equal(t, PullRequestFound, lookup.Status)
	require.Equal(t, "42", lookup.ExternalObjectID)
	objectID, externalURL, err := client.CreatePullRequest(context.Background(), "owner/repo", params, marker)
	require.NoError(t, err)
	require.Equal(t, "42", objectID)
	require.Equal(t, "https://github.com/owner/repo/pull/42", externalURL)
	require.Equal(t, 2, requests)
}

type fakeGitHubClient struct {
	calls         int
	lookupCalls   int
	lastRepo      string
	lastParams    PullRequestParams
	lastMarker    string
	objectID      string
	url           string
	err           error
	lookupResults []PullRequestLookup
	lookupErrors  []error
}

func (fake *fakeGitHubClient) LookupPullRequest(_ context.Context, repo string, params PullRequestParams, marker string) (PullRequestLookup, error) {
	fake.lookupCalls++
	fake.lastRepo = repo
	fake.lastParams = params
	fake.lastMarker = marker
	if len(fake.lookupErrors) > 0 {
		err := fake.lookupErrors[0]
		fake.lookupErrors = fake.lookupErrors[1:]
		if err != nil {
			return PullRequestLookup{Status: PullRequestInconclusive}, err
		}
	}
	if len(fake.lookupResults) > 0 {
		result := fake.lookupResults[0]
		fake.lookupResults = fake.lookupResults[1:]
		return result, nil
	}
	return PullRequestLookup{Status: PullRequestAbsent}, nil
}

func (fake *fakeGitHubClient) CreatePullRequest(_ context.Context, repo string, params PullRequestParams, marker string) (string, string, error) {
	fake.calls++
	fake.lastRepo = repo
	fake.lastParams = params
	fake.lastMarker = marker
	if fake.err != nil {
		return "", "", fake.err
	}
	return fake.objectID, fake.url, nil
}

type connectorTestHarness struct {
	*assuranceTestHarness
	storeWithFake       *Store
	fake                *fakeGitHubClient
	approverID          string
	runIDs              []string
	humanResultIDs      []string
	actionRequestIDs    []string
	submissionIDs       []string
	connectionIDs       []string
	applicationIDs      []string
	foreignWorkspaceIDs []string
}

func newConnectorTestHarness(t *testing.T, pool *pgxpool.Pool) *connectorTestHarness {
	t.Helper()
	assurance := newAssuranceTestHarness(t, pool)
	approverID := "connector-contract-test-approver"
	_, err := pool.Exec(context.Background(), `
		insert into company_memberships (company_id, principal_type, principal_id, status, membership_role)
		values ($1, 'user', $2, 'active', 'member')
	`, assurance.workspaceID, approverID)
	require.NoError(t, err)
	fake := &fakeGitHubClient{objectID: "42", url: "https://github.com/owner/repo/pull/42"}
	return &connectorTestHarness{
		assuranceTestHarness: assurance,
		storeWithFake:        NewStore(pool, WithGitHubClient(fake)),
		fake:                 fake,
		approverID:           approverID,
	}
}

func buildConnectorCommandAs[T any](h *connectorTestHarness, principalID string, commandType string, input T) AgentLifecycleCommand[T] {
	h.t.Helper()
	idempotencyKey := "connector-it-" + mustNewUUID(h.t)
	h.receiptKeys = append(h.receiptKeys, idempotencyKey)
	command := AgentLifecycleCommand[T]{
		WorkspaceID:    h.workspaceID,
		Principal:      Principal{Type: "user", ID: principalID},
		IdempotencyKey: idempotencyKey,
		CommandType:    commandType,
		Input:          input,
	}
	if err := ValidateAgentLifecycleCommand(&command); err != nil {
		h.t.Fatalf("validate %s command: %v", commandType, err)
	}
	return command
}

func buildConnectorCandidateCommandAs[T any](h *connectorTestHarness, principalType, principalID, commandType string, input T) AgentLifecycleCommand[T] {
	h.t.Helper()
	idempotencyKey := "connector-it-" + mustNewUUID(h.t)
	h.receiptKeys = append(h.receiptKeys, idempotencyKey)
	command := AgentLifecycleCommand[T]{
		WorkspaceID:    h.workspaceID,
		Principal:      Principal{Type: principalType, ID: principalID},
		IdempotencyKey: idempotencyKey,
		CommandType:    commandType,
		Input:          input,
	}
	if err := ValidateCandidateLifecycleCommand(&command); err != nil {
		h.t.Fatalf("validate %s candidate command: %v", commandType, err)
	}
	return command
}

func buildConnectorResultCommandAs[T any](h *connectorTestHarness, principalType, principalID, commandType string, input T) AgentLifecycleCommand[T] {
	h.t.Helper()
	idempotencyKey := "connector-it-" + mustNewUUID(h.t)
	h.receiptKeys = append(h.receiptKeys, idempotencyKey)
	command := AgentLifecycleCommand[T]{
		WorkspaceID:    h.workspaceID,
		Principal:      Principal{Type: principalType, ID: principalID},
		IdempotencyKey: idempotencyKey,
		CommandType:    commandType,
		Input:          input,
	}
	if err := ValidateResultLifecycleCommand(&command); err != nil {
		h.t.Fatalf("validate %s result command: %v", commandType, err)
	}
	return command
}

func (h *connectorTestHarness) recordIntegrationRun(input RecordIntegrationRunInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	result, err := h.storeWithFake.RecordIntegrationRun(context.Background(), buildConnectorResultCommandAs(h, "service", "github-connector", ConnectorIntegrationRunRecordCommand, input))
	if err == nil {
		h.runIDs = append(h.runIDs, result.ResourceID)
	}
	return result, err
}

func (h *connectorTestHarness) recordHumanWorkResult(input RecordHumanWorkResultInput) (AgentLifecycleResult, AgentLifecycleCommand[RecordHumanWorkResultInput], error) {
	h.t.Helper()
	require.NoError(h.t, ValidateRecordHumanWorkResultInput(&input))
	command := buildConnectorCommandAs(h, h.principalID, ConnectorHumanWorkResultRecordCommand, input)
	result, err := h.storeWithFake.RecordHumanWorkResult(context.Background(), command)
	if err == nil {
		h.humanResultIDs = append(h.humanResultIDs, result.ResourceID)
	}
	return result, command, err
}

func (h *connectorTestHarness) requestAction(input RequestPullRequestActionInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	result, err := h.storeWithFake.RequestPullRequestAction(context.Background(), buildConnectorCommandAs(h, h.principalID, ConnectorActionRequestCreateCommand, input))
	if err == nil {
		h.actionRequestIDs = append(h.actionRequestIDs, result.ResourceID)
	}
	return result, err
}

func (h *connectorTestHarness) requestActionAs(principalType, principalID string, input RequestPullRequestActionInput) (AgentLifecycleResult, AgentLifecycleCommand[RequestPullRequestActionInput], error) {
	h.t.Helper()
	command := buildConnectorCandidateCommandAs(h, principalType, principalID, ConnectorActionRequestCreateCommand, input)
	result, err := h.storeWithFake.RequestPullRequestAction(context.Background(), command)
	if err == nil {
		h.actionRequestIDs = append(h.actionRequestIDs, result.ResourceID)
	}
	return result, command, err
}

func (h *connectorTestHarness) approveActionAs(principalID string, input ApproveActionInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	return h.storeWithFake.ApproveAction(context.Background(), buildConnectorCommandAs(h, principalID, ConnectorActionApproveCommand, input))
}

func (h *connectorTestHarness) executeAction(input ExecuteActionInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	return h.storeWithFake.ExecuteAction(context.Background(), buildConnectorCommandAs(h, h.principalID, ConnectorActionExecuteCommand, input))
}

type connectorTaskFixture struct {
	targetID, targetRevisionID, graphRevisionID, workNodeID, claimID, criterionKey string
}

func (h *connectorTestHarness) provisionTask(kind string) connectorTaskFixture {
	h.t.Helper()
	targetID, targetRevisionID := h.createTarget()
	criterionKey := "ac-connector-run"
	claimID := h.createClaim(targetID, targetRevisionID, criterionKey)
	completion := "Record the version-bound task result."
	create := CreateGraphRevisionCommand{
		WorkspaceID:    h.workspaceID,
		TargetID:       targetID,
		Principal:      Principal{Type: "user", ID: h.principalID},
		IdempotencyKey: "connector-graph-" + mustNewUUID(h.t),
		Input: CreateGraphRevisionInput{
			ExpectedTargetRevisionID: targetRevisionID,
			Nodes: []WorkNodeInput{{
				NodeKey:              "work",
				Kind:                 kind,
				Stage:                "verify",
				Title:                "Connector test work",
				CompletionDefinition: &completion,
			}},
		},
	}
	require.NoError(h.t, ValidateCreateGraphRevisionCommand(&create))
	created, err := h.store.CreateGraphRevision(context.Background(), create)
	require.NoError(h.t, err)
	activate := ActivateGraphRevisionCommand{
		WorkspaceID:     h.workspaceID,
		TargetID:        targetID,
		GraphRevisionID: created.GraphRevisionID,
		Principal:       Principal{Type: "user", ID: h.principalID},
		IdempotencyKey:  "connector-activate-" + mustNewUUID(h.t),
	}
	require.NoError(h.t, ValidateActivationCommand(&activate))
	_, err = h.store.ActivateGraphRevision(context.Background(), activate)
	require.NoError(h.t, err)
	var workNodeID string
	require.NoError(h.t, h.pool.QueryRow(context.Background(), `select id from verrail_work_nodes where graph_revision_id=$1 and node_key='work'`, created.GraphRevisionID).Scan(&workNodeID))
	return connectorTaskFixture{targetID, targetRevisionID, created.GraphRevisionID, workNodeID, claimID, criterionKey}
}

func (h *connectorTestHarness) integrationRunInput(fixture connectorTaskFixture, externalRef, conclusion, objectHash, reference string) RecordIntegrationRunInput {
	h.t.Helper()
	require.NotEmpty(h.t, h.connectionIDs)
	return RecordIntegrationRunInput{
		TargetID:         fixture.targetID,
		TargetRevisionID: fixture.targetRevisionID,
		GraphRevisionID:  fixture.graphRevisionID,
		ClaimID:          fixture.claimID,
		WorkNodeID:       fixture.workNodeID,
		ConnectorVersion: "github-actions.v1",
		ConnectionID:     h.connectionIDs[0],
		Provider:         "github",
		ExternalRef:      externalRef,
		CommitRef:        "abc123",
		CriterionKey:     fixture.criterionKey,
		EnvironmentRef:   "github-actions:ubuntu-24.04",
		Conclusion:       conclusion,
		ObjectHash:       objectHash,
		Reference:        reference,
		ProviderReceipt:  map[string]any{"externalRef": externalRef, "conclusion": conclusion},
	}
}

// createAcceptedSubmission provisions the full assurance chain (artifact,
// revision, claim, evidence, verification result) and records a Submission
// whose derived acceptance validity is "valid" on a fresh target.
func (h *connectorTestHarness) createAcceptedSubmission(contentHash string) (string, string, string) {
	h.t.Helper()
	targetID, targetRevisionID := h.createTarget()
	artifactID := h.createArtifact(targetID)
	revision, err := h.addRevision(artifactID, AddArtifactRevisionInput{ContentHash: contentHash, ContentRef: "git:" + contentHash[:8]})
	require.NoError(h.t, err)
	claimID := h.createClaim(targetID, targetRevisionID, "ac-connector")
	evidenceID := h.recordEvidence(targetID, &claimID, contentHash)
	_, err = h.recordVerificationResult(RecordVerificationResultInput{
		ClaimID:         claimID,
		Verdict:         "passed",
		VerifierVersion: "ci.v1",
		EvidenceIDs:     []string{evidenceID},
	})
	require.NoError(h.t, err)
	submission, err := h.store.CreateSubmission(context.Background(), buildAssuranceCommand(h.assuranceTestHarness, AdjudicationSubmissionCreateCommand, "", CreateSubmissionInput{
		TargetID:              targetID,
		TargetRevisionID:      targetRevisionID,
		ArtifactRevisionIDs:   []string{revision.ResourceID},
		VerificationResultIDs: []string{},
		CommitRef:             ptr("git:" + contentHash[:12]),
	}))
	require.NoError(h.t, err)
	h.submissionIDs = append(h.submissionIDs, submission.ResourceID)
	review, err := h.store.RecordDeliveryReview(context.Background(), buildConnectorCommandAs(h, h.approverID, AdjudicationReviewRecordCommand, RecordDeliveryReviewInput{
		SubmissionID:          submission.ResourceID,
		ReviewerPrincipalType: "user",
		ReviewerPrincipalID:   h.approverID,
		Verdict:               "approved",
		UnprovenItems:         []string{},
	}))
	require.NoError(h.t, err)
	_, err = h.store.AcceptSubmission(context.Background(), buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{
		SubmissionID: submission.ResourceID,
		ReviewID:     review.ResourceID,
	}))
	require.NoError(h.t, err)
	return targetID, targetRevisionID, submission.ResourceID
}

// supersedeSubmission records a second submission for the target so the
// previous submission is no longer the latest.
func (h *connectorTestHarness) supersedeSubmission(targetID, previousSubmissionID string) (string, error) {
	h.t.Helper()
	ctx := context.Background()
	var targetRevisionID string
	var artifactRevisionIDs []string
	if err := h.pool.QueryRow(ctx, `select target_revision_id, artifact_revision_ids from verrail_submissions where id=$1`, previousSubmissionID).Scan(&targetRevisionID, &artifactRevisionIDs); err != nil {
		return "", err
	}
	var artifactID string
	if err := h.pool.QueryRow(ctx, `select artifact_id from verrail_artifact_revisions where id=$1`, artifactRevisionIDs[0]).Scan(&artifactID); err != nil {
		return "", err
	}
	freshHash := strings.Repeat(strings.ReplaceAll(mustNewUUID(h.t), "-", ""), 2)
	revision, err := h.addRevision(artifactID, AddArtifactRevisionInput{ContentHash: freshHash, ContentRef: "git:supersede"})
	if err != nil {
		return "", err
	}
	submission, err := h.store.CreateSubmission(ctx, buildAssuranceCommand(h.assuranceTestHarness, AdjudicationSubmissionCreateCommand, "", CreateSubmissionInput{
		TargetID:              targetID,
		TargetRevisionID:      targetRevisionID,
		ArtifactRevisionIDs:   []string{revision.ResourceID},
		VerificationResultIDs: []string{},
		CommitRef:             ptr("git:" + freshHash[:12]),
	}))
	if err != nil {
		return "", err
	}
	h.submissionIDs = append(h.submissionIDs, submission.ResourceID)
	review, err := h.store.RecordDeliveryReview(ctx, buildConnectorCommandAs(h, h.approverID, AdjudicationReviewRecordCommand, RecordDeliveryReviewInput{
		SubmissionID:          submission.ResourceID,
		ReviewerPrincipalType: "user",
		ReviewerPrincipalID:   h.approverID,
		Verdict:               "approved",
		UnprovenItems:         []string{},
	}))
	if err != nil {
		return "", err
	}
	if _, err := h.store.AcceptSubmission(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{SubmissionID: submission.ResourceID, ReviewID: review.ResourceID})); err != nil {
		return "", err
	}
	return submission.ResourceID, nil
}

// rotateActiveRevision inserts a second target revision and promotes it, so
// submissions bound to the previous revision derive an invalid acceptance.
// Nothing in the G1/G2 domain API promotes a target revision yet, so the
// harness applies the promotion directly — the same direct-state pattern as
// the foreign-evidence insert.
func (h *connectorTestHarness) rotateActiveRevision(targetID string) error {
	h.t.Helper()
	ctx := context.Background()
	newRevisionID := mustNewUUID(h.t)
	freshHash := strings.Repeat(strings.ReplaceAll(mustNewUUID(h.t), "-", ""), 2)
	if _, err := h.pool.Exec(ctx, `
		insert into verrail_target_revisions (id, workspace_id, target_id, revision_number, title, outcome_owner_principal_type, outcome_owner_principal_id, goal, constraints, acceptance_criteria, risk_level, content_hash, created_by_principal_type, created_by_principal_id)
		select $1, workspace_id, target_id, revision_number + 1, title, outcome_owner_principal_type, outcome_owner_principal_id, goal, constraints, acceptance_criteria, risk_level, $2, 'user', $3
		from verrail_target_revisions where target_id = $4 order by revision_number desc limit 1
	`, newRevisionID, freshHash, h.principalID, targetID); err != nil {
		return err
	}
	_, err := h.pool.Exec(ctx, `update verrail_targets set active_target_revision_id=$1 where id=$2`, newRevisionID, targetID)
	return err
}

func (h *connectorTestHarness) bindGitHubConnection() {
	h.t.Helper()
	ctx := context.Background()
	applicationID := mustNewUUID(h.t)
	_, err := h.pool.Exec(ctx, `
		insert into tool_applications (id, company_id, name, type, status)
		values ($1, $2, 'connector-test-app', 'a2a', 'active')
	`, applicationID, h.workspaceID)
	require.NoError(h.t, err)
	h.applicationIDs = append(h.applicationIDs, applicationID)
	connectionID := mustNewUUID(h.t)
	_, err = h.pool.Exec(ctx, `
		insert into tool_connections (id, company_id, application_id, name, uid, transport, status, enabled)
		values ($1, $2, $3, 'connector-test-connection', $4, 'rest_api', 'active', true)
	`, connectionID, h.workspaceID, applicationID, "connector-test-"+mustNewUUID(h.t))
	require.NoError(h.t, err)
	h.connectionIDs = append(h.connectionIDs, connectionID)
	_, err = h.pool.Exec(ctx, `
		insert into verrail_github_repo_bindings (id, workspace_id, connection_id, repo_owner, repo_name, created_by_principal_type, created_by_principal_id)
		values ($1, $2, $3, 'owner', 'repo', 'user', $4)
	`, mustNewUUID(h.t), h.workspaceID, connectionID, h.principalID)
	require.NoError(h.t, err)
}

func (h *connectorTestHarness) actionStatus(actionRequestID string) string {
	h.t.Helper()
	var status string
	if err := h.pool.QueryRow(context.Background(), `select status from verrail_action_requests where id=$1`, actionRequestID).Scan(&status); err != nil {
		h.t.Fatalf("read action request status: %v", err)
	}
	return status
}

func (h *connectorTestHarness) createApprovedAction(targetID, submissionID string, params PullRequestParams) AgentLifecycleResult {
	h.t.Helper()
	request, err := h.requestAction(RequestPullRequestActionInput{TargetID: targetID, SubmissionID: submissionID, Params: params})
	require.NoError(h.t, err)
	var paramsHash string
	require.NoError(h.t, h.pool.QueryRow(context.Background(), `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&paramsHash))
	_, err = h.approveActionAs(h.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: h.approverID, ParamsHash: paramsHash})
	require.NoError(h.t, err)
	return request
}

func (h *connectorTestHarness) cleanup(pool *pgxpool.Pool) {
	ctx := context.Background()
	cleanups := []func(){
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_human_work_results where workspace_id=$1 and id = any($2::uuid[])`, h.workspaceID, h.humanResultIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_effect_receipts where workspace_id=$1 and action_request_id = any($2::uuid[])`, h.workspaceID, h.actionRequestIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_action_approvals where workspace_id=$1 and action_request_id = any($2::uuid[])`, h.workspaceID, h.actionRequestIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_integration_attempts where workspace_id=$1 and integration_run_id = any($2::uuid[])`, h.workspaceID, h.runIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_integration_runs where workspace_id=$1 and id = any($2::uuid[])`, h.workspaceID, h.runIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_action_requests where workspace_id=$1 and id = any($2::uuid[])`, h.workspaceID, h.actionRequestIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_github_repo_bindings where workspace_id=$1`, h.workspaceID)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from tool_connections where id = any($1::uuid[])`, h.connectionIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from tool_applications where id = any($1::uuid[])`, h.applicationIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_acceptances where workspace_id=$1 and submission_id = any($2::uuid[])`, h.workspaceID, h.submissionIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_delivery_reviews where workspace_id=$1 and submission_id = any($2::uuid[])`, h.workspaceID, h.submissionIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_submissions where workspace_id=$1 and id = any($2::uuid[])`, h.workspaceID, h.submissionIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_command_receipts where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.approverID, h.receiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_command_receipts where workspace_id=$1 and idempotency_key = any($2)`, h.workspaceID, h.receiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_audit_events where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.approverID, h.receiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_audit_events where workspace_id=$1 and idempotency_key = any($2)`, h.workspaceID, h.receiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from company_memberships where company_id=$1 and principal_id=$2`, h.workspaceID, h.approverID)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from companies where id = any($1::uuid[])`, h.foreignWorkspaceIDs)
		},
	}
	for _, cleanup := range cleanups {
		cleanup()
	}
	h.assuranceTestHarness.cleanup(pool)
}

func TestConnectorContractsIntegration(t *testing.T) {
	databaseURL := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	require.NoError(t, err)
	defer pool.Close()

	harness := newConnectorTestHarness(t, pool)
	defer harness.cleanup(pool)
	harness.bindGitHubConnection()

	t.Run("integration run binds CI evidence and verification result atomically", func(t *testing.T) {
		fixture := harness.provisionTask("integration_task")
		result, err := harness.recordIntegrationRun(harness.integrationRunInput(fixture, "run/1234", "success", assuranceTestHash, "ci/build/1234"))
		require.NoError(t, err)
		require.False(t, result.Replayed)
		require.Equal(t, "integration_run", result.ResourceType)

		var verificationResultID *string
		var kind, producerType, producerID, trustLevel, creatorType, creatorID string
		require.NoError(t, pool.QueryRow(ctx, `
			select run.verification_result_id, evidence.kind, evidence.producer_principal_type, evidence.producer_principal_id, evidence.trust_level, run.created_by_principal_type, run.created_by_principal_id
			from verrail_integration_runs run
			join verrail_evidence evidence on evidence.id = run.evidence_id and evidence.workspace_id = run.workspace_id
			where run.id = $1
		`, result.ResourceID).Scan(&verificationResultID, &kind, &producerType, &producerID, &trustLevel, &creatorType, &creatorID))
		require.NotNil(t, verificationResultID)
		require.Equal(t, "ci_result", kind)
		require.Equal(t, "service", producerType)
		require.Equal(t, "integration-run", producerID)
		require.Equal(t, "high", trustLevel)
		require.Equal(t, "service", creatorType)
		require.Equal(t, "github-connector", creatorID)

		var verdict, verifierVersion string
		require.NoError(t, pool.QueryRow(ctx, `select verdict, verifier_version from verrail_verification_results where id=$1`, *verificationResultID).Scan(&verdict, &verifierVersion))
		require.Equal(t, "passed", verdict)
		require.Equal(t, "integration-run.v1", verifierVersion)
		require.Equal(t, "supported", harness.claimStatus(fixture.claimID))

		var targetRevisionID, graphRevisionID, connectorVersion, connectionID, commitRef, criterionKey, environmentRef string
		var providerReceipt map[string]any
		require.NoError(t, pool.QueryRow(ctx, `select target_revision_id,graph_revision_id,connector_version,connection_id,commit_ref,criterion_key,environment_ref,provider_receipt from verrail_integration_runs where id=$1`, result.ResourceID).Scan(&targetRevisionID, &graphRevisionID, &connectorVersion, &connectionID, &commitRef, &criterionKey, &environmentRef, &providerReceipt))
		require.Equal(t, fixture.targetRevisionID, targetRevisionID)
		require.Equal(t, fixture.graphRevisionID, graphRevisionID)
		require.Equal(t, "github-actions.v1", connectorVersion)
		require.Equal(t, harness.connectionIDs[0], connectionID)
		require.Equal(t, "abc123", commitRef)
		require.Equal(t, fixture.criterionKey, criterionKey)
		require.Equal(t, "github-actions:ubuntu-24.04", environmentRef)
		require.Equal(t, "run/1234", providerReceipt["externalRef"])

		var attemptNumber int
		var attemptStatus, attemptVersion, attemptConnection, attemptRef string
		var attemptReceipt map[string]any
		require.NoError(t, pool.QueryRow(ctx, `select attempt_number,status,connector_version,connection_id,provider_ref,provider_receipt from verrail_integration_attempts where integration_run_id=$1`, result.ResourceID).Scan(&attemptNumber, &attemptStatus, &attemptVersion, &attemptConnection, &attemptRef, &attemptReceipt))
		require.Equal(t, 1, attemptNumber)
		require.Equal(t, "succeeded", attemptStatus)
		require.Equal(t, connectorVersion, attemptVersion)
		require.Equal(t, connectionID, attemptConnection)
		require.Equal(t, "run/1234", attemptRef)
		require.Equal(t, providerReceipt, attemptReceipt)
	})

	t.Run("neutral run records evidence without a verification result", func(t *testing.T) {
		fixture := harness.provisionTask("integration_task")
		result, err := harness.recordIntegrationRun(harness.integrationRunInput(fixture, "run/neutral", "neutral", "9999999999999999999999999999999999999999999999999999999999999999", "ci/build/neutral"))
		require.NoError(t, err)

		var verificationResultID *string
		require.NoError(t, pool.QueryRow(ctx, `select verification_result_id from verrail_integration_runs where id=$1`, result.ResourceID).Scan(&verificationResultID))
		require.Nil(t, verificationResultID, "neutral runs must not assert a verification result")
		require.Equal(t, "open", harness.claimStatus(fixture.claimID))
	})

	t.Run("integration run rejects claims outside the target", func(t *testing.T) {
		foreign := harness.provisionTask("integration_task")
		fixture := harness.provisionTask("integration_task")
		input := harness.integrationRunInput(fixture, "run/mismatch", "success", assuranceTestHash, "ci/build/mismatch")
		input.ClaimID = foreign.claimID
		_, err := harness.recordIntegrationRun(input)
		requireLifecycleCode(t, err, "INTEGRATION_CLAIM_BINDING_MISMATCH")
	})

	t.Run("integration run rejects a non-integration node", func(t *testing.T) {
		fixture := harness.provisionTask("human_task")
		_, err := harness.recordIntegrationRun(harness.integrationRunInput(fixture, "run/wrong-kind", "success", assuranceTestHash, "ci/build/wrong-kind"))
		requireLifecycleCode(t, err, "INTEGRATION_NODE_KIND_MISMATCH")
	})

	t.Run("integration run rejects a Connection from another Workspace", func(t *testing.T) {
		foreignWorkspaceID := mustNewUUID(t)
		harness.foreignWorkspaceIDs = append(harness.foreignWorkspaceIDs, foreignWorkspaceID)
		prefix := "F" + strings.ReplaceAll(foreignWorkspaceID, "-", "")[:7]
		_, err := pool.Exec(ctx, `insert into companies(id,name,issue_prefix,status) values($1,'Foreign connector workspace',$2,'active')`, foreignWorkspaceID, prefix)
		require.NoError(t, err)
		applicationID := mustNewUUID(t)
		harness.applicationIDs = append(harness.applicationIDs, applicationID)
		_, err = pool.Exec(ctx, `insert into tool_applications(id,company_id,name,type,status) values($1,$2,'Foreign app','a2a','active')`, applicationID, foreignWorkspaceID)
		require.NoError(t, err)
		connectionID := mustNewUUID(t)
		harness.connectionIDs = append(harness.connectionIDs, connectionID)
		_, err = pool.Exec(ctx, `insert into tool_connections(id,company_id,application_id,name,uid,transport,status,enabled) values($1,$2,$3,'Foreign connection',$4,'rest_api','active',true)`, connectionID, foreignWorkspaceID, applicationID, "foreign-"+connectionID)
		require.NoError(t, err)

		fixture := harness.provisionTask("integration_task")
		input := harness.integrationRunInput(fixture, "run/foreign-connection", "success", assuranceTestHash, "ci/build/foreign-connection")
		input.ConnectionID = connectionID
		_, err = harness.recordIntegrationRun(input)
		requireLifecycleCode(t, err, "INTEGRATION_CONNECTION_NOT_ACTIVE")
	})

	t.Run("human work result is immutable, version-bound, and idempotent", func(t *testing.T) {
		fixture := harness.provisionTask("human_task")
		input := RecordHumanWorkResultInput{
			TargetID:         fixture.targetID,
			TargetRevisionID: fixture.targetRevisionID,
			GraphRevisionID:  fixture.graphRevisionID,
			WorkNodeID:       fixture.workNodeID,
			InputHash:        assuranceTestHash,
			Result:           map[string]any{"decision": "ready"},
			AttachmentHashes: []string{"2222222222222222222222222222222222222222222222222222222222222222"},
		}
		result, command, err := harness.recordHumanWorkResult(input)
		require.NoError(t, err)
		require.Equal(t, "human_work_result", result.ResourceType)

		var targetRevisionID, graphRevisionID, workNodeID, submitterType, submitterID, inputHash, resultHash, idempotencyKey string
		var storedResult map[string]any
		var attachmentHashes []string
		require.NoError(t, pool.QueryRow(ctx, `select target_revision_id,graph_revision_id,work_node_id,submitted_by_principal_type,submitted_by_principal_id,input_hash,result,result_hash,idempotency_key,attachment_hashes from verrail_human_work_results where id=$1`, result.ResourceID).Scan(&targetRevisionID, &graphRevisionID, &workNodeID, &submitterType, &submitterID, &inputHash, &storedResult, &resultHash, &idempotencyKey, &attachmentHashes))
		require.Equal(t, fixture.targetRevisionID, targetRevisionID)
		require.Equal(t, fixture.graphRevisionID, graphRevisionID)
		require.Equal(t, fixture.workNodeID, workNodeID)
		require.Equal(t, "user", submitterType)
		require.Equal(t, harness.principalID, submitterID)
		require.Equal(t, assuranceTestHash, inputHash)
		require.Regexp(t, `^[0-9a-f]{64}$`, resultHash)
		require.Equal(t, command.IdempotencyKey, idempotencyKey)
		require.Equal(t, "ready", storedResult["decision"])
		require.Len(t, attachmentHashes, 1)

		replay, err := harness.storeWithFake.RecordHumanWorkResult(ctx, command)
		require.NoError(t, err)
		require.True(t, replay.Replayed)
		require.Equal(t, result.ResourceID, replay.ResourceID)
	})

	t.Run("human work result rejects a non-human node", func(t *testing.T) {
		fixture := harness.provisionTask("integration_task")
		_, _, err := harness.recordHumanWorkResult(RecordHumanWorkResultInput{
			TargetID:         fixture.targetID,
			TargetRevisionID: fixture.targetRevisionID,
			GraphRevisionID:  fixture.graphRevisionID,
			WorkNodeID:       fixture.workNodeID,
			InputHash:        assuranceTestHash,
			Result:           map[string]any{"decision": "ready"},
		})
		requireLifecycleCode(t, err, "HUMAN_WORK_NODE_KIND_MISMATCH")
	})

	happyTargetID, _, submissionID := harness.createAcceptedSubmission("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")

	t.Run("service action request keeps its authenticated principal and a human can approve it", func(t *testing.T) {
		params := PullRequestParams{Title: "Service PR", Head: "feat/service", Base: "main"}
		request, command, err := harness.requestActionAs("service", "graph-orchestrator", RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)

		var requesterType, requesterID, storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select requested_by_principal_type,requested_by_principal_id,params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&requesterType, &requesterID, &storedParamsHash))
		require.Equal(t, "service", requesterType)
		require.Equal(t, "graph-orchestrator", requesterID)

		for _, table := range []string{"verrail_agent_command_receipts", "verrail_audit_events"} {
			var principalType, principalID string
			query := `select principal_type,principal_id from ` + table + ` where workspace_id=$1 and idempotency_key=$2`
			require.NoError(t, pool.QueryRow(ctx, query, harness.workspaceID, command.IdempotencyKey).Scan(&principalType, &principalID))
			require.Equal(t, "service", principalType)
			require.Equal(t, "graph-orchestrator", principalID)
		}

		approval, err := harness.approveActionAs(harness.principalID, ApproveActionInput{
			ActionRequestID:       request.ResourceID,
			ApproverPrincipalType: "user",
			ApproverPrincipalID:   harness.principalID,
			ParamsHash:            storedParamsHash,
		})
		require.NoError(t, err)
		require.Equal(t, "action_approval", approval.ResourceType)
		require.Equal(t, "approved", harness.actionStatus(request.ResourceID))
	})

	t.Run("pull request action happy path: request, approve, execute, receipt", func(t *testing.T) {
		params := PullRequestParams{Title: "Merge feature", Head: "feat/x", Base: "main"}
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)
		require.Equal(t, "action_request", request.ResourceType)
		require.Equal(t, "pending_approval", harness.actionStatus(request.ResourceID))

		var storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))
		expectedHash, err := pullRequestParamsHash(params)
		require.NoError(t, err)
		require.Equal(t, expectedHash, storedParamsHash)

		approval, err := harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
		require.NoError(t, err)
		require.Equal(t, "action_approval", approval.ResourceType)
		require.Equal(t, "approved", harness.actionStatus(request.ResourceID))

		execution, err := harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		require.NoError(t, err)
		require.Equal(t, "effect_receipt", execution.ResourceType)
		require.Equal(t, "executed", harness.actionStatus(request.ResourceID))
		require.Equal(t, 1, harness.fake.calls)
		require.Equal(t, "owner/repo", harness.fake.lastRepo)
		require.Equal(t, params, harness.fake.lastParams)

		var storedEffectHash, externalObjectID, externalURL string
		require.NoError(t, pool.QueryRow(ctx, `select effect_hash, external_object_id, external_url from verrail_effect_receipts where id=$1`, execution.ResourceID).Scan(&storedEffectHash, &externalObjectID, &externalURL))
		expectedEffectHash, err := effectHash(request.ResourceID, storedParamsHash, "42")
		require.NoError(t, err)
		require.Equal(t, expectedEffectHash, storedEffectHash)
		require.Equal(t, "42", externalObjectID)
		require.Equal(t, "https://github.com/owner/repo/pull/42", externalURL)
	})

	t.Run("receipt replay returns the stored result", func(t *testing.T) {
		params := PullRequestParams{Title: "Replay PR", Head: "feat/replay", Base: "main"}
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)
		var storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))
		_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
		require.NoError(t, err)
		command := buildConnectorCommandAs(harness, harness.principalID, ConnectorActionExecuteCommand, ExecuteActionInput{ActionRequestID: request.ResourceID})
		first, err := harness.storeWithFake.ExecuteAction(ctx, command)
		require.NoError(t, err)
		require.False(t, first.Replayed)

		replay, err := harness.storeWithFake.ExecuteAction(ctx, command)
		require.NoError(t, err)
		require.True(t, replay.Replayed)
		require.Equal(t, first.ResourceID, replay.ResourceID)
	})

	t.Run("self-approval is rejected as non-independent", func(t *testing.T) {
		params := PullRequestParams{Title: "Self PR", Head: "feat/self", Base: "main"}
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)
		var storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))

		_, err = harness.approveActionAs(harness.principalID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.principalID, ParamsHash: storedParamsHash})
		requireLifecycleCode(t, err, "CONNECTOR_APPROVER_NOT_INDEPENDENT")
		require.Equal(t, 403, AsError(err).Status)
		require.Equal(t, "pending_approval", harness.actionStatus(request.ResourceID))

		_, err = harness.approveActionAs(harness.principalID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: "someone-else", ParamsHash: storedParamsHash})
		requireLifecycleCode(t, err, "CONNECTOR_APPROVER_FORBIDDEN")
	})

	t.Run("approval with a mismatching params hash is rejected", func(t *testing.T) {
		params := PullRequestParams{Title: "Hash PR", Head: "feat/hash", Base: "main"}
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)

		mismatch := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: mismatch})
		requireLifecycleCode(t, err, "CONNECTOR_PARAMS_HASH_MISMATCH")
		require.Equal(t, 409, AsError(err).Status)
		require.Equal(t, "pending_approval", harness.actionStatus(request.ResourceID))
	})

	t.Run("a second approval on the same request conflicts", func(t *testing.T) {
		params := PullRequestParams{Title: "Twice PR", Head: "feat/twice", Base: "main"}
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)
		var storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))
		_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
		require.NoError(t, err)

		_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
		requireLifecycleCode(t, err, "CONNECTOR_ACTION_ALREADY_APPROVED")
		require.Equal(t, 409, AsError(err).Status)
	})

	t.Run("executing a pending action is rejected", func(t *testing.T) {
		params := PullRequestParams{Title: "Pending PR", Head: "feat/pending", Base: "main"}
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_ACTION_NOT_APPROVED")
		require.Equal(t, 409, AsError(err).Status)
		require.Equal(t, "pending_approval", harness.actionStatus(request.ResourceID))
	})

	t.Run("executing without a bound connection is rejected", func(t *testing.T) {
		params := PullRequestParams{Title: "Unbound PR", Head: "feat/unbound", Base: "main"}
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)
		var storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))
		_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
		require.NoError(t, err)

		var bindingID, connectionID string
		require.NoError(t, pool.QueryRow(ctx, `select id, connection_id from verrail_github_repo_bindings where workspace_id=$1`, harness.workspaceID).Scan(&bindingID, &connectionID))
		_, err = pool.Exec(ctx, `delete from verrail_github_repo_bindings where id=$1`, bindingID)
		require.NoError(t, err)

		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_NOT_BOUND")
		require.Equal(t, 409, AsError(err).Status)
		require.Equal(t, "approved", harness.actionStatus(request.ResourceID))

		_, err = pool.Exec(ctx, `
			insert into verrail_github_repo_bindings (id, workspace_id, connection_id, repo_owner, repo_name, created_by_principal_type, created_by_principal_id)
			values ($1, $2, $3, 'owner', 'repo', 'user', $4)
		`, bindingID, harness.workspaceID, connectionID, harness.principalID)
		require.NoError(t, err)
	})

	t.Run("upstream failure keeps the action approved and retryable", func(t *testing.T) {
		params := PullRequestParams{Title: "Flaky PR", Head: "feat/flaky", Base: "main"}
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: happyTargetID, SubmissionID: submissionID, Params: params})
		require.NoError(t, err)
		var storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))
		_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
		require.NoError(t, err)

		harness.fake.err = &GitHubProviderError{Message: "boom", Uncertain: false}
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_UPSTREAM_ERROR")
		require.Equal(t, 502, AsError(err).Status)
		require.True(t, AsError(err).Retryable)
		require.Equal(t, "approved", harness.actionStatus(request.ResourceID), "a failed upstream call must leave the action approved")

		var receiptCount int
		require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_effect_receipts where action_request_id=$1`, request.ResourceID).Scan(&receiptCount))
		require.Equal(t, 0, receiptCount)

		harness.fake.err = nil
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		require.NoError(t, err)
		require.Equal(t, "executed", harness.actionStatus(request.ResourceID))
	})

	t.Run("requesting an action on a superseded submission is rejected", func(t *testing.T) {
		targetID, _, firstSubmission := harness.createAcceptedSubmission("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
		secondSubmission, err := harness.supersedeSubmission(targetID, firstSubmission)
		require.NoError(t, err)

		_, err = harness.requestAction(RequestPullRequestActionInput{TargetID: targetID, SubmissionID: firstSubmission, Params: PullRequestParams{Title: "Stale PR", Head: "feat/stale", Base: "main"}})
		requireLifecycleCode(t, err, "CONNECTOR_SUBMISSION_SUPERSEDED")
		require.Equal(t, 409, AsError(err).Status)

		_, err = harness.requestAction(RequestPullRequestActionInput{TargetID: targetID, SubmissionID: secondSubmission, Params: PullRequestParams{Title: "Fresh PR", Head: "feat/fresh", Base: "main"}})
		require.NoError(t, err)
	})

	t.Run("requesting an action after the active revision changed is not applicable", func(t *testing.T) {
		targetID, _, staleSubmission := harness.createAcceptedSubmission("abababababababababababababababababababababababababababababababab")
		require.NoError(t, harness.rotateActiveRevision(targetID))

		_, err := harness.requestAction(RequestPullRequestActionInput{TargetID: targetID, SubmissionID: staleSubmission, Params: PullRequestParams{Title: "Rotated PR", Head: "feat/rotated", Base: "main"}})
		requireLifecycleCode(t, err, "ADJUDICATION_NOT_APPLICABLE")
		require.Equal(t, 409, AsError(err).Status)
	})

	t.Run("executing an action whose submission was superseded is rejected", func(t *testing.T) {
		targetID, _, firstSubmission := harness.createAcceptedSubmission("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: targetID, SubmissionID: firstSubmission, Params: PullRequestParams{Title: "Stale execution PR", Head: "feat/stale-exec", Base: "main"}})
		require.NoError(t, err)

		var storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))
		_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
		require.NoError(t, err)

		_, err = harness.supersedeSubmission(targetID, firstSubmission)
		require.NoError(t, err)

		callsBefore := harness.fake.calls
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_SUBMISSION_SUPERSEDED")
		require.Equal(t, 409, AsError(err).Status)
		require.Equal(t, callsBefore, harness.fake.calls, "a rejected execution must not reach the upstream connector")
	})

	t.Run("executing an action after the active revision changed is rejected", func(t *testing.T) {
		targetID, _, submissionID := harness.createAcceptedSubmission("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd")
		request, err := harness.requestAction(RequestPullRequestActionInput{TargetID: targetID, SubmissionID: submissionID, Params: PullRequestParams{Title: "Rotated execution PR", Head: "feat/rotated-exec", Base: "main"}})
		require.NoError(t, err)

		var storedParamsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&storedParamsHash))
		_, err = harness.approveActionAs(harness.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: harness.approverID, ParamsHash: storedParamsHash})
		require.NoError(t, err)

		require.NoError(t, harness.rotateActiveRevision(targetID))

		callsBefore := harness.fake.calls
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "ADJUDICATION_NOT_APPLICABLE")
		require.Equal(t, 409, AsError(err).Status)
		require.Equal(t, callsBefore, harness.fake.calls, "a rejected execution must not reach the upstream connector")
	})

	t.Run("unknown create outcome is reconciled by marker without a duplicate pull request", func(t *testing.T) {
		targetID, _, acceptedSubmissionID := harness.createAcceptedSubmission(strings.Repeat("1", 64))
		request := harness.createApprovedAction(targetID, acceptedSubmissionID, PullRequestParams{Title: "Unknown effect", Head: "feat/unknown", Base: "main"})
		callsBefore := harness.fake.calls
		harness.fake.err = &GitHubProviderError{Message: "connection reset", Uncertain: true}
		harness.fake.lookupResults = []PullRequestLookup{{Status: PullRequestAbsent}, {Status: PullRequestInconclusive}}

		_, err := harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_EFFECT_UNKNOWN")
		require.Equal(t, "unknown_effect", harness.actionStatus(request.ResourceID))
		require.Equal(t, callsBefore+1, harness.fake.calls)
		var marker string
		require.NoError(t, pool.QueryRow(ctx, `select provider_marker from verrail_action_requests where id=$1`, request.ResourceID).Scan(&marker))
		require.Equal(t, providerMarker(request.ResourceID, func() string {
			var hash string
			require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&hash))
			return hash
		}()), marker)

		harness.fake.err = nil
		harness.fake.lookupResults = []PullRequestLookup{{Status: PullRequestFound, ExternalObjectID: "77", ExternalURL: "https://github.com/owner/repo/pull/77"}}
		reconciled, err := harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		require.NoError(t, err)
		require.Equal(t, "effect_receipt", reconciled.ResourceType)
		require.Equal(t, "executed", harness.actionStatus(request.ResourceID))
		require.Equal(t, callsBefore+1, harness.fake.calls, "lookup-found reconciliation must not create a second pull request")
		var receiptCount int
		require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_effect_receipts where action_request_id=$1 and provider_marker=$2`, request.ResourceID, marker).Scan(&receiptCount))
		require.Equal(t, 1, receiptCount)
	})

	t.Run("confirmed absent reconciliation retries the same marker after a pre-effect timeout", func(t *testing.T) {
		targetID, _, acceptedSubmissionID := harness.createAcceptedSubmission(strings.Repeat("7", 64))
		request := harness.createApprovedAction(targetID, acceptedSubmissionID, PullRequestParams{Title: "Pre-effect timeout", Head: "feat/pre-timeout", Base: "main"})
		callsBefore := harness.fake.calls
		harness.fake.err = &GitHubProviderError{Message: "timeout before response", Uncertain: true}
		harness.fake.lookupResults = []PullRequestLookup{{Status: PullRequestAbsent}, {Status: PullRequestAbsent}}
		_, err := harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_EFFECT_UNKNOWN")
		require.Equal(t, "unknown_effect", harness.actionStatus(request.ResourceID))
		marker := harness.fake.lastMarker

		harness.fake.err = nil
		harness.fake.lookupResults = []PullRequestLookup{{Status: PullRequestAbsent}}
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		require.NoError(t, err)
		require.Equal(t, callsBefore+2, harness.fake.calls)
		require.Equal(t, marker, harness.fake.lastMarker)
		require.Equal(t, "executed", harness.actionStatus(request.ResourceID))
	})

	t.Run("lookup inconclusive never attempts create", func(t *testing.T) {
		targetID, _, acceptedSubmissionID := harness.createAcceptedSubmission(strings.Repeat("2", 64))
		request := harness.createApprovedAction(targetID, acceptedSubmissionID, PullRequestParams{Title: "Lookup uncertain", Head: "feat/lookup", Base: "main"})
		callsBefore := harness.fake.calls
		harness.fake.lookupResults = []PullRequestLookup{{Status: PullRequestInconclusive}}
		_, err := harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_EFFECT_UNKNOWN")
		require.Equal(t, callsBefore, harness.fake.calls)
		require.Equal(t, "unknown_effect", harness.actionStatus(request.ResourceID))
	})

	t.Run("a live executing claim can reconcile but cannot race a second create", func(t *testing.T) {
		targetID, _, acceptedSubmissionID := harness.createAcceptedSubmission(strings.Repeat("6", 64))
		request := harness.createApprovedAction(targetID, acceptedSubmissionID, PullRequestParams{Title: "Concurrent execution", Head: "feat/concurrent", Base: "main"})
		var paramsHash string
		require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&paramsHash))
		marker := providerMarker(request.ResourceID, paramsHash)
		_, err := pool.Exec(ctx, `update verrail_action_requests set status='executing',provider_marker=$1,execution_started_at=now() where id=$2`, marker, request.ResourceID)
		require.NoError(t, err)
		callsBefore := harness.fake.calls
		harness.fake.lookupResults = []PullRequestLookup{{Status: PullRequestAbsent}}
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_EFFECT_UNKNOWN")
		require.Equal(t, callsBefore, harness.fake.calls)
		require.Equal(t, "executing", harness.actionStatus(request.ResourceID))
	})

	t.Run("post-effect database failure converges from unknown by lookup", func(t *testing.T) {
		targetID, _, acceptedSubmissionID := harness.createAcceptedSubmission(strings.Repeat("3", 64))
		request := harness.createApprovedAction(targetID, acceptedSubmissionID, PullRequestParams{Title: "Commit failure", Head: "feat/db-failure", Base: "main"})
		_, err := pool.Exec(ctx, `
			create or replace function verrail_t006_fail_effect_receipt() returns trigger language plpgsql as $$
			begin raise exception 'forced post-effect receipt failure'; end $$;
			create trigger verrail_t006_fail_effect_receipt before insert on verrail_effect_receipts
			for each row execute function verrail_t006_fail_effect_receipt()
		`)
		require.NoError(t, err)
		callsBefore := harness.fake.calls
		harness.fake.lookupResults = []PullRequestLookup{{Status: PullRequestAbsent}}
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_EFFECT_UNKNOWN")
		require.Equal(t, "unknown_effect", harness.actionStatus(request.ResourceID))
		require.Equal(t, callsBefore+1, harness.fake.calls)
		_, err = pool.Exec(ctx, `drop trigger verrail_t006_fail_effect_receipt on verrail_effect_receipts; drop function verrail_t006_fail_effect_receipt()`)
		require.NoError(t, err)

		harness.fake.lookupResults = []PullRequestLookup{{Status: PullRequestFound, ExternalObjectID: "42", ExternalURL: "https://github.com/owner/repo/pull/42"}}
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
		require.NoError(t, err)
		require.Equal(t, callsBefore+1, harness.fake.calls)
		require.Equal(t, "executed", harness.actionStatus(request.ResourceID))
	})

	t.Run("changed approved params and missing acceptance fail before provider access", func(t *testing.T) {
		targetID, _, acceptedSubmissionID := harness.createAcceptedSubmission(strings.Repeat("4", 64))
		paramsRequest := harness.createApprovedAction(targetID, acceptedSubmissionID, PullRequestParams{Title: "Immutable params", Head: "feat/params", Base: "main"})
		_, err := pool.Exec(ctx, `update verrail_action_requests set params=jsonb_set(params,'{base}',to_jsonb('develop'::text)) where id=$1`, paramsRequest.ResourceID)
		require.NoError(t, err)
		callsBefore := harness.fake.calls
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: paramsRequest.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_PARAMS_HASH_MISMATCH")
		require.Equal(t, callsBefore, harness.fake.calls)

		acceptanceRequest := harness.createApprovedAction(targetID, acceptedSubmissionID, PullRequestParams{Title: "Acceptance required", Head: "feat/acceptance", Base: "main"})
		_, err = pool.Exec(ctx, `delete from verrail_acceptances where submission_id=$1`, acceptedSubmissionID)
		require.NoError(t, err)
		_, err = harness.executeAction(ExecuteActionInput{ActionRequestID: acceptanceRequest.ResourceID})
		requireLifecycleCode(t, err, "CONNECTOR_SUBMISSION_NOT_ACCEPTED")
		require.Equal(t, callsBefore, harness.fake.calls)
	})

	t.Run("the facade connection id must still match the workspace binding", func(t *testing.T) {
		targetID, _, acceptedSubmissionID := harness.createAcceptedSubmission(strings.Repeat("5", 64))
		request := harness.createApprovedAction(targetID, acceptedSubmissionID, PullRequestParams{Title: "Bound credential", Head: "feat/binding", Base: "main"})
		command := buildConnectorCommandAs(harness, harness.principalID, ConnectorActionExecuteCommand, ExecuteActionInput{ActionRequestID: request.ResourceID})
		callsBefore := harness.fake.calls
		_, err := harness.storeWithFake.executeActionWithClient(ctx, command, "99999999-9999-4999-8999-999999999999", harness.fake)
		requireLifecycleCode(t, err, "CONNECTOR_CONNECTION_CHANGED")
		require.Equal(t, callsBefore, harness.fake.calls)
		require.Equal(t, "approved", harness.actionStatus(request.ResourceID))
	})
}
