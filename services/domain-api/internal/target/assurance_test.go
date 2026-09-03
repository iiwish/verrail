package target

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

const assuranceTestHash = "1111111111111111111111111111111111111111111111111111111111111111"

func TestCreateArtifactInputValidation(t *testing.T) {
	valid := CreateArtifactInput{TargetID: "22222222-2222-4222-8222-222222222222", Kind: "code_change", Title: "Landing page"}
	require.NoError(t, ValidateCreateArtifactInput(&valid))

	badKind := valid
	badKind.Kind = "binary"
	require.Error(t, ValidateCreateArtifactInput(&badKind))

	badTarget := valid
	badTarget.TargetID = "not-a-uuid"
	require.Error(t, ValidateCreateArtifactInput(&badTarget))

	badTitle := valid
	badTitle.Title = ""
	require.Error(t, ValidateCreateArtifactInput(&badTitle))
}

func TestAddArtifactRevisionInputValidation(t *testing.T) {
	valid := AddArtifactRevisionInput{ArtifactID: "22222222-2222-4222-8222-222222222222", ContentHash: assuranceTestHash, ContentRef: "git:abc123"}
	require.NoError(t, ValidateAddArtifactRevisionInput(&valid))

	upperHash := valid
	upperHash.ContentHash = "A" + valid.ContentHash[1:]
	require.Error(t, ValidateAddArtifactRevisionInput(&upperHash))

	shortHash := valid
	shortHash.ContentHash = valid.ContentHash[:63]
	require.Error(t, ValidateAddArtifactRevisionInput(&shortHash))

	badRef := valid
	badRef.ContentRef = ""
	require.Error(t, ValidateAddArtifactRevisionInput(&badRef))

	badBase := valid
	badBase.BaseRevisionID = ptr("not-a-uuid")
	require.Error(t, ValidateAddArtifactRevisionInput(&badBase))
}

func TestRecordEvidenceInputValidation(t *testing.T) {
	valid := RecordEvidenceInput{
		TargetID:              "22222222-2222-4222-8222-222222222222",
		Kind:                  "ci_result",
		ProducerPrincipalType: "service",
		ProducerPrincipalID:   "ci-runner",
		ObjectHash:            assuranceTestHash,
		Reference:             "run/1234",
		TrustLevel:            "high",
	}
	require.NoError(t, ValidateRecordEvidenceInput(&valid))

	badClaim := valid
	badClaim.ClaimID = ptr("not-a-uuid")
	require.Error(t, ValidateRecordEvidenceInput(&badClaim))

	badKind := valid
	badKind.Kind = "vibes"
	require.Error(t, ValidateRecordEvidenceInput(&badKind))

	badProducer := valid
	badProducer.ProducerPrincipalType = "robot"
	require.Error(t, ValidateRecordEvidenceInput(&badProducer))

	badTrust := valid
	badTrust.TrustLevel = "absolute"
	require.Error(t, ValidateRecordEvidenceInput(&badTrust))
}

func TestRecordVerificationResultValidation(t *testing.T) {
	evidenceID := "33333333-3333-4333-8333-333333333333"
	valid := RecordVerificationResultInput{
		ClaimID:         "44444444-4444-4444-8444-444444444444",
		Verdict:         "passed",
		VerifierVersion: "ci.v1",
		EvidenceIDs:     []string{evidenceID},
	}
	require.NoError(t, ValidateRecordVerificationResultInput(&valid))

	noEvidence := valid
	noEvidence.EvidenceIDs = nil
	require.Error(t, ValidateRecordVerificationResultInput(&noEvidence))

	badVerdict := valid
	badVerdict.Verdict = "maybe"
	require.Error(t, ValidateRecordVerificationResultInput(&badVerdict))

	duplicateEvidence := valid
	duplicateEvidence.EvidenceIDs = []string{evidenceID, evidenceID}
	require.Error(t, ValidateRecordVerificationResultInput(&duplicateEvidence))

	waivedWithoutReference := valid
	waivedWithoutReference.Verdict = "waived"
	waivedWithoutReference.EvidenceIDs = nil
	require.Error(t, ValidateRecordVerificationResultInput(&waivedWithoutReference))

	waivedWithReference := RecordVerificationResultInput{
		ClaimID:         "44444444-4444-4444-8444-444444444444",
		Verdict:         "waived",
		VerifierVersion: "human.v1",
		EvidenceIDs:     nil,
		WaiverReference: ptr("EXCEPTION-1"),
	}
	require.NoError(t, ValidateRecordVerificationResultInput(&waivedWithReference))

	nonWaivedWithReference := valid
	nonWaivedWithReference.WaiverReference = ptr("EXCEPTION-1")
	require.Error(t, ValidateRecordVerificationResultInput(&nonWaivedWithReference))
}

func TestClaimStatusForVerdict(t *testing.T) {
	status, ok := claimStatusForVerdict("passed")
	require.True(t, ok)
	require.Equal(t, "supported", status)

	status, ok = claimStatusForVerdict("failed")
	require.True(t, ok)
	require.Equal(t, "refuted", status)

	status, ok = claimStatusForVerdict("waived")
	require.True(t, ok)
	require.Equal(t, "waived", status)

	_, ok = claimStatusForVerdict("inconclusive")
	require.False(t, ok, "inconclusive verdicts must leave the claim unchanged")
}

func TestVerificationResultHash(t *testing.T) {
	first := "33333333-3333-4333-8333-333333333333"
	second := "55555555-5555-4555-8555-555555555555"
	base, err := verificationResultHash("44444444-4444-4444-8444-444444444444", "passed", "ci.v1", []string{first, second}, nil)
	require.NoError(t, err)

	reordered, err := verificationResultHash("44444444-4444-4444-8444-444444444444", "passed", "ci.v1", []string{second, first}, nil)
	require.NoError(t, err)
	require.Equal(t, base, reordered, "logically identical evidence sets must hash identically")

	waived, err := verificationResultHash("44444444-4444-4444-8444-444444444444", "passed", "ci.v1", []string{first, second}, ptr("EXCEPTION-1"))
	require.NoError(t, err)
	require.NotEqual(t, base, waived)
}

func TestAssuranceRequestHashStableForReplay(t *testing.T) {
	build := func() AgentLifecycleCommand[CreateArtifactInput] {
		command := AgentLifecycleCommand[CreateArtifactInput]{
			WorkspaceID:    "11111111-1111-4111-8111-111111111111",
			Principal:      Principal{Type: "user", ID: "board-user"},
			IdempotencyKey: "assurance-replay-1",
			CommandType:    AssuranceArtifactCreateCommand,
			Input:          CreateArtifactInput{TargetID: "22222222-2222-4222-8222-222222222222", Kind: "report", Title: "Report"},
		}
		require.NoError(t, ValidateAgentLifecycleCommand(&command))
		return command
	}
	require.Equal(t, build().RequestHash, build().RequestHash)

	mutated := build()
	mutated.Input.Title = "Different"
	require.NoError(t, ValidateAgentLifecycleCommand(&mutated))
	require.NotEqual(t, build().RequestHash, mutated.RequestHash)
}

type assuranceTestHarness struct {
	t                *testing.T
	store            *Store
	pool             *pgxpool.Pool
	workspaceID      string
	principalID      string
	targetIDs        []string
	aggregateIDs     []string
	receiptKeys      []string
	extraWorkspaceID *string
}

func newAssuranceTestHarness(t *testing.T, pool *pgxpool.Pool) *assuranceTestHarness {
	t.Helper()
	var workspaceID string
	err := pool.QueryRow(context.Background(), `select id from companies where status='active' order by created_at limit 1`).Scan(&workspaceID)
	if err != nil {
		t.Skipf("no seeded active workspace for assurance test: %v", err)
	}
	principalID := "assurance-contract-test-user"
	_, err = pool.Exec(context.Background(), `
		insert into company_memberships (company_id, principal_type, principal_id, status, membership_role)
		values ($1, 'user', $2, 'active', 'member')
	`, workspaceID, principalID)
	require.NoError(t, err)
	return &assuranceTestHarness{t: t, store: NewStore(pool), pool: pool, workspaceID: workspaceID, principalID: principalID}
}

func buildAssuranceCommand[T any](h *assuranceTestHarness, commandType string, resourceID string, input T) AgentLifecycleCommand[T] {
	h.t.Helper()
	idempotencyKey := "assurance-it-" + mustNewUUID(h.t)
	h.receiptKeys = append(h.receiptKeys, idempotencyKey)
	command := AgentLifecycleCommand[T]{
		WorkspaceID:    h.workspaceID,
		ResourceID:     resourceID,
		Principal:      Principal{Type: "user", ID: h.principalID},
		IdempotencyKey: idempotencyKey,
		CommandType:    commandType,
		Input:          input,
	}
	if err := ValidateAgentLifecycleCommand(&command); err != nil {
		h.t.Fatalf("validate %s command: %v", commandType, err)
	}
	return command
}

func (h *assuranceTestHarness) createTarget() (string, string) {
	h.t.Helper()
	command := CreateCommand{
		WorkspaceID:    h.workspaceID,
		Principal:      Principal{Type: "user", ID: h.principalID},
		IdempotencyKey: "assurance-target-" + mustNewUUID(h.t),
		Input: CreateInput{
			Title:              "Assurance contract test target",
			Goal:               "prove the assurance data spine end to end",
			OutcomeOwner:       OutcomeOwner{PrincipalType: "user", PrincipalID: h.principalID},
			AcceptanceCriteria: []AcceptanceCriterionInput{{Title: "Tests pass in CI"}},
			RiskLevel:          "medium",
		},
	}
	require.NoError(h.t, ValidateCommand(&command))
	result, err := h.store.Create(context.Background(), command)
	require.NoError(h.t, err)
	h.targetIDs = append(h.targetIDs, result.TargetID)
	return result.TargetID, result.TargetRevisionID
}

func (h *assuranceTestHarness) createArtifact(targetID string) string {
	h.t.Helper()
	result, err := h.store.CreateArtifact(context.Background(), buildAssuranceCommand(h, AssuranceArtifactCreateCommand, "", CreateArtifactInput{
		TargetID: targetID,
		Kind:     "code_change",
		Title:    "Assurance test artifact",
	}))
	require.NoError(h.t, err)
	h.aggregateIDs = append(h.aggregateIDs, result.ResourceID)
	return result.ResourceID
}

func (h *assuranceTestHarness) addRevision(artifactID string, input AddArtifactRevisionInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	input.ArtifactID = artifactID
	require.NoError(h.t, ValidateAddArtifactRevisionInput(&input))
	result, err := h.store.AddArtifactRevision(context.Background(), buildAssuranceCommand(h, AssuranceArtifactRevisionAddCommand, "", input))
	if err == nil {
		h.aggregateIDs = append(h.aggregateIDs, result.ResourceID)
	}
	return result, err
}

func (h *assuranceTestHarness) createClaim(targetID, targetRevisionID, criterionKey string) string {
	h.t.Helper()
	result, err := h.store.CreateClaim(context.Background(), buildAssuranceCommand(h, AssuranceClaimCreateCommand, "", CreateClaimInput{
		TargetID:         targetID,
		TargetRevisionID: targetRevisionID,
		CriterionKey:     criterionKey,
		Title:            "Criterion is met",
	}))
	require.NoError(h.t, err)
	h.aggregateIDs = append(h.aggregateIDs, result.ResourceID)
	return result.ResourceID
}

func (h *assuranceTestHarness) recordVerificationResult(input RecordVerificationResultInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	result, err := h.store.RecordVerificationResult(context.Background(), buildAssuranceCommand(h, AssuranceVerificationRecordCommand, "", input))
	if err == nil {
		h.aggregateIDs = append(h.aggregateIDs, result.ResourceID)
	}
	return result, err
}

func (h *assuranceTestHarness) recordEvidence(targetID string, claimID *string, objectHash string) string {
	h.t.Helper()
	result, err := h.store.RecordEvidence(context.Background(), buildAssuranceCommand(h, AssuranceEvidenceRecordCommand, "", RecordEvidenceInput{
		TargetID:              targetID,
		ClaimID:               claimID,
		Kind:                  "ci_result",
		ProducerPrincipalType: "service",
		ProducerPrincipalID:   "ci-runner",
		ObjectHash:            objectHash,
		Reference:             "ci/run/1234",
		TrustLevel:            "high",
	}))
	require.NoError(h.t, err)
	h.aggregateIDs = append(h.aggregateIDs, result.ResourceID)
	return result.ResourceID
}

func (h *assuranceTestHarness) claimStatus(claimID string) string {
	h.t.Helper()
	var status string
	if err := h.pool.QueryRow(context.Background(), `select status from verrail_claims where id=$1`, claimID).Scan(&status); err != nil {
		h.t.Fatalf("read claim status: %v", err)
	}
	return status
}

func (h *assuranceTestHarness) cleanup(pool *pgxpool.Pool) {
	ctx := context.Background()
	cleanups := []func(){
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_verification_results where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_evidence where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_claims where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_artifact_revisions where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_artifacts where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_command_receipts where target_id = any($1::uuid[])`, h.targetIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_targets where id = any($1::uuid[])`, h.targetIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_command_receipts where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.principalID, h.receiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_audit_events where workspace_id=$1 and principal_id=$2 and (aggregate_id = any($3::uuid[]) or aggregate_id = any($4::uuid[]) or idempotency_key = any($5))`, h.workspaceID, h.principalID, h.aggregateIDs, h.targetIDs, h.receiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from company_memberships where company_id=$1 and principal_id=$2`, h.workspaceID, h.principalID)
		},
	}
	if h.extraWorkspaceID != nil {
		extraWorkspaceID := *h.extraWorkspaceID
		cleanups = append(cleanups, func() {
			_, _ = pool.Exec(ctx, `delete from companies where id=$1`, extraWorkspaceID)
		})
	}
	for _, cleanup := range cleanups {
		cleanup()
	}
}

func TestAssuranceContractsIntegration(t *testing.T) {
	databaseURL := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	require.NoError(t, err)
	defer pool.Close()

	harness := newAssuranceTestHarness(t, pool)
	defer harness.cleanup(pool)

	targetID, targetRevisionID := harness.createTarget()
	artifactID := harness.createArtifact(targetID)

	t.Run("artifact revisions allocate monotonic numbers", func(t *testing.T) {
		first, err := harness.addRevision(artifactID, AddArtifactRevisionInput{ContentHash: assuranceTestHash, ContentRef: "git:one"})
		require.NoError(t, err)
		require.False(t, first.Replayed)

		second, err := harness.addRevision(artifactID, AddArtifactRevisionInput{
			ContentHash: "2222222222222222222222222222222222222222222222222222222222222222",
			ContentRef:  "git:two",
		})
		require.NoError(t, err)
		require.False(t, second.Replayed)

		var numbers []int
		require.NoError(t, pool.QueryRow(ctx, `select array(select revision_number from verrail_artifact_revisions where artifact_id=$1 order by revision_number)`, artifactID).Scan(&numbers))
		require.Equal(t, []int{1, 2}, numbers)
	})

	t.Run("receipt replay returns the stored result", func(t *testing.T) {
		input := AddArtifactRevisionInput{ArtifactID: artifactID, ContentHash: "3333333333333333333333333333333333333333333333333333333333333333", ContentRef: "git:three"}
		command := buildAssuranceCommand(harness, AssuranceArtifactRevisionAddCommand, "", input)
		first, err := harness.store.AddArtifactRevision(ctx, command)
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, first.ResourceID)
		require.False(t, first.Replayed)

		replay, err := harness.store.AddArtifactRevision(ctx, command)
		require.NoError(t, err)
		require.True(t, replay.Replayed)
		require.Equal(t, first.ResourceID, replay.ResourceID)
	})

	t.Run("same idempotency key with a different request conflicts", func(t *testing.T) {
		input := AddArtifactRevisionInput{ArtifactID: artifactID, ContentHash: "4444444444444444444444444444444444444444444444444444444444444444", ContentRef: "git:four"}
		command := buildAssuranceCommand(harness, AssuranceArtifactRevisionAddCommand, "", input)
		first, err := harness.store.AddArtifactRevision(ctx, command)
		require.NoError(t, err)
		harness.aggregateIDs = append(harness.aggregateIDs, first.ResourceID)

		command.Input.ContentRef = "git:four-changed"
		require.NoError(t, ValidateAgentLifecycleCommand(&command))
		_, err = harness.store.AddArtifactRevision(ctx, command)
		requireLifecycleCode(t, err, "TARGET_IDEMPOTENCY_CONFLICT")
	})

	t.Run("duplicate content hash replays the existing revision", func(t *testing.T) {
		input := AddArtifactRevisionInput{ContentHash: "5555555555555555555555555555555555555555555555555555555555555555", ContentRef: "git:five"}
		first, err := harness.addRevision(artifactID, input)
		require.NoError(t, err)

		duplicate, err := harness.addRevision(artifactID, input)
		require.NoError(t, err)
		require.True(t, duplicate.Replayed)
		require.Equal(t, first.ResourceID, duplicate.ResourceID)
	})

	claimID := harness.createClaim(targetID, targetRevisionID, "ac-1")
	evidenceID := harness.recordEvidence(targetID, &claimID, "6666666666666666666666666666666666666666666666666666666666666666")

	t.Run("verification flips the claim to supported", func(t *testing.T) {
		result, err := harness.recordVerificationResult(RecordVerificationResultInput{
			ClaimID:         claimID,
			Verdict:         "passed",
			VerifierVersion: "ci.v1",
			EvidenceIDs:     []string{evidenceID},
		})
		require.NoError(t, err)
		require.False(t, result.Replayed)
		require.Equal(t, "supported", harness.claimStatus(claimID))
	})

	t.Run("inconclusive leaves the claim status unchanged", func(t *testing.T) {
		secondEvidence := harness.recordEvidence(targetID, &claimID, "7777777777777777777777777777777777777777777777777777777777777777")
		_, err := harness.recordVerificationResult(RecordVerificationResultInput{
			ClaimID:         claimID,
			Verdict:         "inconclusive",
			VerifierVersion: "ci.v1",
			EvidenceIDs:     []string{secondEvidence},
		})
		require.NoError(t, err)
		require.Equal(t, "supported", harness.claimStatus(claimID))
	})

	t.Run("waived verdict requires a waiver reference and marks the claim waived", func(t *testing.T) {
		waiverClaim := harness.createClaim(targetID, targetRevisionID, "ac-2")
		waiverEvidence := harness.recordEvidence(targetID, &waiverClaim, "8888888888888888888888888888888888888888888888888888888888888888")

		invalidWaiver := RecordVerificationResultInput{
			ClaimID:         waiverClaim,
			Verdict:         "waived",
			VerifierVersion: "human.v1",
			EvidenceIDs:     []string{waiverEvidence},
		}
		require.Error(t, ValidateRecordVerificationResultInput(&invalidWaiver))

		validWaiver := RecordVerificationResultInput{
			ClaimID:         waiverClaim,
			Verdict:         "waived",
			VerifierVersion: "human.v1",
			EvidenceIDs:     []string{},
			WaiverReference: ptr("EXCEPTION-42"),
		}
		require.NoError(t, ValidateRecordVerificationResultInput(&validWaiver))
		_, err := harness.recordVerificationResult(validWaiver)
		require.NoError(t, err)
		require.Equal(t, "waived", harness.claimStatus(waiverClaim))
	})

	t.Run("verification rejects evidence outside the workspace", func(t *testing.T) {
		var otherWorkspace string
		err := pool.QueryRow(ctx, `select id from companies where status='active' and id <> $1 order by created_at limit 1`, harness.workspaceID).Scan(&otherWorkspace)
		if err != nil {
			otherWorkspace = mustNewUUID(t)
			_, err = pool.Exec(ctx, `insert into companies (id, name, issue_prefix) values ($1, 'assurance cross workspace test', $2)`, otherWorkspace, "AXT"+mustNewUUID(t)[:8])
			require.NoError(t, err)
			harness.extraWorkspaceID = &otherWorkspace
		}
		foreignEvidence := mustNewUUID(t)
		harness.aggregateIDs = append(harness.aggregateIDs, foreignEvidence)
		_, err = pool.Exec(ctx, `
			insert into verrail_evidence (id, workspace_id, target_id, kind, producer_principal_type, producer_principal_id, object_hash, reference, trust_level, created_by_principal_type, created_by_principal_id)
			values ($1, $2, $3, 'ci_result', 'service', 'ci-runner', $4, 'external://other', 'high', 'user', 'assurance-test')
		`, foreignEvidence, otherWorkspace, targetID, "9999999999999999999999999999999999999999999999999999999999999999")
		require.NoError(t, err)

		failedClaim := harness.createClaim(targetID, targetRevisionID, "ac-3")
		_, err = harness.recordVerificationResult(RecordVerificationResultInput{
			ClaimID:         failedClaim,
			Verdict:         "failed",
			VerifierVersion: "scanner.v1",
			EvidenceIDs:     []string{foreignEvidence},
		})
		requireLifecycleCode(t, err, "ASSURANCE_RESOURCE_NOT_FOUND")
		require.Equal(t, "open", harness.claimStatus(failedClaim), "a rejected verification must not touch the claim status")
	})

	t.Run("identical verification payload deduplicates by result hash", func(t *testing.T) {
		claim := harness.createClaim(targetID, targetRevisionID, "ac-4")
		evidence := harness.recordEvidence(targetID, &claim, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
		input := RecordVerificationResultInput{
			ClaimID:         claim,
			Verdict:         "failed",
			VerifierVersion: "scanner.v1",
			EvidenceIDs:     []string{evidence},
		}
		first, err := harness.recordVerificationResult(input)
		require.NoError(t, err)
		require.Equal(t, "refuted", harness.claimStatus(claim))

		duplicate, err := harness.recordVerificationResult(input)
		require.NoError(t, err)
		require.True(t, duplicate.Replayed)
		require.Equal(t, first.ResourceID, duplicate.ResourceID)
	})

	t.Run("evidence binds claim and trust level", func(t *testing.T) {
		var boundClaim *string
		var trustLevel string
		require.NoError(t, pool.QueryRow(ctx, `select claim_id, trust_level from verrail_evidence where id=$1`, evidenceID).Scan(&boundClaim, &trustLevel))
		require.NotNil(t, boundClaim)
		require.Equal(t, claimID, *boundClaim)
		require.Equal(t, "high", trustLevel)
	})
}
