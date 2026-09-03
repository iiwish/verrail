package target

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestCreateSubmissionInputValidation(t *testing.T) {
	artifact := "33333333-3333-4333-8333-333333333333"
	result := "44444444-4444-4444-8444-444444444444"
	valid := CreateSubmissionInput{
		TargetID:              "22222222-2222-4222-8222-222222222222",
		TargetRevisionID:      "55555555-5555-4555-8555-555555555555",
		ArtifactRevisionIDs:   []string{artifact},
		VerificationResultIDs: []string{result},
		CommitRef:             ptr("git:abc123"),
	}
	require.NoError(t, ValidateCreateSubmissionInput(&valid))

	nilResults := valid
	nilResults.VerificationResultIDs = nil
	require.NoError(t, ValidateCreateSubmissionInput(&nilResults), "verificationResultIds may be empty")

	badTarget := valid
	badTarget.TargetID = "not-a-uuid"
	require.Error(t, ValidateCreateSubmissionInput(&badTarget))

	badRevision := valid
	badRevision.TargetRevisionID = "not-a-uuid"
	require.Error(t, ValidateCreateSubmissionInput(&badRevision))

	emptyArtifacts := valid
	emptyArtifacts.ArtifactRevisionIDs = nil
	require.Error(t, ValidateCreateSubmissionInput(&emptyArtifacts))

	tooManyArtifacts := valid
	tooManyArtifacts.ArtifactRevisionIDs = make([]string, 101)
	for i := range tooManyArtifacts.ArtifactRevisionIDs {
		tooManyArtifacts.ArtifactRevisionIDs[i] = artifact
	}
	require.Error(t, ValidateCreateSubmissionInput(&tooManyArtifacts))

	badArtifactUUID := valid
	badArtifactUUID.ArtifactRevisionIDs = []string{"not-a-uuid"}
	require.Error(t, ValidateCreateSubmissionInput(&badArtifactUUID))

	duplicateArtifacts := valid
	duplicateArtifacts.ArtifactRevisionIDs = []string{artifact, artifact}
	require.Error(t, ValidateCreateSubmissionInput(&duplicateArtifacts))

	tooManyResults := valid
	tooManyResults.VerificationResultIDs = make([]string, 201)
	for i := range tooManyResults.VerificationResultIDs {
		tooManyResults.VerificationResultIDs[i] = result
	}
	require.Error(t, ValidateCreateSubmissionInput(&tooManyResults))

	duplicateResults := valid
	duplicateResults.VerificationResultIDs = []string{result, result}
	require.Error(t, ValidateCreateSubmissionInput(&duplicateResults))

	badCommitRef := valid
	badCommitRef.CommitRef = ptr(string(make([]byte, 501)))
	require.Error(t, ValidateCreateSubmissionInput(&badCommitRef))

	badSummary := valid
	badSummary.EnvironmentSummary = ptr(string(make([]byte, 2001)))
	require.Error(t, ValidateCreateSubmissionInput(&badSummary))

	badNotes := valid
	badNotes.Notes = ptr(string(make([]byte, 2001)))
	require.Error(t, ValidateCreateSubmissionInput(&badNotes))

	trimmed := CreateSubmissionInput{TargetID: valid.TargetID, TargetRevisionID: valid.TargetRevisionID, ArtifactRevisionIDs: []string{artifact}, CommitRef: ptr("  git:abc123  ")}
	require.NoError(t, ValidateCreateSubmissionInput(&trimmed))
	require.Equal(t, "git:abc123", *trimmed.CommitRef, "optional text fields are trimmed")
}

func TestRecordDeliveryReviewInputValidation(t *testing.T) {
	valid := RecordDeliveryReviewInput{
		SubmissionID:          "22222222-2222-4222-8222-222222222222",
		ReviewerPrincipalType: "user",
		ReviewerPrincipalID:   "reviewer-1",
		Verdict:               "approved",
		UnprovenItems:         []string{"perf claims"},
	}
	require.NoError(t, ValidateRecordDeliveryReviewInput(&valid))

	agentReviewer := valid
	agentReviewer.ReviewerPrincipalType = "agent"
	require.Error(t, ValidateRecordDeliveryReviewInput(&agentReviewer), "the G2 reviewer is a human")

	serviceReviewer := valid
	serviceReviewer.ReviewerPrincipalType = "service"
	require.Error(t, ValidateRecordDeliveryReviewInput(&serviceReviewer))

	emptyReviewerID := valid
	emptyReviewerID.ReviewerPrincipalID = ""
	require.Error(t, ValidateRecordDeliveryReviewInput(&emptyReviewerID))

	longReviewerID := valid
	longReviewerID.ReviewerPrincipalID = string(make([]byte, 201))
	require.Error(t, ValidateRecordDeliveryReviewInput(&longReviewerID))

	badVerdict := valid
	badVerdict.Verdict = "maybe"
	require.Error(t, ValidateRecordDeliveryReviewInput(&badVerdict))

	tooManyItems := valid
	tooManyItems.UnprovenItems = make([]string, 21)
	for i := range tooManyItems.UnprovenItems {
		tooManyItems.UnprovenItems[i] = "item"
	}
	require.Error(t, ValidateRecordDeliveryReviewInput(&tooManyItems))

	badItem := valid
	badItem.UnprovenItems = []string{"   "}
	require.Error(t, ValidateRecordDeliveryReviewInput(&badItem))

	badRisks := valid
	badRisks.Risks = ptr(string(make([]byte, 2001)))
	require.Error(t, ValidateRecordDeliveryReviewInput(&badRisks))

	badComments := valid
	badComments.Comments = ptr(string(make([]byte, 4001)))
	require.Error(t, ValidateRecordDeliveryReviewInput(&badComments))

	badSubmission := valid
	badSubmission.SubmissionID = "not-a-uuid"
	require.Error(t, ValidateRecordDeliveryReviewInput(&badSubmission))
}

func TestAcceptSubmissionInputValidation(t *testing.T) {
	valid := AcceptSubmissionInput{SubmissionID: "22222222-2222-4222-8222-222222222222", ReviewID: "33333333-3333-4333-8333-333333333333"}
	require.NoError(t, ValidateAcceptSubmissionInput(&valid))

	badSubmission := valid
	badSubmission.SubmissionID = "not-a-uuid"
	require.Error(t, ValidateAcceptSubmissionInput(&badSubmission))

	badReview := valid
	badReview.ReviewID = "not-a-uuid"
	require.Error(t, ValidateAcceptSubmissionInput(&badReview))
}

func TestSubmissionHashCanonicality(t *testing.T) {
	first := "33333333-3333-4333-8333-333333333333"
	second := "44444444-4444-4444-8444-444444444444"
	revision := "55555555-5555-4555-8555-555555555555"
	base, err := submissionHash(revision, []string{first, second}, []string{second}, ptr("git:one"), nil)
	require.NoError(t, err)

	reordered, err := submissionHash(revision, []string{second, first}, []string{second}, ptr("git:one"), nil)
	require.NoError(t, err)
	require.Equal(t, base, reordered, "logically identical binding sets must hash identically")

	nilResults, err := submissionHash(revision, []string{first, second}, nil, ptr("git:one"), nil)
	require.NoError(t, err)
	emptyResults, err := submissionHash(revision, []string{first, second}, []string{}, ptr("git:one"), nil)
	require.NoError(t, err)
	require.Equal(t, nilResults, emptyResults, "nil and empty verification sets are the same set")
	require.NotEqual(t, base, nilResults, "a set with entries differs from the empty set")

	otherCommit, err := submissionHash(revision, []string{first, second}, []string{second}, ptr("git:two"), nil)
	require.NoError(t, err)
	require.NotEqual(t, base, otherCommit)

	otherRevision, err := submissionHash("66666666-6666-4666-8666-666666666666", []string{first, second}, []string{second}, ptr("git:one"), nil)
	require.NoError(t, err)
	require.NotEqual(t, base, otherRevision)

	withSummary, err := submissionHash(revision, []string{first, second}, []string{second}, ptr("git:one"), ptr("staging"))
	require.NoError(t, err)
	require.NotEqual(t, base, withSummary)
}

func TestDeliveryReviewHashCanonicality(t *testing.T) {
	submission := "22222222-2222-4222-8222-222222222222"
	base, err := deliveryReviewHash(submission, "user", "reviewer-1", "approved", nil, []string{"b", "a"}, nil)
	require.NoError(t, err)

	reordered, err := deliveryReviewHash(submission, "user", "reviewer-1", "approved", nil, []string{"a", "b"}, nil)
	require.NoError(t, err)
	require.Equal(t, base, reordered, "logically identical unproven item sets must hash identically")

	otherVerdict, err := deliveryReviewHash(submission, "user", "reviewer-1", "rejected", nil, []string{"a", "b"}, nil)
	require.NoError(t, err)
	require.NotEqual(t, base, otherVerdict)

	withRisks, err := deliveryReviewHash(submission, "user", "reviewer-1", "approved", ptr("flaky"), []string{"a", "b"}, nil)
	require.NoError(t, err)
	require.NotEqual(t, base, withRisks)
}

func TestAcceptanceHashStable(t *testing.T) {
	submission := "22222222-2222-4222-8222-222222222222"
	review := "33333333-3333-4333-8333-333333333333"
	revision := "55555555-5555-4555-8555-555555555555"
	base, err := acceptanceHash(submission, review, revision, adjudicationAuthorityOutcomeOwner)
	require.NoError(t, err)

	again, err := acceptanceHash(submission, review, revision, adjudicationAuthorityOutcomeOwner)
	require.NoError(t, err)
	require.Equal(t, base, again)

	otherReview, err := acceptanceHash(submission, "44444444-4444-4444-8444-444444444444", revision, adjudicationAuthorityOutcomeOwner)
	require.NoError(t, err)
	require.NotEqual(t, base, otherReview)
}

func TestDeriveAcceptanceValidity(t *testing.T) {
	validity, reason := deriveAcceptanceValidity(true, true)
	require.Equal(t, "valid", validity)
	require.Empty(t, reason)

	validity, reason = deriveAcceptanceValidity(false, true)
	require.Equal(t, "invalid", validity)
	require.Equal(t, "superseded_submission", reason)

	validity, reason = deriveAcceptanceValidity(true, false)
	require.Equal(t, "invalid", validity)
	require.Equal(t, "target_revision_changed", reason)

	validity, reason = deriveAcceptanceValidity(false, false)
	require.Equal(t, "invalid", validity)
	require.Equal(t, "superseded_submission", reason, "supersession takes precedence when both facts changed")
}

func TestAdjudicationRequestHashStableForReplay(t *testing.T) {
	build := func() AgentLifecycleCommand[CreateSubmissionInput] {
		command := AgentLifecycleCommand[CreateSubmissionInput]{
			WorkspaceID:    "11111111-1111-4111-8111-111111111111",
			Principal:      Principal{Type: "user", ID: "board-user"},
			IdempotencyKey: "adjudication-replay-1",
			CommandType:    AdjudicationSubmissionCreateCommand,
			Input: CreateSubmissionInput{
				TargetID:            "22222222-2222-4222-8222-222222222222",
				TargetRevisionID:    "55555555-5555-4555-8555-555555555555",
				ArtifactRevisionIDs: []string{"33333333-3333-4333-8333-333333333333"},
			},
		}
		require.NoError(t, ValidateAgentLifecycleCommand(&command))
		return command
	}
	require.Equal(t, build().RequestHash, build().RequestHash)

	mutated := build()
	mutated.Input.CommitRef = ptr("git:changed")
	require.NoError(t, ValidateAgentLifecycleCommand(&mutated))
	require.NotEqual(t, build().RequestHash, mutated.RequestHash)
}

type adjudicationTestHarness struct {
	*assuranceTestHarness
	reviewerPrincipalID     string
	otherPrincipalID        string
	adjudicationReceiptKeys []string
}

func newAdjudicationTestHarness(t *testing.T, pool *pgxpool.Pool) *adjudicationTestHarness {
	t.Helper()
	base := newAssuranceTestHarness(t, pool)
	h := &adjudicationTestHarness{
		assuranceTestHarness: base,
		reviewerPrincipalID:  "adjudication-reviewer-test-user",
		otherPrincipalID:     "adjudication-other-test-user",
	}
	for _, principalID := range []string{h.reviewerPrincipalID, h.otherPrincipalID} {
		_, err := pool.Exec(context.Background(), `
			insert into company_memberships (company_id, principal_type, principal_id, status, membership_role)
			values ($1, 'user', $2, 'active', 'member')
		`, base.workspaceID, principalID)
		require.NoError(t, err)
	}
	return h
}

func buildAdjudicationCommandFor[T any](t *testing.T, h *adjudicationTestHarness, principalID, commandType string, input T) AgentLifecycleCommand[T] {
	t.Helper()
	idempotencyKey := "adjudication-it-" + mustNewUUID(t)
	h.adjudicationReceiptKeys = append(h.adjudicationReceiptKeys, idempotencyKey)
	command := AgentLifecycleCommand[T]{
		WorkspaceID:    h.workspaceID,
		Principal:      Principal{Type: "user", ID: principalID},
		IdempotencyKey: idempotencyKey,
		CommandType:    commandType,
		Input:          input,
	}
	require.NoError(t, ValidateAgentLifecycleCommand(&command))
	return command
}

func (h *adjudicationTestHarness) createSubmission(t *testing.T, input CreateSubmissionInput) (AgentLifecycleResult, error) {
	t.Helper()
	require.NoError(t, ValidateCreateSubmissionInput(&input))
	return h.store.CreateSubmission(context.Background(), buildAdjudicationCommandFor(t, h, h.principalID, AdjudicationSubmissionCreateCommand, input))
}

func (h *adjudicationTestHarness) recordReview(t *testing.T, principalID, submissionID, verdict string) (AgentLifecycleResult, error) {
	t.Helper()
	input := RecordDeliveryReviewInput{
		SubmissionID:          submissionID,
		ReviewerPrincipalType: "user",
		ReviewerPrincipalID:   principalID,
		Verdict:               verdict,
		UnprovenItems:         []string{},
	}
	require.NoError(t, ValidateRecordDeliveryReviewInput(&input))
	return h.store.RecordDeliveryReview(context.Background(), buildAdjudicationCommandFor(t, h, principalID, AdjudicationReviewRecordCommand, input))
}

func (h *adjudicationTestHarness) accept(t *testing.T, principalID, submissionID, reviewID string) (AgentLifecycleResult, error) {
	t.Helper()
	input := AcceptSubmissionInput{SubmissionID: submissionID, ReviewID: reviewID}
	require.NoError(t, ValidateAcceptSubmissionInput(&input))
	return h.store.AcceptSubmission(context.Background(), buildAdjudicationCommandFor(t, h, principalID, AdjudicationAcceptanceCreateCommand, input))
}

func (h *adjudicationTestHarness) cleanup(pool *pgxpool.Pool) {
	ctx := context.Background()
	cleanups := []func(){
		func() { _, _ = pool.Exec(ctx, `delete from verrail_acceptances where id = any($1::uuid[])`, h.aggregateIDs) },
		func() { _, _ = pool.Exec(ctx, `delete from verrail_delivery_reviews where id = any($1::uuid[])`, h.aggregateIDs) },
		func() { _, _ = pool.Exec(ctx, `delete from verrail_submissions where id = any($1::uuid[])`, h.aggregateIDs) },
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_command_receipts where workspace_id=$1 and idempotency_key = any($2)`, h.workspaceID, h.adjudicationReceiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_audit_events where workspace_id=$1 and idempotency_key = any($2)`, h.workspaceID, h.adjudicationReceiptKeys)
		},
	}
	for _, cleanup := range cleanups {
		cleanup()
	}
	for _, principalID := range []string{h.reviewerPrincipalID, h.otherPrincipalID} {
		_, _ = pool.Exec(ctx, `delete from company_memberships where company_id=$1 and principal_id=$2`, h.workspaceID, principalID)
	}
	h.assuranceTestHarness.cleanup(pool)
}

func TestAdjudicationContractsIntegration(t *testing.T) {
	databaseURL := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	require.NoError(t, err)
	defer pool.Close()

	harness := newAdjudicationTestHarness(t, pool)
	defer harness.cleanup(pool)

	targetID, targetRevisionID := harness.createTarget()
	artifactID := harness.createArtifact(targetID)
	revisionResult, err := harness.addRevision(artifactID, AddArtifactRevisionInput{ContentHash: assuranceTestHash, ContentRef: "git:one"})
	require.NoError(t, err)
	artifactRevisionID := revisionResult.ResourceID
	claimID := harness.createClaim(targetID, targetRevisionID, "ac-1")
	evidenceID := harness.recordEvidence(targetID, &claimID, "6666666666666666666666666666666666666666666666666666666666666666")
	verification, err := harness.recordVerificationResult(RecordVerificationResultInput{
		ClaimID:         claimID,
		Verdict:         "passed",
		VerifierVersion: "ci.v1",
		EvidenceIDs:     []string{evidenceID},
	})
	require.NoError(t, err)

	submissionInput := CreateSubmissionInput{
		TargetID:              targetID,
		TargetRevisionID:      targetRevisionID,
		ArtifactRevisionIDs:   []string{artifactRevisionID},
		VerificationResultIDs: []string{verification.ResourceID},
		CommitRef:             ptr("git:candidate-1"),
	}
	newSubmission := func(t *testing.T, commitRef string) string {
		t.Helper()
		submission, err := harness.createSubmission(t, CreateSubmissionInput{
			TargetID:            targetID,
			TargetRevisionID:    targetRevisionID,
			ArtifactRevisionIDs: []string{artifactRevisionID},
			CommitRef:           ptr(commitRef),
		})
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, submission.ResourceID)
		return submission.ResourceID
	}
	ownerSubmissionID := ""
	ownerAcceptanceID := ""

	t.Run("full happy path from submission to owner acceptance", func(t *testing.T) {
		submission, err := harness.createSubmission(t, submissionInput)
		require.NoError(t, err)
		require.False(t, submission.Replayed)
		harness.aggregateIDs = append(harness.aggregateIDs, submission.ResourceID)

		review, err := harness.recordReview(t, harness.reviewerPrincipalID, submission.ResourceID, "approved")
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, review.ResourceID)

		acceptance, err := harness.accept(t, harness.principalID, submission.ResourceID, review.ResourceID)
		require.NoError(t, err)
		require.False(t, acceptance.Replayed)
		harness.aggregateIDs = append(harness.aggregateIDs, acceptance.ResourceID)

		var authority, acceptedBy, boundReview string
		require.NoError(t, pool.QueryRow(ctx, `select authority,accepted_by_principal_id,review_id from verrail_acceptances where id=$1`, acceptance.ResourceID).Scan(&authority, &acceptedBy, &boundReview))
		require.Equal(t, "outcome_owner", authority)
		require.Equal(t, harness.principalID, acceptedBy)
		require.Equal(t, review.ResourceID, boundReview)

		// Content-addressed: resubmitting the identical binding replays the
		// existing submission under a fresh idempotency key.
		replay, err := harness.createSubmission(t, submissionInput)
		require.NoError(t, err)
		require.True(t, replay.Replayed)
		require.Equal(t, submission.ResourceID, replay.ResourceID)

		acceptReplay, err := harness.accept(t, harness.principalID, submission.ResourceID, review.ResourceID)
		require.NoError(t, err)
		require.True(t, acceptReplay.Replayed)
		require.Equal(t, acceptance.ResourceID, acceptReplay.ResourceID)
	})

	t.Run("reviewer must differ from the submitter", func(t *testing.T) {
		submission, err := harness.createSubmission(t, CreateSubmissionInput{
			TargetID:            targetID,
			TargetRevisionID:    targetRevisionID,
			ArtifactRevisionIDs: []string{artifactRevisionID},
			CommitRef:           ptr("git:self-review"),
		})
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, submission.ResourceID)

		_, err = harness.recordReview(t, harness.principalID, submission.ResourceID, "approved")
		requireLifecycleCode(t, err, "ADJUDICATION_REVIEWER_NOT_INDEPENDENT")
	})

	t.Run("verification results must bind claims of the submitted revision", func(t *testing.T) {
		otherTargetID, otherRevisionID := harness.createTarget()
		otherClaim := harness.createClaim(otherTargetID, otherRevisionID, "ac-1")
		otherEvidence := harness.recordEvidence(otherTargetID, &otherClaim, "7777777777777777777777777777777777777777777777777777777777777777")
		otherVerification, err := harness.recordVerificationResult(RecordVerificationResultInput{
			ClaimID:         otherClaim,
			Verdict:         "passed",
			VerifierVersion: "ci.v1",
			EvidenceIDs:     []string{otherEvidence},
		})
		require.NoError(t, err)

		_, err = harness.createSubmission(t, CreateSubmissionInput{
			TargetID:              targetID,
			TargetRevisionID:      targetRevisionID,
			ArtifactRevisionIDs:   []string{artifactRevisionID},
			VerificationResultIDs: []string{otherVerification.ResourceID},
			CommitRef:             ptr("git:misattributed"),
		})
		requireLifecycleCode(t, err, "ASSURANCE_RESOURCE_NOT_FOUND")
	})

	t.Run("acceptance requires an approved latest review of that submission", func(t *testing.T) {
		blockedSubmission := newSubmission(t, "git:blocked")

		approvedReview, err := harness.recordReview(t, harness.reviewerPrincipalID, blockedSubmission, "approved")
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, approvedReview.ResourceID)

		changesReview, err := harness.recordReview(t, harness.reviewerPrincipalID, blockedSubmission, "changes_requested")
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, changesReview.ResourceID)

		_, err = harness.accept(t, harness.principalID, blockedSubmission, approvedReview.ResourceID)
		requireLifecycleCode(t, err, "ADJUDICATION_REVIEW_NOT_APPROVED")

		_, err = harness.accept(t, harness.principalID, blockedSubmission, changesReview.ResourceID)
		requireLifecycleCode(t, err, "ADJUDICATION_REVIEW_NOT_APPROVED")

		otherSubmission := newSubmission(t, "git:blocked-other")
		_, err = harness.accept(t, harness.principalID, otherSubmission, approvedReview.ResourceID)
		requireLifecycleCode(t, err, "ADJUDICATION_REVIEW_NOT_APPROVED")
	})

	t.Run("only the target revision outcome owner can accept", func(t *testing.T) {
		submission := newSubmission(t, "git:owner-check")
		review, err := harness.recordReview(t, harness.reviewerPrincipalID, submission, "approved")
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, review.ResourceID)

		_, err = harness.accept(t, harness.otherPrincipalID, submission, review.ResourceID)
		requireLifecycleCode(t, err, "ADJUDICATION_NOT_OUTCOME_OWNER")

		acceptance, err := harness.accept(t, harness.principalID, submission, review.ResourceID)
		require.NoError(t, err)
		require.False(t, acceptance.Replayed)
		harness.aggregateIDs = append(harness.aggregateIDs, acceptance.ResourceID)
		ownerSubmissionID = submission
		ownerAcceptanceID = acceptance.ResourceID
	})

	t.Run("a newer submission supersedes the accepted one", func(t *testing.T) {
		require.NotEmpty(t, ownerAcceptanceID)
		var hashBefore string
		require.NoError(t, pool.QueryRow(ctx, `select acceptance_hash from verrail_acceptances where id=$1`, ownerAcceptanceID).Scan(&hashBefore))

		newSubmission(t, "git:superseding")

		var latestID string
		require.NoError(t, pool.QueryRow(ctx, `select id from verrail_submissions where target_id=$1 order by created_at desc, id desc limit 1`, targetID).Scan(&latestID))
		validity, reason := deriveAcceptanceValidity(latestID == ownerSubmissionID, true)
		require.Equal(t, "invalid", validity)
		require.Equal(t, "superseded_submission", reason)

		var hashAfter string
		require.NoError(t, pool.QueryRow(ctx, `select acceptance_hash from verrail_acceptances where id=$1`, ownerAcceptanceID).Scan(&hashAfter))
		require.Equal(t, hashBefore, hashAfter, "invalidation is derived; the acceptance row stays immutable")
	})

	t.Run("changing the active target revision invalidates acceptance by derivation", func(t *testing.T) {
		require.NotEmpty(t, ownerAcceptanceID)
		latestSubmission := newSubmission(t, "git:revision-change")
		review, err := harness.recordReview(t, harness.reviewerPrincipalID, latestSubmission, "approved")
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, review.ResourceID)
		latestAcceptance, err := harness.accept(t, harness.principalID, latestSubmission, review.ResourceID)
		require.NoError(t, err)
		require.False(t, latestAcceptance.Replayed)
		harness.aggregateIDs = append(harness.aggregateIDs, latestAcceptance.ResourceID)

		validity, reason := deriveAcceptanceValidity(true, true)
		require.Equal(t, "valid", validity)
		require.Empty(t, reason)

		var hashBefore string
		require.NoError(t, pool.QueryRow(ctx, `select acceptance_hash from verrail_acceptances where id=$1`, latestAcceptance.ResourceID).Scan(&hashBefore))

		var nextRevisionID string
		require.NoError(t, pool.QueryRow(ctx, `
			insert into verrail_target_revisions (id, workspace_id, target_id, revision_number, title, outcome_owner_principal_type, outcome_owner_principal_id, goal, constraints, acceptance_criteria, risk_level, content_hash, created_by_principal_type, created_by_principal_id)
			values ($1, $2, $3, 2, 'Second revision', 'user', $4, 'prove the adjudication data spine end to end', '[]'::jsonb, '[]'::jsonb, 'low', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'user', $4)
			returning id
		`, mustNewUUID(t), harness.workspaceID, targetID, harness.principalID).Scan(&nextRevisionID))
		_, err = pool.Exec(ctx, `update verrail_targets set active_target_revision_id=$1 where id=$2`, nextRevisionID, targetID)
		require.NoError(t, err)

		validity, reason = deriveAcceptanceValidity(true, false)
		require.Equal(t, "invalid", validity)
		require.Equal(t, "target_revision_changed", reason)

		var hashAfter string
		require.NoError(t, pool.QueryRow(ctx, `select acceptance_hash from verrail_acceptances where id=$1`, latestAcceptance.ResourceID).Scan(&hashAfter))
		require.Equal(t, hashBefore, hashAfter, "invalidation is derived; the acceptance row stays immutable")
	})
}
