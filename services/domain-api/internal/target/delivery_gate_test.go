package target

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestDefaultDeliveryGraphIntegration(t *testing.T) {
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
	h.bindGitHubConnection()
	lifecycle := &lifecycleTestHarness{t: t, store: h.store, workspaceID: h.workspaceID, principalID: h.principalID}
	definition := lifecycle.createDefinition()
	version := lifecycle.publishVersion(definition, "default delivery graph test")
	deployment := lifecycle.createDeployment(definition, version, lifecycle.recordPassingEvaluation(version), "delivery-gates")
	deploymentRevision := lifecycle.firstRevisionID(deployment)
	targetID, revisionID := h.createTarget()
	completion := "Record the version-bound domain fact"
	graph := CreateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: Principal{Type: "user", ID: h.principalID}, IdempotencyKey: "delivery-graph-create", Input: CreateGraphRevisionInput{ExpectedTargetRevisionID: revisionID, Nodes: []WorkNodeInput{
		{NodeKey: "implement", Kind: "agent_task", Title: "Implement", Stage: "execute", CompletionDefinition: &completion, ResponsiblePrincipal: &ResponsiblePrincipal{PrincipalType: "agent", PrincipalID: deploymentRevision}},
		{NodeKey: "ci", Kind: "integration_task", Title: "CI", Stage: "verify", CompletionDefinition: &completion, DependencyNodeKeys: []string{"implement"}},
		{NodeKey: "review", Kind: "review_gate", Title: "Review", Stage: "verify", CompletionDefinition: &completion, DependencyNodeKeys: []string{"ci"}},
		{NodeKey: "accept", Kind: "acceptance_gate", Title: "Accept", Stage: "accept", CompletionDefinition: &completion, DependencyNodeKeys: []string{"review"}},
	}}}
	require.NoError(t, ValidateCreateGraphRevisionCommand(&graph))
	created, err := h.store.CreateGraphRevision(ctx, graph)
	require.NoError(t, err)
	activation := ActivateGraphRevisionCommand{WorkspaceID: h.workspaceID, TargetID: targetID, GraphRevisionID: created.GraphRevisionID, Principal: graph.Principal, IdempotencyKey: "delivery-graph-activate"}
	require.NoError(t, ValidateActivationCommand(&activation))
	_, err = h.store.ActivateGraphRevision(ctx, activation)
	require.NoError(t, err)
	service := Principal{Type: "service", ID: "verrail-orchestration-worker"}
	reconcile := func() ReconcileGraphResult {
		command := ReconcileGraphCommand{WorkspaceID: h.workspaceID, TargetID: targetID, TargetRevisionID: revisionID, GraphRevisionID: created.GraphRevisionID, Principal: service, IdempotencyKey: "delivery-reconcile-" + mustNewUUID(t)}
		require.NoError(t, ValidateReconcileGraphCommand(&command))
		result, err := h.store.ReconcileGraph(ctx, command)
		require.NoError(t, err)
		return result
	}
	status := func(key string) string {
		var value string
		require.NoError(t, pool.QueryRow(ctx, `select status from verrail_work_nodes where graph_revision_id=$1 and node_key=$2`, created.GraphRevisionID, key).Scan(&value))
		return value
	}
	implementID := workNodeIDByKey(t, pool, created.GraphRevisionID, "implement")
	run, err := h.store.CreateRun(ctx, buildGraphRunCommand(t, h.workspaceID, targetID, created.GraphRevisionID, implementID, deploymentRevision, service, "delivery-agent-run"))
	require.NoError(t, err)
	attempt, err := h.store.CreateRunAttempt(ctx, buildRunAttemptCommand(t, h.workspaceID, run.RunID, service, "delivery-agent-attempt"))
	require.NoError(t, err)
	reportRunEvent(t, h.store, h.workspaceID, run.RunID, attempt, 1, "claimed")
	reportRunEvent(t, h.store, h.workspaceID, run.RunID, attempt, 2, "started")
	event := ReportRunEventCommand{WorkspaceID: h.workspaceID, RunID: run.RunID, RunAttemptID: attempt.RunAttemptID, Principal: Principal{Type: "service", ID: "verrail-host-runner"}, IdempotencyKey: "delivery-artifact-success", Input: ReportRunEventInput{LeaseID: attempt.LeaseID, FencingToken: attempt.FencingToken, Cursor: 3, EventType: "succeeded", EmittedAt: time.Now().UTC(), Artifacts: []RunArtifactInput{{Title: "Candidate", Kind: "code_change", ContentHash: assuranceTestHash, ContentRef: "storage:" + h.workspaceID + "/verrail/run-artifacts/sha256/" + assuranceTestHash}}}}
	require.NoError(t, ValidateReportRunEventCommand(&event))
	eventResult, err := h.store.ReportRunEvent(ctx, event)
	require.NoError(t, err)
	require.True(t, eventResult.Authoritative)
	reconcile()
	require.Equal(t, "ready", status("ci"))
	require.Equal(t, "pending", status("review"))
	var artifactRevisionID string
	require.NoError(t, pool.QueryRow(ctx, `select revision.id from verrail_artifact_revisions revision join verrail_artifacts artifact on artifact.id=revision.artifact_id where artifact.target_id=$1 order by revision.created_at desc limit 1`, targetID).Scan(&artifactRevisionID))
	partial, err := h.store.CreateSubmission(ctx, buildConnectorCandidateCommandAs(h, "service", "graph-orchestrator", AdjudicationSubmissionCreateCommand, CreateSubmissionInput{TargetID: targetID, TargetRevisionID: revisionID, ArtifactRevisionIDs: []string{artifactRevisionID}, VerificationResultIDs: []string{}, CommitRef: ptr("abc123")}))
	require.NoError(t, err)
	partialReview, err := h.store.RecordDeliveryReview(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationReviewRecordCommand, RecordDeliveryReviewInput{SubmissionID: partial.ResourceID, ReviewerPrincipalType: "user", ReviewerPrincipalID: h.principalID, Verdict: "approved", UnprovenItems: []string{"CI pending"}}))
	require.NoError(t, err)
	reconcile()
	require.Equal(t, "pending", status("review"), "a recorded Review cannot bypass unfinished dependencies")
	_, err = h.store.AcceptSubmission(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{SubmissionID: partial.ResourceID, ReviewID: partialReview.ResourceID}))
	requireLifecycleCode(t, err, "ADJUDICATION_CRITERIA_NOT_VERIFIED")
	var criterionKey string
	require.NoError(t, pool.QueryRow(ctx, `select acceptance_criteria->0->>'id' from verrail_target_revisions where id=$1`, revisionID).Scan(&criterionKey))
	claimID := h.createClaim(targetID, revisionID, criterionKey)
	fixture := connectorTaskFixture{targetID: targetID, targetRevisionID: revisionID, graphRevisionID: created.GraphRevisionID, workNodeID: workNodeIDByKey(t, pool, created.GraphRevisionID, "ci"), claimID: claimID, criterionKey: criterionKey}
	integration, err := h.recordIntegrationRun(h.integrationRunInput(fixture, "delivery-ci/1", "success", assuranceTestHash, "ci:delivery/1"))
	require.NoError(t, err)
	var verificationID string
	require.NoError(t, pool.QueryRow(ctx, `select verification_result_id from verrail_integration_runs where id=$1`, integration.ResourceID).Scan(&verificationID))
	reconcile()
	require.Equal(t, "completed", status("review"))
	require.Equal(t, "ready", status("accept"))
	submission, err := h.store.CreateSubmission(ctx, buildConnectorCandidateCommandAs(h, "service", "graph-orchestrator", AdjudicationSubmissionCreateCommand, CreateSubmissionInput{TargetID: targetID, TargetRevisionID: revisionID, ArtifactRevisionIDs: []string{artifactRevisionID}, VerificationResultIDs: []string{verificationID}, CommitRef: ptr("abc123")}))
	require.NoError(t, err)
	reconcile()
	require.Equal(t, "ready", status("review"), "a new Submission cannot inherit the old Review")
	require.Equal(t, "pending", status("accept"))
	review, err := h.store.RecordDeliveryReview(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationReviewRecordCommand, RecordDeliveryReviewInput{SubmissionID: submission.ResourceID, ReviewerPrincipalType: "user", ReviewerPrincipalID: h.principalID, Verdict: "approved", UnprovenItems: []string{}}))
	require.NoError(t, err)
	reconcile()
	require.Equal(t, "completed", status("review"), "only Graph Engine settles the current Review fact")
	require.Equal(t, "ready", status("accept"), "dependent Gate activates in the same reconciliation")
	_, err = h.store.AcceptSubmission(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{SubmissionID: submission.ResourceID, ReviewID: review.ResourceID}))
	require.NoError(t, err)
	require.True(t, reconcile().AllCompleted)
	t.Run("same TargetRevision replan cannot inherit governance", func(t *testing.T) {
		replan := graph
		replan.IdempotencyKey = "delivery-replanned-graph"
		replan.Input.Nodes = append([]WorkNodeInput(nil), graph.Input.Nodes[2:]...)
		replan.Input.Nodes[0].DependencyNodeKeys = nil
		require.NoError(t, ValidateCreateGraphRevisionCommand(&replan))
		replanned, err := h.store.CreateGraphRevision(ctx, replan)
		require.NoError(t, err)
		nextActivation := activation
		nextActivation.GraphRevisionID = replanned.GraphRevisionID
		nextActivation.IdempotencyKey = "delivery-replanned-activate"
		require.NoError(t, ValidateActivationCommand(&nextActivation))
		_, err = h.store.ActivateGraphRevision(ctx, nextActivation)
		require.NoError(t, err)
		nextReconcile := ReconcileGraphCommand{WorkspaceID: h.workspaceID, TargetID: targetID, TargetRevisionID: revisionID, GraphRevisionID: replanned.GraphRevisionID, Principal: service, IdempotencyKey: "delivery-replanned-reconcile"}
		require.NoError(t, ValidateReconcileGraphCommand(&nextReconcile))
		state, err := h.store.ReconcileGraph(ctx, nextReconcile)
		require.NoError(t, err)
		require.False(t, state.AllCompleted, "a different GraphRevision cannot inherit old Review and Acceptance")
		activation.IdempotencyKey = "delivery-original-reactivate"
		require.NoError(t, ValidateActivationCommand(&activation))
		_, err = h.store.ActivateGraphRevision(ctx, activation)
		require.NoError(t, err)
	})
	// A later Review invalidates the exact Review binding, even when also approved.
	secondReview, err := h.store.RecordDeliveryReview(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationReviewRecordCommand, RecordDeliveryReviewInput{SubmissionID: submission.ResourceID, ReviewerPrincipalType: "user", ReviewerPrincipalID: h.principalID, Verdict: "approved", UnprovenItems: []string{}}))
	require.NoError(t, err)
	require.False(t, reconcile().AllCompleted)
	require.Equal(t, "ready", status("accept"))
	_, err = h.store.AcceptSubmission(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{SubmissionID: submission.ResourceID, ReviewID: review.ResourceID}))
	requireLifecycleCode(t, err, "ADJUDICATION_REVIEW_NOT_APPROVED")
	secondAcceptance, err := h.store.AcceptSubmission(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{SubmissionID: submission.ResourceID, ReviewID: secondReview.ResourceID}))
	require.NoError(t, err, "the Outcome Owner can append Acceptance for the new exact Review without changing candidate content")
	require.False(t, secondAcceptance.Replayed)
	replayAcceptance, err := h.store.AcceptSubmission(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{SubmissionID: submission.ResourceID, ReviewID: secondReview.ResourceID}))
	require.NoError(t, err)
	require.True(t, replayAcceptance.Replayed)
	require.Equal(t, secondAcceptance.ResourceID, replayAcceptance.ResourceID)
	var acceptanceCount int
	require.NoError(t, pool.QueryRow(ctx, `select count(*) from verrail_acceptances where submission_id=$1`, submission.ResourceID).Scan(&acceptanceCount))
	require.Equal(t, 2, acceptanceCount, "the original Acceptance stays immutable and inspectable")
	require.True(t, reconcile().AllCompleted)
	var artifactID string
	require.NoError(t, pool.QueryRow(ctx, `select artifact_id from verrail_artifact_revisions where id=$1`, artifactRevisionID).Scan(&artifactID))
	_, err = h.addRevision(artifactID, AddArtifactRevisionInput{ContentHash: "9999999999999999999999999999999999999999999999999999999999999999", ContentRef: "git:changed"})
	require.NoError(t, err)
	require.False(t, reconcile().AllCompleted)
	require.Equal(t, "ready", status("review"))
	require.Equal(t, "pending", status("accept"))
	_, err = h.store.AcceptSubmission(ctx, buildConnectorCommandAs(h, h.principalID, AdjudicationAcceptanceCreateCommand, AcceptSubmissionInput{SubmissionID: partial.ResourceID, ReviewID: partialReview.ResourceID}))
	requireLifecycleCode(t, err, "ADJUDICATION_SUBMISSION_STALE")
	_, err = pool.Exec(ctx, `update verrail_work_nodes set status='blocked' where graph_revision_id=$1 and node_key='review'`, created.GraphRevisionID)
	require.NoError(t, err)
	reconcile()
	require.Equal(t, "blocked", status("review"), "explicit Gate blocking is not overwritten by fact reconciliation")
	require.Equal(t, "pending", status("accept"))
	require.NoError(t, h.rotateActiveRevision(targetID))
	staleReconcile := ReconcileGraphCommand{WorkspaceID: h.workspaceID, TargetID: targetID, TargetRevisionID: revisionID, GraphRevisionID: created.GraphRevisionID, Principal: service, IdempotencyKey: "delivery-stale-revision"}
	require.NoError(t, ValidateReconcileGraphCommand(&staleReconcile))
	_, err = h.store.ReconcileGraph(ctx, staleReconcile)
	requireLifecycleCode(t, err, "GRAPH_RECONCILE_STALE_REVISION")
}
