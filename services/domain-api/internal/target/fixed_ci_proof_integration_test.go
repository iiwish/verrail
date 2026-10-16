package target

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

type fixedCIIntegrationFixture struct {
	t                         *testing.T
	pool                      *pgxpool.Pool
	lifecycle                 *lifecycleTestHarness
	profile                   FixedCIProofTrustProfile
	input                     FixedCIProofInput
	sourceNodeID, principalID string
	identity                  map[string]any
	event                     ReportRunEventCommand
}

func fixedCIIntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

func seedFixedCIIntegration(t *testing.T, pool *pgxpool.Pool, preserve bool) *fixedCIIntegrationFixture {
	return seedProofIntegration(t, pool, preserve, []string{"ts_tests", "ts_typecheck", "ts_build", "go_tests"})
}

func seedProofIntegration(t *testing.T, pool *pgxpool.Pool, preserve bool, assertions []string) *fixedCIIntegrationFixture {
	t.Helper()
	ctx := context.Background()
	workspaceID, principalID := mustNewUUID(t), "fixed-ci-operator-"+mustNewUUID(t)
	_, err := pool.Exec(ctx, `insert into companies(id,name,issue_prefix,status) values($1,'Fixed CI Test',$2,'active')`, workspaceID, "FCI"+workspaceID[:5])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `insert into company_memberships(company_id,principal_type,principal_id,status,membership_role) values($1,'user',$2,'active','member')`, workspaceID, principalID)
	require.NoError(t, err)
	store := NewStore(pool)
	lifecycle := &lifecycleTestHarness{t: t, store: store, workspaceID: workspaceID, principalID: principalID}
	h := &connectorTestHarness{assuranceTestHarness: &assuranceTestHarness{t: t, store: store, pool: pool, workspaceID: workspaceID, principalID: principalID}}
	f := &fixedCIIntegrationFixture{t: t, pool: pool, lifecycle: lifecycle, principalID: principalID}
	if !preserve {
		t.Cleanup(f.cleanup)
	}
	h.bindGitHubConnection()
	_, err = pool.Exec(ctx, `update tool_connections set auth_kind='api_key' where company_id=$1`, workspaceID)
	require.NoError(t, err)
	definition := lifecycle.createDefinition()
	version := lifecycle.publishVersion(definition, "fixed CI source fixture")
	evaluation := lifecycle.recordPassingEvaluation(version)
	deployment := lifecycle.createDeployment(definition, version, evaluation, "fixed-ci-deployment")
	deploymentRevision := lifecycle.firstRevisionID(deployment)
	targetID, revisionID := h.createTarget()
	var criterion string
	require.NoError(t, pool.QueryRow(ctx, `select acceptance_criteria->0->>'id' from verrail_target_revisions where id=$1`, revisionID).Scan(&criterion))
	revise := ReviseTargetProofCommand{WorkspaceID: workspaceID, TargetID: targetID, Principal: Principal{Type: "user", ID: principalID}, IdempotencyKey: "fixed-proof-revise", Input: ReviseTargetProofInput{ExpectedTargetRevisionID: revisionID, Criteria: []CriterionProofChange{{CriterionID: criterion, ProofContract: CriterionProofContract{SchemaVersion: 1, AllOf: []CriterionProofRequirement{{ID: "technical", Kind: "independent_verification", Phase: "pre_acceptance", Assertions: assertions}}}}}}}
	require.NoError(t, ValidateReviseTargetProofCommand(&revise))
	revised, err := store.ReviseTargetProof(ctx, revise)
	require.NoError(t, err)
	completion := "fixed CI fixture"
	graph := CreateGraphRevisionCommand{WorkspaceID: workspaceID, TargetID: targetID, Principal: revise.Principal, IdempotencyKey: "fixed-proof-graph", Input: CreateGraphRevisionInput{ExpectedTargetRevisionID: revised.TargetRevisionID, Nodes: []WorkNodeInput{
		{NodeKey: "source", Kind: "agent_task", Stage: "execute", Title: "Native source", ResponsiblePrincipal: &ResponsiblePrincipal{PrincipalType: "agent", PrincipalID: deploymentRevision}, CompletionDefinition: &completion},
		{NodeKey: "verify", Kind: "integration_task", Stage: "verify", Title: "Fixed CI", CompletionDefinition: &completion},
	}}}
	require.NoError(t, ValidateCreateGraphRevisionCommand(&graph))
	created, err := store.CreateGraphRevision(ctx, graph)
	require.NoError(t, err)
	activation := ActivateGraphRevisionCommand{WorkspaceID: workspaceID, TargetID: targetID, GraphRevisionID: created.GraphRevisionID, Principal: revise.Principal, IdempotencyKey: "fixed-proof-activate"}
	require.NoError(t, ValidateActivationCommand(&activation))
	_, err = store.ActivateGraphRevision(ctx, activation)
	require.NoError(t, err)
	f.sourceNodeID = workNodeIDByKey(t, pool, created.GraphRevisionID, "source")
	service := Principal{Type: "service", ID: "verrail-orchestration-worker"}
	run, err := store.CreateRun(ctx, buildGraphRunCommand(t, workspaceID, targetID, created.GraphRevisionID, f.sourceNodeID, deploymentRevision, service, "fixed-proof-run"))
	require.NoError(t, err)
	attemptCommand := buildRunAttemptCommand(t, workspaceID, run.RunID, service, "fixed-proof-attempt")
	attemptCommand.Input.LeaseDurationSeconds, attemptCommand.Input.GraceDurationSeconds = 600, 60
	require.NoError(t, ValidateCreateRunAttemptCommand(&attemptCommand))
	attempt, err := store.CreateRunAttempt(ctx, attemptCommand)
	require.NoError(t, err)
	reportRunEvent(t, store, workspaceID, run.RunID, attempt, 1, "claimed")
	reportRunEvent(t, store, workspaceID, run.RunID, attempt, 2, "started")
	f.profile = fixedCIProfileFixture()
	f.profile.WorkspaceID, f.profile.TargetID, f.profile.TargetRevisionID, f.profile.GraphRevisionID = workspaceID, targetID, revised.TargetRevisionID, created.GraphRevisionID
	require.NoError(t, pool.QueryRow(ctx, `select id,connection_id from verrail_github_repo_bindings where workspace_id=$1`, workspaceID).Scan(&f.profile.BindingID, &f.profile.ConnectionID))
	f.input = fixedCIInputFixture(t, f.profile)
	f.input.ClaimID = h.createClaim(targetID, revised.TargetRevisionID, criterion)
	f.input.WorkNodeID = workNodeIDByKey(t, pool, created.GraphRevisionID, "verify")
	f.input.CriterionKey = criterion
	f.input.Source.RunID, f.input.Source.RunAttemptID = run.RunID, attempt.RunAttemptID
	f.identity = map[string]any{"workspaceId": workspaceID, "runId": run.RunID, "attemptId": attempt.RunAttemptID, "deploymentRevisionId": deploymentRevision, "agentVersionId": version, "heartbeatRunId": mustNewUUID(t), "agentId": mustNewUUID(t)}
	f.event = ReportRunEventCommand{WorkspaceID: workspaceID, RunID: run.RunID, RunAttemptID: attempt.RunAttemptID, Principal: Principal{Type: "service", ID: fixedCINativeExecutor}, IdempotencyKey: "fixed-proof-native-success", Input: ReportRunEventInput{LeaseID: attempt.LeaseID, FencingToken: attempt.FencingToken, Cursor: 3, EventType: "succeeded", EmittedAt: time.Now().UTC()}}
	return f
}

// This is a synthetic source projection for Go boundary tests, not a production
// native-output receipt or independent Provider evidence. The bridge seed below
// lets the parent build a full receipt with the actual TypeScript capture APIs.
func (f *fixedCIIntegrationFixture) completeSource() {
	t := f.t
	hash := strings.Repeat("7", 64)
	artifact := RunArtifactInput{Title: "Source snapshot", Kind: "code_change", ContentHash: hash, ContentRef: "storage:" + f.profile.WorkspaceID + "/verrail/run-artifacts/sha256/" + hash}
	receipt := map[string]any{"schemaVersion": 2, "kind": "verrail.native-output-receipt", "phase": "after_adapter_return", "sha256": f.input.Source.OutputReceiptSHA256, "sourceStatus": "stable", "collectionStatus": "collected", "finalizedAt": time.Now().UTC().Format(time.RFC3339Nano), "identity": f.identity,
		"executionFacts": map[string]any{"heartbeatStatus": "succeeded", "heartbeatRunId": f.identity["heartbeatRunId"], "agentId": f.identity["agentId"], "exitCode": 0, "errorCode": nil},
		"sourceAfter":    map[string]any{"schemaVersion": 2, "status": "captured", "manifest": map[string]any{"contentSha256": f.input.Mapping.SourceContentSHA256}},
		"beforeSource":   map[string]any{"schemaVersion": 2, "status": "captured"},
		"artifacts":      []any{map[string]any{"ordinal": 0, "path": "source-0.bundle", "type": "source_snapshot", "kind": artifact.Kind, "title": artifact.Title, "contentHash": artifact.ContentHash, "contentRef": artifact.ContentRef, "sourceSnapshot": map[string]any{"schemaVersion": 1, "format": "git_bundle", "scopeVersion": 2, "snapshotTree": f.input.Mapping.SourceSnapshotTreeSHA, "sourceContentSha256": f.input.Mapping.SourceContentSHA256}}}}
	f.event.Input.Payload = map[string]any{"outputReceipt": receipt, "sourceObservation": receipt["beforeSource"]}
	for key, value := range receipt["executionFacts"].(map[string]any) {
		f.event.Input.Payload[key] = value
	}
	f.event.Input.Artifacts = []RunArtifactInput{artifact}
	require.NoError(t, ValidateReportRunEventCommand(&f.event))
	result, err := f.lifecycle.store.ReportRunEvent(context.Background(), f.event)
	require.NoError(t, err)
	require.True(t, result.Authoritative)
	require.NoError(t, f.pool.QueryRow(context.Background(), `select id,content_hash from verrail_run_events where run_attempt_id=$1 and event_type='succeeded'`, f.input.Source.RunAttemptID).Scan(&f.input.Source.RunEventID, &f.input.Source.RunEventContentHash))
	require.NoError(t, f.pool.QueryRow(context.Background(), `select id from verrail_artifact_revisions where workspace_id=$1 and source_run_id=$2`, f.profile.WorkspaceID, f.input.Source.RunID).Scan(&f.input.ArtifactRevisionID))
}

func (f *fixedCIIntegrationFixture) cleanup() {
	ctx := context.Background()
	for _, table := range []string{"verrail_criterion_proofs", "verrail_integration_attempts", "verrail_integration_runs", "verrail_verification_results", "verrail_evidence", "verrail_claims", "verrail_github_repo_bindings"} {
		_, err := f.pool.Exec(ctx, "delete from "+table+" where workspace_id=$1", f.profile.WorkspaceID)
		require.NoError(f.t, err)
	}
	for _, table := range []string{"tool_connections", "tool_applications"} {
		_, err := f.pool.Exec(ctx, "delete from "+table+" where company_id=$1", f.profile.WorkspaceID)
		require.NoError(f.t, err)
	}
	cleanupGraphOrchestrationHarness(f.pool, f.lifecycle)
}

func (f *fixedCIIntegrationFixture) counts() map[string]int64 {
	result := map[string]int64{}
	for _, table := range []string{"verrail_evidence", "verrail_verification_results", "verrail_integration_runs", "verrail_integration_attempts", "verrail_criterion_proofs", "verrail_agent_command_receipts", "verrail_audit_events"} {
		var count int64
		require.NoError(f.t, f.pool.QueryRow(context.Background(), "select count(*) from "+table+" where workspace_id=$1", f.profile.WorkspaceID).Scan(&count))
		result[table] = count
	}
	return result
}

func TestFixedCIProofAtomicIntegration(t *testing.T) {
	pool := fixedCIIntegrationPool(t)
	f := seedFixedCIIntegration(t, pool, false)
	f.completeSource()
	verifier, err := NewFixedCIProofVerifier(f.lifecycle.store, f.profile)
	require.NoError(t, err)
	before := f.counts()
	result, err := verifier.Record(context.Background(), f.profile.WorkspaceID, "fixed-ci-record", f.input)
	require.NoError(t, err)
	require.False(t, result.Replayed)
	after := f.counts()
	for table, count := range after {
		require.Equal(t, before[table]+1, count, table)
	}
	var producer, version, verdict, objectHash, profileHash string
	require.NoError(t, pool.QueryRow(context.Background(), `select evidence.producer_principal_id,verification.verifier_version,verification.verdict,evidence.object_hash,integration.provider_receipt->>'trustProfileSha256' from verrail_integration_runs integration join verrail_evidence evidence on evidence.id=integration.evidence_id join verrail_verification_results verification on verification.id=integration.verification_result_id where integration.id=$1`, result.ResourceID).Scan(&producer, &version, &verdict, &objectHash, &profileHash))
	require.Equal(t, fixedCIProofPrincipalID, producer)
	require.Equal(t, FixedCIProofVerifierVersion, version)
	require.Equal(t, "passed", verdict)
	require.Equal(t, strings.Repeat("7", 64), objectHash)
	require.Equal(t, f.profile.SHA256(), profileHash)
	replay, err := verifier.Record(context.Background(), f.profile.WorkspaceID, "fixed-ci-record", f.input)
	require.NoError(t, err)
	require.True(t, replay.Replayed)
	require.Equal(t, result.ResourceID, replay.ResourceID)
	require.Equal(t, after, f.counts())
	replay, err = verifier.Record(context.Background(), f.profile.WorkspaceID, "fixed-ci-fresh-key", f.input)
	require.NoError(t, err)
	require.True(t, replay.Replayed)
	require.Equal(t, result.ResourceID, replay.ResourceID)
	counts := f.counts()
	require.Equal(t, after["verrail_criterion_proofs"], counts["verrail_criterion_proofs"])
	_, err = pool.Exec(context.Background(), `update tool_connections set enabled=false where id=$1`, f.profile.ConnectionID)
	require.NoError(t, err)
	_, err = verifier.Record(context.Background(), f.profile.WorkspaceID, "fixed-ci-record", f.input)
	requireLifecycleCode(t, err, "FIXED_CI_PROOF_CONTEXT_MISMATCH")
	require.Equal(t, counts, f.counts(), "connection revocation must precede historical replay")
}

func TestFixedCIProofBridgeSeed(t *testing.T) {
	filename := os.Getenv("VERRAIL_TEST_FIXED_CI_SEED_PATH")
	if filename == "" {
		return
	}
	pool := fixedCIIntegrationPool(t)
	f := seedFixedCIIntegration(t, pool, true)
	raw, err := json.MarshalIndent(map[string]any{"workspaceId": f.profile.WorkspaceID, "targetId": f.profile.TargetID, "targetRevisionId": f.profile.TargetRevisionID, "graphRevisionId": f.profile.GraphRevisionID, "claimId": f.input.ClaimID, "criterionKey": f.input.CriterionKey, "workNodeId": f.input.WorkNodeID, "sourceWorkNodeId": f.sourceNodeID, "connectionId": f.profile.ConnectionID, "bindingId": f.profile.BindingID, "repository": f.profile.Repository, "initiatorId": f.principalID, "requirementId": f.input.RequirementID, "identity": f.identity, "eventInput": f.event.Input}, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filename, append(raw, '\n'), 0600))
}

// Opt-in interoperability test: TypeScript owns the temporary database and
// creates a real native output receipt; only this verifier writes CI authority.
func TestFixedCIProofBridgeRecord(t *testing.T) {
	filename := os.Getenv("VERRAIL_TEST_FIXED_CI_RECORD_INPUT")
	if filename == "" {
		t.Skip("TypeScript bridge fixture is not configured")
	}
	pool := fixedCIIntegrationPool(t)
	raw, err := os.ReadFile(filename)
	require.NoError(t, err)
	var fixture struct {
		TrustProfile   FixedCIProofTrustProfile `json:"trustProfile"`
		Input          FixedCIProofInput        `json:"input"`
		IdempotencyKey string                   `json:"idempotencyKey"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	verifier, err := NewFixedCIProofVerifier(NewStore(pool), fixture.TrustProfile)
	require.NoError(t, err)
	result, err := verifier.Record(context.Background(), fixture.TrustProfile.WorkspaceID, fixture.IdempotencyKey, fixture.Input)
	require.NoError(t, err)
	require.False(t, result.Replayed)
	replay, err := verifier.Record(context.Background(), fixture.TrustProfile.WorkspaceID, fixture.IdempotencyKey, fixture.Input)
	require.NoError(t, err)
	require.True(t, replay.Replayed)
	require.Equal(t, result.ResourceID, replay.ResourceID)
	var proofID, verificationID string
	require.NoError(t, pool.QueryRow(context.Background(), `select id,verification_result_id from verrail_criterion_proofs where workspace_id=$1 and integration_run_id=$2`, fixture.TrustProfile.WorkspaceID, result.ResourceID).Scan(&proofID, &verificationID))
	raw, err = json.Marshal(map[string]string{"integrationId": result.ResourceID, "fixedCiProofId": proofID, "verificationId": verificationID})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(os.Getenv("VERRAIL_TEST_FIXED_CI_RECORD_OUTPUT"), raw, 0600))
}

func (f *fixedCIIntegrationFixture) snapshot() map[string]string {
	return proofAdmissionSnapshot(f.t, &connectorTestHarness{assuranceTestHarness: &assuranceTestHarness{pool: f.pool, workspaceID: f.profile.WorkspaceID}})
}

func TestFixedCIProofDenialIntegration(t *testing.T) {
	pool := fixedCIIntegrationPool(t)
	inputCases := map[string]func(*FixedCIProofInput){
		"target":           func(i *FixedCIProofInput) { i.TargetID = mustNewUUID(t) },
		"revision":         func(i *FixedCIProofInput) { i.TargetRevisionID = mustNewUUID(t) },
		"graph":            func(i *FixedCIProofInput) { i.GraphRevisionID = mustNewUUID(t) },
		"claim":            func(i *FixedCIProofInput) { i.ClaimID = mustNewUUID(t) },
		"integration node": func(i *FixedCIProofInput) { i.WorkNodeID = mustNewUUID(t) },
		"criterion":        func(i *FixedCIProofInput) { i.CriterionKey = "unknown" },
		"requirement":      func(i *FixedCIProofInput) { i.RequirementID = "unknown" },
		"artifact":         func(i *FixedCIProofInput) { i.ArtifactRevisionID = mustNewUUID(t) },
		"run":              func(i *FixedCIProofInput) { i.Source.RunID = mustNewUUID(t) },
		"attempt":          func(i *FixedCIProofInput) { i.Source.RunAttemptID = mustNewUUID(t) },
		"event":            func(i *FixedCIProofInput) { i.Source.RunEventID = mustNewUUID(t) },
		"event hash":       func(i *FixedCIProofInput) { i.Source.RunEventContentHash = strings.Repeat("0", 64) },
		"receipt hash":     func(i *FixedCIProofInput) { i.Source.OutputReceiptSHA256 = strings.Repeat("0", 64) },
		"ordinal":          func(i *FixedCIProofInput) { i.Source.ArtifactOrdinal = 1 },
		"tree":             func(i *FixedCIProofInput) { i.Mapping.SourceSnapshotTreeSHA = strings.Repeat("0", 40) },
		"source digest":    func(i *FixedCIProofInput) { i.Mapping.SourceContentSHA256 = strings.Repeat("0", 64) },
		"mapping version":  func(i *FixedCIProofInput) { i.Mapping.Version = 2 },
		"tested commit":    func(i *FixedCIProofInput) { i.CI.TestedCommit = strings.Repeat("0", 40) },
		"expired": func(i *FixedCIProofInput) {
			i.CI.VerifiedAt = time.Now().Add(-48 * time.Hour).UTC().Format(time.RFC3339Nano)
		},
		"future":            func(i *FixedCIProofInput) { i.CI.VerifiedAt = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano) },
		"provider attempt":  func(i *FixedCIProofInput) { i.CI.ProviderAttempt = 0 },
		"provider identity": func(i *FixedCIProofInput) { i.CI.ProviderRunID = "01" },
	}
	f := seedFixedCIIntegration(t, pool, false)
	f.completeSource()
	verifier, err := NewFixedCIProofVerifier(f.lifecycle.store, f.profile)
	require.NoError(t, err)
	for name, mutate := range inputCases {
		t.Run(name, func(t *testing.T) {
			input := f.input
			mutate(&input)
			before := f.snapshot()
			_, err := verifier.Record(context.Background(), f.profile.WorkspaceID, "fixed-ci-denial", input)
			require.Error(t, err)
			require.Equal(t, before, f.snapshot())
		})
	}
	for name, statement := range map[string]string{
		"legacy contract":               `update verrail_target_revisions set acceptance_criteria=jsonb_set(acceptance_criteria,'{0}',(acceptance_criteria->0)-'proofContract') where workspace_id=$1 and id=$2`,
		"unsupported assertion":         `update verrail_target_revisions set acceptance_criteria=jsonb_set(acceptance_criteria,'{0,proofContract,allOf,0,assertions}','["ts_tests","live_codex"]') where workspace_id=$1 and id=$2`,
		"post effect":                   `update verrail_target_revisions set acceptance_criteria=jsonb_set(acceptance_criteria,'{0,proofContract,allOf,0,phase}','"post_effect"') where workspace_id=$1 and id=$2`,
		"canceled target":               `update verrail_targets set status='canceled' where workspace_id=$1`,
		"inactive graph":                `update verrail_work_graphs set active_graph_revision_id=null where workspace_id=$1`,
		"disabled connection":           `update tool_connections set enabled=false where company_id=$1`,
		"wrong repository":              `update verrail_github_repo_bindings set repo_name='other' where workspace_id=$1`,
		"user source pointer":           `update verrail_artifact_revisions set created_by_principal_type='user' where workspace_id=$1`,
		"revision copy":                 `update verrail_artifact_revisions set revision_number=2 where workspace_id=$1`,
		"missing audit":                 `delete from verrail_audit_events where workspace_id=$1 and event_type='assurance.artifact_revision_added.v1'`,
		"source node state":             `update verrail_work_nodes set status='ready' where workspace_id=$1 and kind='agent_task'`,
		"run kind":                      `update verrail_runs set kind='integration' where workspace_id=$1`,
		"attempt count":                 `update verrail_runs set attempt_count=2 where workspace_id=$1`,
		"event fence":                   `update verrail_run_events set fencing_token=2 where workspace_id=$1 and event_type='succeeded'`,
		"ordinary file":                 `update verrail_run_events set payload=jsonb_set(payload,'{outputReceipt,artifacts,0,type}','"file"') where workspace_id=$1 and event_type='succeeded'`,
		"v1 receipt":                    `update verrail_run_events set payload=jsonb_set(payload,'{outputReceipt,schemaVersion}','1') where workspace_id=$1 and event_type='succeeded'`,
		"wrong scope":                   `update verrail_run_events set payload=jsonb_set(payload,'{outputReceipt,artifacts,0,sourceSnapshot,scopeVersion}','1') where workspace_id=$1 and event_type='succeeded'`,
		"wrong path":                    `update verrail_run_events set payload=jsonb_set(payload,'{outputReceipt,artifacts,0,path}','"copied.bundle"') where workspace_id=$1 and event_type='succeeded'`,
		"missing top facts":             `update verrail_run_events set payload=payload-'heartbeatStatus' where workspace_id=$1 and event_type='succeeded'`,
		"mismatched source observation": `update verrail_run_events set payload=jsonb_set(payload,'{sourceObservation,status}','"unavailable"') where workspace_id=$1 and event_type='succeeded'`,
	} {
		t.Run(name, func(t *testing.T) {
			fixture := seedFixedCIIntegration(t, pool, false)
			fixture.completeSource()
			verifier, err := NewFixedCIProofVerifier(fixture.lifecycle.store, fixture.profile)
			require.NoError(t, err)
			args := []any{fixture.profile.WorkspaceID}
			if strings.Contains(statement, "$2") {
				args = append(args, fixture.profile.TargetRevisionID)
			}
			_, err = pool.Exec(context.Background(), statement, args...)
			require.NoError(t, err)
			before := fixture.snapshot()
			_, err = verifier.Record(context.Background(), fixture.profile.WorkspaceID, "fixed-ci-denial", fixture.input)
			require.Error(t, err)
			require.Equal(t, before, fixture.snapshot())
		})
	}
}

func TestFixedCIProofReplayRollbackAndRaceIntegration(t *testing.T) {
	pool := fixedCIIntegrationPool(t)
	f := seedFixedCIIntegration(t, pool, false)
	f.completeSource()
	verifier, err := NewFixedCIProofVerifier(f.lifecycle.store, f.profile)
	require.NoError(t, err)
	ctx := context.Background()
	var group sync.WaitGroup
	errors := make(chan error, 2)
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := verifier.Record(ctx, f.profile.WorkspaceID, "fixed-ci-race", f.input)
			errors <- err
		}()
	}
	group.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			var pgError *pgconn.PgError
			require.ErrorAs(t, err, &pgError)
			require.Equal(t, "40001", pgError.Code)
		}
	}
	result, err := verifier.Record(ctx, f.profile.WorkspaceID, "fixed-ci-race", f.input)
	require.NoError(t, err)
	require.True(t, result.Replayed)
	require.EqualValues(t, 1, f.counts()["verrail_criterion_proofs"])
	for _, key := range []string{"fixed-ci-race", "fixed-ci-other-key"} {
		changed := f.input
		changed.Mapping.CommitTreeSHA = strings.Repeat("9", 40)
		before := f.snapshot()
		_, err := verifier.Record(ctx, f.profile.WorkspaceID, key, changed)
		require.Error(t, err)
		require.Equal(t, before, f.snapshot())
	}
	changed := f.input
	changed.CI.ProviderAttempt = 2
	_, err = pool.Exec(ctx, `update verrail_integration_attempts set idempotency_key='fixed-ci-rollback' where integration_run_id=$1`, result.ResourceID)
	require.NoError(t, err)
	before := f.snapshot()
	_, err = verifier.Record(ctx, f.profile.WorkspaceID, "fixed-ci-rollback", changed)
	require.ErrorContains(t, err, "insert IntegrationAttempt")
	require.Equal(t, before, f.snapshot(), "late failure must roll back the entire real dedicated proof writer")
	_, err = pool.Exec(ctx, `update verrail_work_graphs set active_graph_revision_id=null where workspace_id=$1`, f.profile.WorkspaceID)
	require.NoError(t, err)
	before = f.snapshot()
	_, err = verifier.Record(ctx, f.profile.WorkspaceID, "fixed-ci-race", f.input)
	requireLifecycleCode(t, err, "FIXED_CI_PROOF_CONTEXT_MISMATCH")
	require.Equal(t, before, f.snapshot())
}
