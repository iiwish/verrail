package target

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestPhasedCriterionProofIntegration(t *testing.T) {
	url := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	defer pool.Close()
	h := newConnectorTestHarness(t, pool)
	defer h.cleanup(pool)
	defer func() {
		_, _ = pool.Exec(ctx, `delete from verrail_criterion_proofs where workspace_id=$1`, h.workspaceID)
	}()
	h.bindGitHubConnection()
	targetID, oldRevision := h.createTarget()
	var oldHash, criterionKey string
	var oldCriteria []byte
	require.NoError(t, pool.QueryRow(ctx, `select content_hash,acceptance_criteria,acceptance_criteria->0->>'id' from verrail_target_revisions where id=$1`, oldRevision).Scan(&oldHash, &oldCriteria, &criterionKey))
	contract := CriterionProofContract{SchemaVersion: 1, AllOf: []CriterionProofRequirement{
		{ID: "technical", Kind: "independent_verification", Phase: "pre_acceptance", Assertions: []string{"execution and independent CI"}},
		{ID: "governance", Kind: "human_governance", Phase: "post_governance"},
		{ID: "effect", Kind: "pull_request_effect", Phase: "post_effect"},
		{ID: "recovery", Kind: "independent_verification", Phase: "post_effect", Assertions: []string{"exactly-once recovery", "secret non-persistence"}},
	}}
	command := ReviseTargetProofCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: Principal{Type: "user", ID: h.principalID}, IdempotencyKey: "phased-revise", Input: ReviseTargetProofInput{ExpectedTargetRevisionID: oldRevision, Criteria: []CriterionProofChange{{CriterionID: criterionKey, ProofContract: contract}}}}
	require.NoError(t, ValidateReviseTargetProofCommand(&command))
	revised, err := h.store.ReviseTargetProof(ctx, command)
	require.NoError(t, err)
	replay, err := h.store.ReviseTargetProof(ctx, command)
	require.NoError(t, err)
	require.True(t, replay.Replayed)
	require.Equal(t, revised.TargetRevisionID, replay.TargetRevisionID)
	stale := command
	stale.IdempotencyKey = "phased-stale"
	require.NoError(t, ValidateReviseTargetProofCommand(&stale))
	_, err = h.store.ReviseTargetProof(ctx, stale)
	requireLifecycleCode(t, err, "TARGET_REVISION_CONFLICT")
	var preservedHash string
	var preservedCriteria []byte
	require.NoError(t, pool.QueryRow(ctx, `select content_hash,acceptance_criteria from verrail_target_revisions where id=$1`, oldRevision).Scan(&preservedHash, &preservedCriteria))
	require.Equal(t, oldHash, preservedHash)
	require.JSONEq(t, string(oldCriteria), string(preservedCriteria))
	var graphActive *string
	require.NoError(t, pool.QueryRow(ctx, `select active_graph_revision_id from verrail_work_graphs where target_id=$1`, targetID).Scan(&graphActive))
	require.Nil(t, graphActive)
	completion := "Version-bound proof"
	graph := CreateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: command.Principal, IdempotencyKey: "phased-graph", Input: CreateGraphRevisionInput{ExpectedTargetRevisionID: revised.TargetRevisionID, Nodes: []WorkNodeInput{
		{NodeKey: "pre", Kind: "integration_task", Stage: "verify", Title: "Technical", CompletionDefinition: &completion},
		{NodeKey: "review", Kind: "review_gate", Stage: "accept", Title: "Review", CompletionDefinition: &completion, DependencyNodeKeys: []string{"pre"}},
		{NodeKey: "accept", Kind: "acceptance_gate", Stage: "accept", Title: "Accept", CompletionDefinition: &completion, DependencyNodeKeys: []string{"review"}},
		{NodeKey: "post", Kind: "integration_task", Stage: "accept", Title: "Recovery and secrets", CompletionDefinition: &completion, DependencyNodeKeys: []string{"accept"}},
	}}}
	require.NoError(t, ValidateCreateGraphRevisionCommand(&graph))
	created, err := h.store.CreateGraphRevision(ctx, graph)
	require.NoError(t, err)
	activate := ActivateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, GraphRevisionID: created.GraphRevisionID, Principal: command.Principal, IdempotencyKey: "phased-activate"}
	require.NoError(t, ValidateActivationCommand(&activate))
	_, err = h.store.ActivateGraphRevision(ctx, activate)
	require.NoError(t, err)
	claimID := h.createClaim(targetID, revised.TargetRevisionID, criterionKey)
	artifact := h.createArtifact(targetID)
	artifactRevision, err := h.addRevision(artifact, AddArtifactRevisionInput{ContentHash: assuranceTestHash, ContentRef: "git:phased"})
	require.NoError(t, err)
	fixture := connectorTaskFixture{targetID: targetID, targetRevisionID: revised.TargetRevisionID, graphRevisionID: created.GraphRevisionID, workNodeID: workNodeIDByKey(t, pool, created.GraphRevisionID, "pre"), claimID: claimID, criterionKey: criterionKey}
	makeInput := func(requirementID string, submissionID, effectID *string) RecordIntegrationRunInput {
		input := h.integrationRunInput(fixture, "ci/"+mustNewUUID(t), "success", assuranceTestHash, "ci:phased")
		input.ProofContext = &CriterionProofContext{RequirementID: requirementID, SubmissionID: submissionID, EffectReceiptID: effectID}
		requirement := contract.AllOf[0]
		if requirementID == "recovery" {
			requirement = contract.AllOf[3]
			input.WorkNodeID = workNodeIDByKey(t, pool, created.GraphRevisionID, "post")
		}
		coverage := map[string]any{"contractHash": proofHash(contract), "requirementId": requirementID, "assertions": requirement.Assertions, "targetRevisionId": revised.TargetRevisionID, "graphRevisionId": created.GraphRevisionID, "commitRef": "abc123", "verifiedAt": time.Now().UTC().Format(time.RFC3339Nano)}
		coverage["providerRunId"] = input.ExternalRef
		coverage["providerAttempt"] = 1
		if submissionID != nil {
			coverage["submissionId"] = *submissionID
			coverage["effectReceiptId"] = *effectID
		}
		input.ProviderReceipt["criterionProof"] = coverage
		return input
	}
	record := func(input RecordIntegrationRunInput) (AgentLifecycleResult, error) {
		cmd := buildConnectorCandidateCommandAs(h, "service", "independent-ci-collector", ConnectorIntegrationRunRecordCommand, input)
		return h.store.RecordIntegrationRun(ctx, cmd)
	}
	preInput := makeInput("technical", nil, nil)
	_, err = h.store.RecordIntegrationRun(ctx, buildConnectorCommandAs(h, h.principalID, ConnectorIntegrationRunRecordCommand, preInput))
	requireLifecycleCode(t, err, "CRITERION_PROOF_VERIFIER_REQUIRED")
	missingCoverage := makeInput("technical", nil, nil)
	delete(missingCoverage.ProviderReceipt, "criterionProof")
	_, err = record(missingCoverage)
	require.Error(t, err)
	missingSource := makeInput("technical", nil, nil)
	delete(missingSource.ProviderReceipt["criterionProof"].(map[string]any), "providerRunId")
	_, err = record(missingSource)
	require.Error(t, err, "mutable receipt metadata is not a stable Provider source identity")
	pre, err := record(preInput)
	require.NoError(t, err)
	h.runIDs = append(h.runIDs, pre.ResourceID)
	var preResult string
	require.NoError(t, pool.QueryRow(ctx, `select verification_result_id from verrail_integration_runs where id=$1`, pre.ResourceID).Scan(&preResult))
	submission, err := h.store.CreateSubmission(ctx, buildConnectorCandidateCommandAs(h, "service", "candidate-service", AdjudicationSubmissionCreateCommand, CreateSubmissionInput{TargetID: targetID, TargetRevisionID: revised.TargetRevisionID, ArtifactRevisionIDs: []string{artifactRevision.ResourceID}, VerificationResultIDs: []string{preResult}, CommitRef: ptr("abc123")}))
	require.NoError(t, err)
	h.submissionIDs = append(h.submissionIDs, submission.ResourceID)
	review, err := h.store.RecordDeliveryReview(ctx, buildConnectorCommandAs(h, h.approverID, AdjudicationReviewRecordCommand, RecordDeliveryReviewInput{SubmissionID: submission.ResourceID, ReviewerPrincipalType: "user", ReviewerPrincipalID: h.approverID, Verdict: "approved", UnprovenItems: []string{}}))
	require.NoError(t, err)
	acceptance, err := h.store.AcceptSubmission(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{SubmissionID: submission.ResourceID, ReviewID: review.ResourceID}))
	require.NoError(t, err, "future governance and receipt must not create an Acceptance cycle")
	var preEvidence string
	require.NoError(t, pool.QueryRow(ctx, `select evidence_id from verrail_integration_runs where id=$1`, pre.ResourceID).Scan(&preEvidence))
	_, err = h.store.RecordVerificationResult(ctx, buildConnectorCommandAs(h, h.principalID, AssuranceVerificationRecordCommand, RecordVerificationResultInput{ClaimID: claimID, Verdict: "failed", VerifierVersion: "unbound-manual.v1", EvidenceIDs: []string{preEvidence}}))
	require.NoError(t, err)
	probe, err := pool.Begin(ctx)
	require.NoError(t, err)
	probeFacts, err := readDeliveryFacts(ctx, probe, h.workspaceID, targetID)
	require.NoError(t, err)
	require.NoError(t, probe.Rollback(ctx))
	require.True(t, probeFacts.acceptanceValid(), "unbound verification cannot supersede explicit pre-proof in only one evaluator")
	reconcile := func() ReconcileGraphResult {
		cmd := ReconcileGraphCommand{WorkspaceID: h.workspaceID, TargetID: targetID, TargetRevisionID: revised.TargetRevisionID, GraphRevisionID: created.GraphRevisionID, Principal: Principal{Type: "service", ID: "orchestration"}, IdempotencyKey: "phased-reconcile-" + mustNewUUID(t)}
		require.NoError(t, ValidateReconcileGraphCommand(&cmd))
		result, err := h.store.ReconcileGraph(ctx, cmd)
		require.NoError(t, err)
		return result
	}
	require.False(t, reconcile().AllCompleted)
	request, _, err := h.requestActionAs("service", "candidate-service", RequestPullRequestActionInput{TargetID: targetID, SubmissionID: submission.ResourceID, Params: PullRequestParams{Title: "Phased proof", Head: "feat/phased", Base: "main"}})
	require.NoError(t, err)
	var paramsHash string
	require.NoError(t, pool.QueryRow(ctx, `select params_hash from verrail_action_requests where id=$1`, request.ResourceID).Scan(&paramsHash))
	_, err = h.approveActionAs(h.approverID, ApproveActionInput{ActionRequestID: request.ResourceID, ApproverPrincipalType: "user", ApproverPrincipalID: h.approverID, ParamsHash: paramsHash})
	require.NoError(t, err)
	effect, err := h.executeAction(ExecuteActionInput{ActionRequestID: request.ResourceID})
	require.NoError(t, err)
	lateInput := makeInput("recovery", &submission.ResourceID, &effect.ResourceID)
	incomplete := makeInput("recovery", &submission.ResourceID, &effect.ResourceID)
	incomplete.ProviderReceipt["criterionProof"].(map[string]any)["assertions"] = []string{"exactly-once recovery"}
	_, err = record(incomplete)
	require.Error(t, err, "a receipt and recovery assertion cannot waive secret handling")
	late, err := record(lateInput)
	require.NoError(t, err)
	h.runIDs = append(h.runIDs, late.ResourceID)
	var lateResult, bindingResult string
	require.NoError(t, pool.QueryRow(ctx, `select integration.verification_result_id,proof.verification_result_id from verrail_integration_runs integration join verrail_criterion_proofs proof on proof.integration_run_id=integration.id where integration.id=$1`, late.ResourceID).Scan(&lateResult, &bindingResult))
	require.Equal(t, lateResult, bindingResult, "the original CI result identity is preserved")
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	facts, err := readDeliveryFacts(ctx, tx, h.workspaceID, targetID)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	require.True(t, facts.acceptanceValid())
	require.Equal(t, acceptance.ResourceID, facts.acceptanceID)
	require.True(t, reconcile().AllCompleted)
	neutralLate := makeInput("recovery", &submission.ResourceID, &effect.ResourceID)
	neutralLate.Conclusion = "neutral"
	neutralLate.ProviderReceipt["conclusion"] = "neutral"
	neutralProof, err := record(neutralLate)
	require.NoError(t, err, "late inconclusive evidence must not be discarded after a previous pass")
	h.runIDs = append(h.runIDs, neutralProof.ResourceID)
	require.False(t, reconcile().AllCompleted)
	failedLate := makeInput("recovery", &submission.ResourceID, &effect.ResourceID)
	failedLate.Conclusion = "failure"
	failedLate.ProviderReceipt["conclusion"] = "failure"
	failedProof, err := record(failedLate)
	require.NoError(t, err, "an independent late failure must remain recordable after an earlier pass")
	h.runIDs = append(h.runIDs, failedProof.ResourceID)
	require.False(t, reconcile().AllCompleted)
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	facts, err = readDeliveryFacts(ctx, tx, h.workspaceID, targetID)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	require.True(t, facts.acceptanceValid(), "late failures block Outcome, not the earlier candidate Acceptance")
	replayedLate, err := record(lateInput)
	require.NoError(t, err)
	require.Equal(t, late.ResourceID, replayedLate.ResourceID, "the same provider source with a new command key must replay its original fact")
	require.False(t, reconcile().AllCompleted, "replaying an older passing source must not supersede the newer failure")
	require.True(t, replayedLate.Replayed)
	changedSource := makeInput("recovery", &submission.ResourceID, &effect.ResourceID)
	changedSource.ProviderReceipt["criterionProof"].(map[string]any)["providerRunId"] = lateInput.ExternalRef
	_, err = record(changedSource)
	requireLifecycleCode(t, err, "CRITERION_PROOF_SOURCE_CONFLICT")
	recovered, err := record(makeInput("recovery", &submission.ResourceID, &effect.ResourceID))
	require.NoError(t, err, "a genuinely new Provider run can restore post-effect proof")
	h.runIDs = append(h.runIDs, recovered.ResourceID)
	require.True(t, reconcile().AllCompleted)
	nextAttempt := makeInput("recovery", &submission.ResourceID, &effect.ResourceID)
	nextAttempt.ProviderReceipt["criterionProof"].(map[string]any)["providerRunId"] = failedLate.ExternalRef
	nextAttempt.ProviderReceipt["criterionProof"].(map[string]any)["providerAttempt"] = 2
	attemptProof, err := record(nextAttempt)
	require.NoError(t, err, "a new attempt of the same Provider run is independent new proof")
	h.runIDs = append(h.runIDs, attemptProof.ResourceID)
	failedPre := makeInput("technical", nil, nil)
	failedPre.Conclusion = "failure"
	failedPre.ProviderReceipt["conclusion"] = "failure"
	newPre, err := record(failedPre)
	require.NoError(t, err)
	h.runIDs = append(h.runIDs, newPre.ResourceID)
	replayedPre, err := record(preInput)
	require.NoError(t, err)
	require.Equal(t, pre.ResourceID, replayedPre.ResourceID)
	require.False(t, reconcile().AllCompleted, "pre-proof replay cannot undo a newer failure either")
	tx, err = pool.Begin(ctx)
	require.NoError(t, err)
	facts, err = readDeliveryFacts(ctx, tx, h.workspaceID, targetID)
	require.NoError(t, err)
	require.NoError(t, tx.Rollback(ctx))
	require.False(t, facts.acceptanceValid(), "replayed pre-proof is not a new current candidate proof")
	_, err = h.store.CreateSubmission(ctx, buildConnectorCandidateCommandAs(h, "service", "candidate-service", AdjudicationSubmissionCreateCommand, CreateSubmissionInput{TargetID: targetID, TargetRevisionID: revised.TargetRevisionID, ArtifactRevisionIDs: []string{artifactRevision.ResourceID}, VerificationResultIDs: []string{preResult, lateResult}, CommitRef: ptr("abc123")}))
	require.Error(t, err, "a late result cannot enter a new immutable pre-proof candidate")
	var bindingCount int
	require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_criterion_proofs where target_id=$1`, targetID).Scan(&bindingCount))
	require.Equal(t, 7, bindingCount)
	var criteriaAfter []AcceptanceCriterion
	require.NoError(t, json.Unmarshal(oldCriteria, &criteriaAfter))
	require.Nil(t, criteriaAfter[0].ProofContract)
}

func TestFourCriteriaCollectSeparatePreProofs(t *testing.T) {
	url := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	defer pool.Close()
	h := newConnectorTestHarness(t, pool)
	defer h.cleanup(pool)
	defer func() {
		_, _ = pool.Exec(ctx, `delete from verrail_criterion_proofs where workspace_id=$1`, h.workspaceID)
	}()
	h.bindGitHubConnection()
	create := CreateCommand{WorkspaceID: h.workspaceID, Principal: Principal{Type: "user", ID: h.principalID}, IdempotencyKey: "four-criteria-create", Input: CreateInput{Title: "Four mandatory criteria", Goal: "Collect all independent proofs", OutcomeOwner: OutcomeOwner{PrincipalType: "user", PrincipalID: h.principalID}, RiskLevel: "medium", AcceptanceCriteria: []AcceptanceCriterionInput{{Title: "Feishu intake"}, {Title: "Codex and CI"}, {Title: "Three human decisions"}, {Title: "PR recovery and secret handling"}}}}
	require.NoError(t, ValidateCommand(&create))
	target, err := h.store.Create(ctx, create)
	require.NoError(t, err)
	h.targetIDs = append(h.targetIDs, target.TargetID)
	var raw []byte
	require.NoError(t, pool.QueryRow(ctx, `select acceptance_criteria from verrail_target_revisions where id=$1`, target.TargetRevisionID).Scan(&raw))
	var criteria []AcceptanceCriterion
	require.NoError(t, json.Unmarshal(raw, &criteria))
	contracts := []CriterionProofContract{
		{SchemaVersion: 1, AllOf: []CriterionProofRequirement{{ID: "intake", Kind: "independent_verification", Phase: "pre_acceptance", Assertions: []string{"Feishu intake is bound"}}}},
		{SchemaVersion: 1, AllOf: []CriterionProofRequirement{{ID: "ci", Kind: "independent_verification", Phase: "pre_acceptance", Assertions: []string{"Codex executes", "independent CI passes"}}}},
		{SchemaVersion: 1, AllOf: []CriterionProofRequirement{{ID: "human", Kind: "human_governance", Phase: "post_governance"}}},
		{SchemaVersion: 1, AllOf: []CriterionProofRequirement{{ID: "pr", Kind: "pull_request_effect", Phase: "post_effect"}, {ID: "recovery", Kind: "independent_verification", Phase: "post_effect", Assertions: []string{"recovery passes", "secrets are not persisted"}}}},
	}
	changes := make([]CriterionProofChange, len(criteria))
	for index, criterion := range criteria {
		changes[index] = CriterionProofChange{CriterionID: criterion.ID, ProofContract: contracts[index]}
	}
	revise := ReviseTargetProofCommand{WorkspaceID: h.workspaceID, TargetID: target.TargetID, Principal: create.Principal, IdempotencyKey: "four-criteria-revise", Input: ReviseTargetProofInput{ExpectedTargetRevisionID: target.TargetRevisionID, Criteria: changes}}
	require.NoError(t, ValidateReviseTargetProofCommand(&revise))
	revision, err := h.store.ReviseTargetProof(ctx, revise)
	require.NoError(t, err)
	completion := "Bound independent proof"
	graphCommand := CreateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: target.TargetID, Principal: create.Principal, IdempotencyKey: "four-criteria-graph", Input: CreateGraphRevisionInput{ExpectedTargetRevisionID: revision.TargetRevisionID, Nodes: []WorkNodeInput{
		{NodeKey: "verify-0-intake", Kind: "integration_task", Stage: "verify", Title: "Feishu", CompletionDefinition: &completion},
		{NodeKey: "verify-1-ci", Kind: "integration_task", Stage: "verify", Title: "CI", CompletionDefinition: &completion},
		{NodeKey: "review", Kind: "review_gate", Stage: "accept", Title: "Review", CompletionDefinition: &completion, DependencyNodeKeys: []string{"verify-0-intake", "verify-1-ci"}},
		{NodeKey: "accept", Kind: "acceptance_gate", Stage: "accept", Title: "Accept", CompletionDefinition: &completion, DependencyNodeKeys: []string{"review"}},
		{NodeKey: "verify-3-recovery", Kind: "integration_task", Stage: "accept", Title: "Recovery", CompletionDefinition: &completion, DependencyNodeKeys: []string{"accept"}},
	}}}
	require.NoError(t, ValidateCreateGraphRevisionCommand(&graphCommand))
	graph, err := h.store.CreateGraphRevision(ctx, graphCommand)
	require.NoError(t, err)
	activation := ActivateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: target.TargetID, GraphRevisionID: graph.GraphRevisionID, Principal: create.Principal, IdempotencyKey: "four-criteria-activate"}
	require.NoError(t, ValidateActivationCommand(&activation))
	_, err = h.store.ActivateGraphRevision(ctx, activation)
	require.NoError(t, err)
	resultIDs := []string{}
	for index, nodeKey := range []string{"verify-0-intake", "verify-1-ci"} {
		criterion := criteria[index]
		requirement := contracts[index].AllOf[0]
		claim := h.createClaim(target.TargetID, revision.TargetRevisionID, criterion.ID)
		fixture := connectorTaskFixture{targetID: target.TargetID, targetRevisionID: revision.TargetRevisionID, graphRevisionID: graph.GraphRevisionID, workNodeID: workNodeIDByKey(t, pool, graph.GraphRevisionID, nodeKey), claimID: claim, criterionKey: criterion.ID}
		input := h.integrationRunInput(fixture, "ci/"+mustNewUUID(t), "success", assuranceTestHash, "ci:four-criteria")
		input.ProofContext = &CriterionProofContext{RequirementID: requirement.ID}
		input.ProviderReceipt["criterionProof"] = map[string]any{"contractHash": proofHash(contracts[index]), "requirementId": requirement.ID, "assertions": requirement.Assertions, "targetRevisionId": revision.TargetRevisionID, "graphRevisionId": graph.GraphRevisionID, "commitRef": "abc123", "verifiedAt": time.Now().UTC().Format(time.RFC3339Nano), "providerRunId": input.ExternalRef, "providerAttempt": 1}
		result, err := h.store.RecordIntegrationRun(ctx, buildConnectorCandidateCommandAs(h, "service", "independent-ci-collector", ConnectorIntegrationRunRecordCommand, input))
		require.NoError(t, err, "each pre requirement owns a distinct active node, even after the first completes")
		h.runIDs = append(h.runIDs, result.ResourceID)
		var resultID string
		require.NoError(t, pool.QueryRow(ctx, `select verification_result_id from verrail_integration_runs where id=$1`, result.ResourceID).Scan(&resultID))
		resultIDs = append(resultIDs, resultID)
	}
	artifact := h.createArtifact(target.TargetID)
	artifactRevision, err := h.addRevision(artifact, AddArtifactRevisionInput{ContentHash: assuranceTestHash, ContentRef: "git:four-criteria"})
	require.NoError(t, err)
	submission, err := h.store.CreateSubmission(ctx, buildConnectorCandidateCommandAs(h, "service", "candidate-service", AdjudicationSubmissionCreateCommand, CreateSubmissionInput{TargetID: target.TargetID, TargetRevisionID: revision.TargetRevisionID, ArtifactRevisionIDs: []string{artifactRevision.ResourceID}, VerificationResultIDs: resultIDs, CommitRef: ptr("abc123")}))
	require.NoError(t, err, "both pre proofs aggregate without requiring future governance or effect proof")
	h.submissionIDs = append(h.submissionIDs, submission.ResourceID)
	probe, err := pool.Begin(ctx)
	require.NoError(t, err)
	facts, err := readDeliveryFacts(ctx, probe, h.workspaceID, target.TargetID)
	require.NoError(t, err)
	require.NoError(t, probe.Rollback(ctx))
	require.True(t, facts.criteriaVerified)
}
