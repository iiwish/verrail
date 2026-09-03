package target

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestRecordIntegrationRunInputValidation(t *testing.T) {
	valid := RecordIntegrationRunInput{
		TargetID:    "22222222-2222-4222-8222-222222222222",
		ClaimID:     "33333333-3333-4333-8333-333333333333",
		Provider:    "github",
		ExternalRef: "run/1234",
		Conclusion:  "success",
		ObjectHash:  assuranceTestHash,
		Reference:   "ci/build/1234",
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
	badWorkNode.WorkNodeID = ptr("not-a-uuid")
	require.Error(t, ValidateRecordIntegrationRunInput(&badWorkNode))

	emptyRef := valid
	emptyRef.ExternalRef = ""
	require.Error(t, ValidateRecordIntegrationRunInput(&emptyRef))

	longReference := valid
	longReference.Reference = strings.Repeat("x", 501)
	require.Error(t, ValidateRecordIntegrationRunInput(&longReference))
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
	_, _, err := client.CreatePullRequest(context.Background(), "owner/repo", PullRequestParams{Title: "t", Head: "h", Base: "b"})
	domainError := AsError(err)
	require.Equal(t, 502, domainError.Status)
	require.Equal(t, "CONNECTOR_CREDENTIALS_NOT_CONFIGURED", domainError.Code)
}

type fakeGitHubClient struct {
	calls      int
	lastRepo   string
	lastParams PullRequestParams
	objectID   string
	url        string
	err        error
}

func (fake *fakeGitHubClient) CreatePullRequest(_ context.Context, repo string, params PullRequestParams) (string, string, error) {
	fake.calls++
	fake.lastRepo = repo
	fake.lastParams = params
	if fake.err != nil {
		return "", "", fake.err
	}
	return fake.objectID, fake.url, nil
}

type connectorTestHarness struct {
	*assuranceTestHarness
	storeWithFake    *Store
	fake             *fakeGitHubClient
	approverID       string
	runIDs           []string
	actionRequestIDs []string
	submissionIDs    []string
	connectionIDs    []string
	applicationIDs   []string
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

func (h *connectorTestHarness) recordIntegrationRun(input RecordIntegrationRunInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	result, err := h.storeWithFake.RecordIntegrationRun(context.Background(), buildConnectorCommandAs(h, h.principalID, ConnectorIntegrationRunRecordCommand, input))
	if err == nil {
		h.runIDs = append(h.runIDs, result.ResourceID)
	}
	return result, err
}

func (h *connectorTestHarness) requestAction(input RequestPullRequestActionInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	result, err := h.storeWithFake.RequestPullRequestAction(context.Background(), buildConnectorCommandAs(h, h.principalID, ConnectorActionRequestCreateCommand, input))
	if err == nil {
		h.actionRequestIDs = append(h.actionRequestIDs, result.ResourceID)
	}
	return result, err
}

func (h *connectorTestHarness) approveActionAs(principalID string, input ApproveActionInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	return h.storeWithFake.ApproveAction(context.Background(), buildConnectorCommandAs(h, principalID, ConnectorActionApproveCommand, input))
}

func (h *connectorTestHarness) executeAction(input ExecuteActionInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	return h.storeWithFake.ExecuteAction(context.Background(), buildConnectorCommandAs(h, h.principalID, ConnectorActionExecuteCommand, input))
}

// provisionClaim provisions a fresh target with one open claim; the minimal
// binding surface for integration runs.
func (h *connectorTestHarness) provisionClaim() (string, string, string) {
	h.t.Helper()
	targetID, targetRevisionID := h.createTarget()
	claimID := h.createClaim(targetID, targetRevisionID, "ac-connector-run")
	return targetID, targetRevisionID, claimID
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
	}))
	require.NoError(h.t, err)
	h.submissionIDs = append(h.submissionIDs, submission.ResourceID)
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
	}))
	if err != nil {
		return "", err
	}
	h.submissionIDs = append(h.submissionIDs, submission.ResourceID)
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

func (h *connectorTestHarness) cleanup(pool *pgxpool.Pool) {
	ctx := context.Background()
	cleanups := []func(){
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_effect_receipts where workspace_id=$1 and action_request_id = any($2::uuid[])`, h.workspaceID, h.actionRequestIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_action_approvals where workspace_id=$1 and action_request_id = any($2::uuid[])`, h.workspaceID, h.actionRequestIDs)
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
			_, _ = pool.Exec(ctx, `delete from verrail_audit_events where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.approverID, h.receiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from company_memberships where company_id=$1 and principal_id=$2`, h.workspaceID, h.approverID)
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

	t.Run("integration run binds CI evidence and verification result atomically", func(t *testing.T) {
		targetID, _, claimID := harness.provisionClaim()
		result, err := harness.recordIntegrationRun(RecordIntegrationRunInput{
			TargetID:    targetID,
			ClaimID:     claimID,
			Provider:    "github",
			ExternalRef: "run/1234",
			Conclusion:  "success",
			ObjectHash:  assuranceTestHash,
			Reference:   "ci/build/1234",
		})
		require.NoError(t, err)
		require.False(t, result.Replayed)
		require.Equal(t, "integration_run", result.ResourceType)

		var verificationResultID *string
		var kind, producerType, producerID, trustLevel string
		require.NoError(t, pool.QueryRow(ctx, `
			select run.verification_result_id, evidence.kind, evidence.producer_principal_type, evidence.producer_principal_id, evidence.trust_level
			from verrail_integration_runs run
			join verrail_evidence evidence on evidence.id = run.evidence_id and evidence.workspace_id = run.workspace_id
			where run.id = $1
		`, result.ResourceID).Scan(&verificationResultID, &kind, &producerType, &producerID, &trustLevel))
		require.NotNil(t, verificationResultID)
		require.Equal(t, "ci_result", kind)
		require.Equal(t, "service", producerType)
		require.Equal(t, "integration-run", producerID)
		require.Equal(t, "high", trustLevel)

		var verdict, verifierVersion string
		require.NoError(t, pool.QueryRow(ctx, `select verdict, verifier_version from verrail_verification_results where id=$1`, *verificationResultID).Scan(&verdict, &verifierVersion))
		require.Equal(t, "passed", verdict)
		require.Equal(t, "integration-run.v1", verifierVersion)
		require.Equal(t, "supported", harness.claimStatus(claimID))
	})

	t.Run("neutral run records evidence without a verification result", func(t *testing.T) {
		targetID, _, claimID := harness.provisionClaim()
		result, err := harness.recordIntegrationRun(RecordIntegrationRunInput{
			TargetID:    targetID,
			ClaimID:     claimID,
			Provider:    "github",
			ExternalRef: "run/neutral",
			Conclusion:  "neutral",
			ObjectHash:  "9999999999999999999999999999999999999999999999999999999999999999",
			Reference:   "ci/build/neutral",
		})
		require.NoError(t, err)

		var verificationResultID *string
		require.NoError(t, pool.QueryRow(ctx, `select verification_result_id from verrail_integration_runs where id=$1`, result.ResourceID).Scan(&verificationResultID))
		require.Nil(t, verificationResultID, "neutral runs must not assert a verification result")
		require.Equal(t, "open", harness.claimStatus(claimID))
	})

	t.Run("integration run rejects claims outside the target", func(t *testing.T) {
		_, _, foreignClaimID := harness.provisionClaim()
		targetID, _, _ := harness.provisionClaim()
		_, err := harness.recordIntegrationRun(RecordIntegrationRunInput{
			TargetID:    targetID,
			ClaimID:     foreignClaimID,
			Provider:    "github",
			ExternalRef: "run/mismatch",
			Conclusion:  "success",
			ObjectHash:  assuranceTestHash,
			Reference:   "ci/build/mismatch",
		})
		requireLifecycleCode(t, err, "TARGET_COMMAND_INVALID")
	})

	happyTargetID, _, submissionID := harness.createAcceptedSubmission("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
	harness.bindGitHubConnection()

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

		harness.fake.err = errors.New("boom")
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
}
