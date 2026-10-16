package target

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

var recoveryIntegrationAssertions = []string{
	"OpenCode 仓库执行绑定 AgentVersion、DeploymentRevision、Run/Attempt、实际运行时、环境、日志、用量、成本状态与权限，并产生内容寻址工件",
	"固定提交通过独立 CI 并形成 Evidence 与 VerificationResult",
	"同一候选的仓库执行器在已清理运行时且结果持久化后发生可验证进程中断与重启，并在同一 Run/Attempt 恢复登记，不重跑模型或重复创建工件",
	"真实旧 Attempt 的固定延迟事件被 fencing 拒绝，重复恢复调用保持业务状态不变，并保留独立签名的实际请求、响应与清理记录",
}

// Real domain attempts, stale-fence rejection, PostgreSQL admission and replay.
// Runtime/provider/process/archive facts are synthetic, not recovery acceptance.
func seedRecoveryIntegration(t *testing.T, pool *pgxpool.Pool) (*fixedCIIntegrationFixture, repositoryCIOutput, string, string) {
	t.Helper()
	ctx := context.Background()
	f := seedProofIntegration(t, pool, false, recoveryIntegrationAssertions)
	t.Cleanup(func() {
		for _, table := range []string{"verrail_repository_dispatches", "verrail_run_sources"} {
			_, err := pool.Exec(ctx, "delete from "+table+" where workspace_id=$1", f.profile.WorkspaceID)
			require.NoError(t, err)
		}
	})
	oldAttempt, oldLease := f.input.Source.RunAttemptID, f.event.Input.LeaseID
	for _, table := range []string{"verrail_run_attempts", "verrail_execution_leases"} {
		_, err := pool.Exec(ctx, "update "+table+" set runtime_profile='repository_sandbox',executor_principal_id=$2 where workspace_id=$1", f.profile.WorkspaceID, fixedCIRepositoryExecutor)
		require.NoError(t, err)
	}
	progress := f.event
	progress.Principal.ID = fixedCIRepositoryExecutor
	progress.IdempotencyKey, progress.Input.EventType = "recovery-old-progress", "progress"
	progress.Input.Payload = map[string]any{"fraction": 0.125, "Z": true, "a": "mixed", "中": map[string]any{"created_at": "literal-not-a-date"}}
	require.NoError(t, ValidateReportRunEventCommand(&progress))
	accepted, err := f.lifecycle.store.ReportRunEvent(ctx, progress)
	require.NoError(t, err)
	require.True(t, accepted.Authoritative)
	_, err = pool.Exec(ctx, `update verrail_execution_leases set expires_at=now()-interval '2 seconds',grace_expires_at=now()-interval '1 second' where id=$1`, oldLease)
	require.NoError(t, err)
	command := buildRunAttemptCommand(t, f.profile.WorkspaceID, f.input.Source.RunID, Principal{Type: "service", ID: "verrail-orchestration-worker"}, "recovery-next-attempt")
	command.Input.RuntimeProfile = "repository_sandbox"
	command.Input.Executor.PrincipalID = fixedCIRepositoryExecutor
	command.Input.LeaseDurationSeconds = 600
	require.NoError(t, ValidateCreateRunAttemptCommand(&command))
	next, err := f.lifecycle.store.CreateRunAttempt(ctx, command)
	require.NoError(t, err)
	require.Equal(t, 2, next.AttemptNumber)
	f.input.Source.RunAttemptID = next.RunAttemptID
	f.event.RunAttemptID = next.RunAttemptID
	f.event.Principal.ID = fixedCIRepositoryExecutor
	f.event.Input.LeaseID, f.event.Input.FencingToken = next.LeaseID, next.FencingToken
	for index, kind := range []string{"claimed", "started"} {
		event := f.event
		event.IdempotencyKey = "recovery-current-" + kind
		event.Input.Cursor, event.Input.EventType = int64(index+1), kind
		require.NoError(t, ValidateReportRunEventCommand(&event))
		result, err := f.lifecycle.store.ReportRunEvent(ctx, event)
		require.NoError(t, err)
		require.True(t, result.Authoritative)
	}
	facts, _, receipt := repositoryCIFixture(t)
	facts.Identity = repositoryCIIdentity{WorkspaceID: f.profile.WorkspaceID, TargetID: f.profile.TargetID,
		TargetRevisionID: f.profile.TargetRevisionID, GraphRevisionID: f.profile.GraphRevisionID,
		WorkNodeID: f.sourceNodeID, RunID: f.input.Source.RunID, RunAttemptID: next.RunAttemptID,
		LeaseID: next.LeaseID, FencingToken: int64(next.FencingToken), AgentVersionID: f.identity["agentVersionId"].(string),
		DeploymentRevisionID: f.identity["deploymentRevisionId"].(string)}
	facts.ContentRef = "storage:" + f.profile.WorkspaceID + "/verrail/run-artifacts/sha256/" + facts.ContentHash
	receipt.Identity = facts.Identity
	receipt.Artifacts[0].ContentRef = facts.ContentRef
	receipt.Artifacts[0].SourceSnapshot.SourceContentSHA256 = f.input.Mapping.SourceContentSHA256
	receipt.Artifacts[0].SourceSnapshot.SnapshotTree = f.input.Mapping.SourceSnapshotTreeSHA
	receipt.SourceBefore.Manifest.ContentSHA256 = f.input.Mapping.SourceContentSHA256
	receipt.SourceAfter.Manifest.ContentSHA256 = f.input.Mapping.SourceContentSHA256
	receipt.Artifacts = append(receipt.Artifacts, repositoryCIArtifact{Ordinal: 1, Path: "summary.txt", Type: "file", Kind: "report", Title: "Second output",
		Bytes: 32, ContentHash: strings.Repeat("9", 64), ContentRef: "storage:" + f.profile.WorkspaceID + "/verrail/run-artifacts/sha256/" + strings.Repeat("9", 64)})
	receipt.ExecutionObservation = &repositoryCIExecutionObservation{ContentHash: strings.Repeat("1", 64), Bytes: 100,
		ContentRef: "storage:" + f.profile.WorkspaceID + "/verrail/repository-execution-observations/sha256/" + strings.Repeat("1", 64)}
	for _, artifact := range []struct{ id, revision, kind, hash string }{
		{receipt.InputSource.ArtifactID, mustNewUUID(t), "code_change", receipt.InputSource.ContentHash},
		{mustNewUUID(t), facts.SourceBinding.RepositorySourceRevisionID, "report", facts.SourceBinding.ProvenanceContentHash},
	} {
		_, err := pool.Exec(ctx, `insert into verrail_artifacts(id,workspace_id,target_id,kind,title,created_by_principal_type,created_by_principal_id)
			values($1,$2,$3,$4,'Synthetic recovery input','user',$5)`, artifact.id, f.profile.WorkspaceID, f.profile.TargetID, artifact.kind, f.principalID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `insert into verrail_artifact_revisions(id,workspace_id,artifact_id,revision_number,content_hash,content_ref,created_by_principal_type,created_by_principal_id)
			values($1,$2,$3,1,$4,$5,'user',$6)`, artifact.revision, f.profile.WorkspaceID, artifact.id, artifact.hash,
			"storage:"+f.profile.WorkspaceID+"/verrail/run-artifacts/sha256/"+artifact.hash, f.principalID)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `insert into verrail_run_sources(run_id,workspace_id,repository_source_revision_id) values($1,$2,$3)`, facts.Identity.RunID, f.profile.WorkspaceID, facts.SourceBinding.RepositorySourceRevisionID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `update verrail_agent_versions set runtime='opencode',model=$2 where id=$1`, facts.Identity.AgentVersionID, facts.Model)
	require.NoError(t, err)
	var request repositoryCIRequest
	require.NoError(t, decodeRepositoryCIJSON(facts.DispatchInput, &request))
	identityBytes, err := json.Marshal(facts.Identity)
	require.NoError(t, err)
	var input map[string]any
	require.NoError(t, json.Unmarshal(facts.DispatchInput, &input))
	var identity map[string]any
	require.NoError(t, json.Unmarshal(identityBytes, &identity))
	for key, value := range identity {
		input[key] = value
	}
	facts.DispatchInput, err = json.Marshal(input)
	require.NoError(t, err)
	require.NoError(t, decodeRepositoryCIJSON(facts.DispatchInput, &request))
	facts.RequestHash, err = repositoryCIRequestHash(request)
	require.NoError(t, err)
	receipt.RequestSHA256, receipt.ExecutionFacts.RequestSHA256 = facts.RequestHash, facts.RequestHash
	repositoryCIProject(t, &facts, &f.input, receipt)
	var output repositoryCIOutput
	require.NoError(t, decodeRepositoryCIJSON(facts.DispatchResult, &output))
	_, err = pool.Exec(ctx, `insert into verrail_repository_dispatches(run_attempt_id,workspace_id,run_id,lease_id,fencing_token,controller_id,request_hash,input,status,result,controller_expires_at,finished_at)
		values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'succeeded',$9::jsonb,now(),now())`, next.RunAttemptID, f.profile.WorkspaceID, facts.Identity.RunID,
		next.LeaseID, next.FencingToken, mustNewUUID(t), facts.RequestHash, facts.DispatchInput, facts.DispatchResult)
	require.NoError(t, err)
	f.event.Input.Payload = map[string]any{"repositoryOutput": output}
	f.event.Input.Artifacts = nil
	for _, artifact := range output.Artifacts {
		f.event.Input.Artifacts = append(f.event.Input.Artifacts, RunArtifactInput{Title: artifact.Title, Kind: artifact.Kind, ContentHash: artifact.ContentHash, ContentRef: artifact.ContentRef})
	}
	require.NoError(t, ValidateReportRunEventCommand(&f.event))
	result, err := f.lifecycle.store.ReportRunEvent(ctx, f.event)
	require.NoError(t, err)
	require.True(t, result.Authoritative)
	require.NoError(t, pool.QueryRow(ctx, `select id,content_hash from verrail_run_events where run_attempt_id=$1 and event_type='succeeded'`, next.RunAttemptID).Scan(&f.input.Source.RunEventID, &f.input.Source.RunEventContentHash))
	require.NoError(t, pool.QueryRow(ctx, `select id from verrail_artifact_revisions where workspace_id=$1 and source_run_id=$2 and content_hash=$3`, f.profile.WorkspaceID, facts.Identity.RunID, facts.ContentHash).Scan(&f.input.ArtifactRevisionID))
	return f, output, oldAttempt, oldLease
}

func recoveryIntegrationFingerprint(t *testing.T, tx pgx.Tx, proof *repositoryRecoveryProof) {
	t.Helper()
	ctx, identity := context.Background(), proof.Identity
	for _, item := range []struct {
		table, id string
		target    *string
	}{
		{"verrail_run_attempts", proof.Probes.OldAttemptID, &proof.Probes.OldAttemptSHA256},
		{"verrail_execution_leases", proof.Probes.OldLeaseID, &proof.Probes.OldLeaseSHA256},
		{"verrail_run_attempts", identity.RunAttemptID, &proof.Probes.CurrentAttemptSHA256},
		{"verrail_execution_leases", identity.LeaseID, &proof.Probes.CurrentLeaseSHA256},
		{"verrail_runs", identity.RunID, &proof.Probes.CurrentRunSHA256},
		{"verrail_execution_command_receipts", proof.Probes.Stale.ReceiptID, &proof.Probes.Stale.ReceiptSHA256},
		{"verrail_audit_events", proof.Probes.Stale.AuditID, &proof.Probes.Stale.AuditSHA256},
	} {
		row, err := readRecoveryDatabaseRow(ctx, tx, item.table, identity.WorkspaceID, item.id)
		require.NoError(t, err)
		*item.target, err = recoveryDatabaseDigest(row)
		require.NoError(t, err)
		if item.table == "verrail_run_attempts" && item.id == identity.RunAttemptID {
			proof.After.AuthoritativeResultSHA256, err = recoveryDatabaseDigest(row["result"])
			require.NoError(t, err)
		}
	}
	for _, item := range []struct {
		attempt string
		target  *string
	}{{proof.Probes.OldAttemptID, &proof.Probes.OldEventsSHA256}, {identity.RunAttemptID, &proof.After.EventsSHA256}} {
		events, err := readRecoveryDatabaseEvents(ctx, tx, identity.WorkspaceID, identity.RunID, item.attempt)
		require.NoError(t, err)
		*item.target, err = recoveryDatabaseDigest(events)
		require.NoError(t, err)
	}
	artifacts, err := readRecoveryDatabaseArtifacts(ctx, tx, identity.WorkspaceID, identity.RunID)
	require.NoError(t, err)
	proof.After.ArtifactsSHA256, err = recoveryDatabaseDigest(artifacts)
	require.NoError(t, err)
}

func TestRepositoryRecoveryDeliveryTransactionIntegration(t *testing.T) {
	pool, ctx := fixedCIIntegrationPool(t), context.Background()
	f, output, oldAttempt, oldLease := seedRecoveryIntegration(t, pool)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	profile := DeliveryProofTrustProfile{SchemaVersion: 1, CI: f.profile, PublicKey: base64.StdEncoding.EncodeToString(public),
		ReaderPolicySHA256: strings.Repeat("1", 64), VerifierBuildSHA256: strings.Repeat("2", 64), RuntimeManifestSHA256: strings.Repeat("3", 64), MaxAgeMS: 300000}
	payload := DeliveryProofPayload{SchemaVersion: 1, Kind: "repository_recovery", ObservationID: mustNewUUID(t), IdempotencyKey: "repository-recovery-proof",
		WorkspaceID: f.profile.WorkspaceID, TrustProfileSHA256: profile.SHA256(), ReaderPolicySHA256: profile.ReaderPolicySHA256,
		VerifierBuildSHA256: profile.VerifierBuildSHA256, RuntimeManifestSHA256: profile.RuntimeManifestSHA256,
		StartedAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano), Source: f.input}
	r := output.OutputReceipt
	e, _, _ := openCodeExecutionFixture(t)
	e.repositoryCIIdentity = r.Identity
	e.RequestSHA256, e.OutputReceiptSHA256 = r.RequestSHA256, r.SHA256
	e.RunEventID, e.ExecutionObservation = f.input.Source.RunEventID, *r.ExecutionObservation
	e.ExecutionWindow.StartedAt, e.ExecutionWindow.FinishedAt = r.ExecutionFacts.StartedAt, r.ExecutionFacts.FinishedAt
	e.HealthVerifiedAt, e.SessionCreatedAt, e.SessionCompletedAt = e.ExecutionWindow.StartedAt, e.ExecutionWindow.StartedAt, e.ExecutionWindow.FinishedAt
	e.RuntimeWitness.Before.CheckedAt, e.RuntimeWitness.After.CheckedAt = e.SessionCreatedAt, e.SessionCompletedAt
	e.LogRef.ContentRef = "storage:" + e.WorkspaceID + "/verrail/repository-execution-logs/sha256/" + e.LogRef.ContentHash
	e.CandidateRuntime.ManifestSHA256, e.CandidateRuntime.HTTPSession.CreatedAt = payload.RuntimeManifestSHA256, e.SessionCreatedAt
	encodedIdentity, err := repositoryCIJSON(e.repositoryCIIdentity)
	require.NoError(t, err)
	identityHash := sha256.Sum256(encodedIdentity)
	e.CandidateRuntime.ExecutionIdentitySHA256 = hex.EncodeToString(identityHash[:])
	delivery := openCodeObservationFixture(t, e, payload, profile)
	_, vector, _ := readOpenCodeSignedVector(t, "testdata/repository-recovery-closed-proof-v1.json")
	var observation repositoryRecoveryObservation
	require.NoError(t, decodeOpenCodeJSON([]byte(vector.ObservationJSON), &observation))
	observation.Delivery = delivery
	proof := &observation.Recovery
	proof.Identity = r.Identity
	proof.CandidateSessionID, proof.RuntimeManifestSHA256 = e.CandidateRuntime.SessionID, payload.RuntimeManifestSHA256
	proof.Before.OutputReceiptSHA256, proof.Before.ExecutionObservationSHA256 = r.SHA256, r.ExecutionObservation.ContentHash
	proof.Before.ExecutionLogSHA256, proof.Before.ExecutionSessionID = e.LogRef.ContentHash, e.SessionID
	proof.Before.ArtifactCount, proof.Before.ObservedAt = len(output.Artifacts), r.FinalizedAt
	// Recovery stores the raw source digest; Delivery aggregates it with requirement state.
	proof.After.SourceContextSHA256 = strings.Repeat("b", 64)
	require.NotEqual(t, proof.After.SourceContextSHA256, delivery.SourceContextSHA256)
	proof.Probes.OldAttemptID, proof.Probes.OldLeaseID = oldAttempt, oldLease
	proof.Probes.OldAttemptNumber, proof.Probes.OldFencingToken, proof.Probes.NextCursor = 1, 1, 4
	issued := time.Now().UTC()
	challenge := mustNewUUID(t)
	stale := ReportRunEventCommand{WorkspaceID: e.WorkspaceID, RunID: e.RunID, RunAttemptID: oldAttempt,
		Principal: Principal{Type: "service", ID: fixedCIRepositoryExecutor}, IdempotencyKey: "recovery-stale:" + challenge,
		Input: ReportRunEventInput{LeaseID: oldLease, FencingToken: 1, Cursor: 4, EventType: "heartbeat", EmittedAt: issued.Truncate(time.Second)}}
	require.NoError(t, ValidateReportRunEventCommand(&stale))
	response, err := f.lifecycle.store.ReportRunEvent(ctx, stale)
	require.NoError(t, err)
	require.False(t, response.Authoritative)
	require.Equal(t, "STALE_FENCING_TOKEN", *response.RejectionCode)
	var receiptAt, auditAt time.Time
	require.NoError(t, pool.QueryRow(ctx, `select id,created_at from verrail_execution_command_receipts where workspace_id=$1 and idempotency_key=$2`, e.WorkspaceID, stale.IdempotencyKey).Scan(&proof.Probes.Stale.ReceiptID, &receiptAt))
	require.NoError(t, pool.QueryRow(ctx, `select id,occurred_at from verrail_audit_events where workspace_id=$1 and idempotency_key=$2`, e.WorkspaceID, stale.IdempotencyKey).Scan(&proof.Probes.Stale.AuditID, &auditAt))
	received := time.Now().UTC()
	stamp := func(at time.Time) string { return at.UTC().Format(time.RFC3339Nano) }
	jsStamp := func(at time.Time) string {
		return at.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
	}
	// Receipt/audit timestamps are read through Drizzle's millisecond Date boundary.
	proof.Probes.Stale.IssuedAt, proof.Probes.Stale.ReceivedAt = jsStamp(issued), stamp(received)
	proof.Probes.Stale.Challenge, proof.Probes.Stale.IdempotencyKey = challenge, stale.IdempotencyKey
	proof.Probes.Stale.RequestHash, proof.Probes.Stale.Response = stale.RequestHash, response
	proof.Probes.Stale.ReceiptCreatedAt, proof.Probes.Stale.AuditOccurredAt = jsStamp(receiptAt), jsStamp(auditAt)
	proof.Probes.Duplicate.IssuedAt, proof.Probes.Duplicate.ReceivedAt = stamp(issued.Add(-time.Second)), stamp(issued.Add(-time.Second))
	proof.Probes.BaselineSHA256 = proof.After.ContextSHA256
	var executor, native *openCodeCandidateWitness
	for index := range observation.Delivery.Runtime.Witnesses {
		witness := &observation.Delivery.Runtime.Witnesses[index]
		if witness.Component == "repository_executor" {
			executor = witness
		}
		if witness.Component == "opencode" {
			native = witness
		}
	}
	require.NotNil(t, executor)
	require.NotNil(t, native)
	boot := mustNewUUID(t)
	proof.Runtime.ObserverProcess = repositoryRecoveryProcess{BootID: boot, PID: executor.ObserverPID, PGID: executor.ObserverPID, SessionID: executor.ObserverPID, StartTicks: "100"}
	oldProcess := repositoryRecoveryProcess{BootID: boot, PID: executor.Observation.PID, PGID: executor.Observation.PID, SessionID: executor.Observation.PID, StartTicks: "101"}
	proof.ConfigurationSHA256 = executor.ConfigurationSHA256
	proof.Runtime.Old = repositoryRecoverySnapshot{Process: oldProcess, ObserverSessionID: executor.Observation.ObserverSessionID,
		CandidateCommit: payload.Source.CI.TestedCommit, ExecutableSHA256: executor.Observation.ExecutableSHA256,
		SourceManifestSHA256: *executor.Observation.SourceManifestSHA256, ObservationSHA256: executor.Observation.ObservationSHA256,
		StartedAt: executor.Observation.StartedAt, ObservedAt: proof.Before.ObservedAt}
	proof.Runtime.Next = proof.Runtime.Old
	proof.Runtime.Next.Process.PID++
	proof.Runtime.Next.Process.PGID = proof.Runtime.Next.Process.PID
	proof.Runtime.Next.Process.SessionID = proof.Runtime.Next.Process.PID
	proof.Runtime.Next.Process.StartTicks = "102"
	proof.Runtime.Next.ObserverSessionID = mustNewUUID(t)
	proof.Runtime.Next.StartedAt, proof.Runtime.Next.ObservedAt = proof.Before.ObservedAt, stamp(received)
	proof.Runtime.OldStopped = repositoryRecoveryStopped{Process: oldProcess, RequestedSignal: "SIGTERM", TermSentAt: proof.Before.ObservedAt,
		StoppedAt: proof.Before.ObservedAt, ProcessGroupGone: true, ProcessReaped: true}
	proof.Runtime.NextStopped = repositoryRecoveryStopped{Process: proof.Runtime.Next.Process, RequestedSignal: "SIGTERM", TermSentAt: stamp(received),
		StoppedAt: stamp(received), ProcessGroupGone: true, ProcessReaped: true}
	proof.Runtime.OwnedCleanup.ObserverPID, proof.Runtime.OwnedCleanup.NativePID = native.ObserverPID, native.Observation.PID
	proof.Runtime.OwnedCleanup.CheckedAt, proof.Runtime.OwnedCleanup.OutputReceiptSHA256 = stamp(received), r.SHA256
	proof.Runtime.OwnedCleanup.TerminationEnvelopeSHA256 = native.EnvelopeRef.ContentHash
	encodedRuntime, err := repositoryCIJSON(observation.Delivery.Runtime)
	require.NoError(t, err)
	runtimeHash := sha256.Sum256(encodedRuntime)
	proof.PreRuntimeProofSHA256 = hex.EncodeToString(runtimeHash[:])
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	require.NoError(t, err)
	recoveryIntegrationFingerprint(t, tx, proof)
	require.NoError(t, tx.Rollback(ctx))
	payload.VerifiedAt = stamp(time.Now().UTC())
	sign := func(value any) DeliveryProofEnvelope {
		encoded, err := json.Marshal(value)
		require.NoError(t, err)
		payload.ObservationJSON = string(encoded)
		digest := sha256.Sum256(encoded)
		payload.ObservationSHA256 = hex.EncodeToString(digest[:])
		body, err := json.Marshal(payload)
		require.NoError(t, err)
		return DeliveryProofEnvelope{SchemaVersion: 1, Payload: base64.StdEncoding.EncodeToString(body), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, append([]byte(deliveryProofSignatureDomain), body...)))}
	}
	envelope := sign(observation)
	_, err = decodeRepositoryRecoveryObservation(profile, payload)
	require.NoError(t, err, "synthetic projection must satisfy the real closed schema before DB mutation tests")
	verifier, err := NewDeliveryProofVerifier(f.lifecycle.store, profile)
	require.NoError(t, err)
	before := f.counts()
	for name, statement := range map[string]string{
		"old event payload":            `update verrail_run_events set payload=jsonb_set(payload,'{fraction}','0.25') where workspace_id=$1 and run_attempt_id=$2 and cursor=3`,
		"old lease metadata":           `update verrail_execution_leases set grace_expires_at=grace_expires_at+interval '1 millisecond' where workspace_id=$1 and id=$2`,
		"old attempt metadata":         `update verrail_run_attempts set error_message='changed after signed checkpoint' where workspace_id=$1 and id=$2`,
		"current event prefix":         `update verrail_run_events set payload=payload||'{"changed":true}' where workspace_id=$1 and run_attempt_id<>$2 and cursor=1`,
		"unselected artifact metadata": `update verrail_artifacts set updated_at=updated_at+interval '1 millisecond' where workspace_id=$1 and title='Second output'`,
		"unselected artifact audit":    `update verrail_audit_events set payload=payload||'{"changed":true}' where workspace_id=$1 and event_type='assurance.artifact_revision_added.v1' and payload->>'contentHash'=repeat('9',64)`,
		"stale receipt metadata":       `update verrail_execution_command_receipts set created_at=created_at+interval '1 millisecond' where workspace_id=$1 and idempotency_key like 'recovery-stale:%'`,
		"stale audit extra payload":    `update verrail_audit_events set payload=payload||'{"changed":true}' where workspace_id=$1 and event_type='run.event_rejected_stale_fence'`,
		"old event added":              `insert into verrail_run_events(id,workspace_id,run_id,run_attempt_id,cursor,fencing_token,event_type,payload,content_hash,emitted_at) select gen_random_uuid(),workspace_id,run_id,run_attempt_id,4,fencing_token,'heartbeat','{}',content_hash,emitted_at from verrail_run_events where workspace_id=$1 and run_attempt_id=$2 and cursor=1`,
	} {
		t.Run(name, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer func() { require.NoError(t, tx.Rollback(ctx)) }()
			// All statements use one parameter set; PostgreSQL rejects unused bind slots.
			args := []any{e.WorkspaceID}
			if strings.Contains(statement, "$2") {
				id := oldAttempt
				if name == "old lease metadata" {
					id = oldLease
				}
				args = append(args, id)
			}
			changed, err := tx.Exec(ctx, statement, args...)
			require.NoError(t, err)
			require.Positive(t, changed.RowsAffected())
			require.Error(t, validateRepositoryRecoveryDatabase(ctx, tx, profile, payload))
		})
	}
	require.Equal(t, before, f.counts())
	_, err = verifier.Record(ctx, payload.WorkspaceID, payload.IdempotencyKey, sign(map[string]any{}))
	require.Error(t, err)
	require.Equal(t, before, f.counts())
	envelope = sign(observation)
	result, err := verifier.Record(ctx, payload.WorkspaceID, payload.IdempotencyKey, envelope)
	require.NoError(t, err)
	require.False(t, result.Replayed)
	after := f.counts()
	for table, count := range after {
		delta := int64(1)
		if table == "verrail_evidence" {
			delta = 2
		}
		require.Equal(t, before[table]+delta, count, table)
	}
	replayed, err := verifier.Record(ctx, payload.WorkspaceID, payload.IdempotencyKey, envelope)
	require.NoError(t, err)
	require.True(t, replayed.Replayed)
	require.Equal(t, result.ResourceID, replayed.ResourceID)
	require.Equal(t, after, f.counts())
	_, err = pool.Exec(ctx, `update verrail_run_events set payload=jsonb_set(payload,'{fraction}','0.25') where workspace_id=$1 and run_attempt_id=$2 and cursor=3`, e.WorkspaceID, oldAttempt)
	require.NoError(t, err)
	_, err = verifier.Record(ctx, payload.WorkspaceID, payload.IdempotencyKey, envelope)
	require.Error(t, err, "replay must reject signed old-event drift, not return historical authority")
	require.Equal(t, after, f.counts())
	_, err = pool.Exec(ctx, `update verrail_run_events set payload=jsonb_set(payload,'{fraction}','0.125') where workspace_id=$1 and run_attempt_id=$2 and cursor=3`, e.WorkspaceID, oldAttempt)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `update verrail_artifacts set updated_at=updated_at+interval '1 millisecond' where workspace_id=$1 and title='Second output'`, e.WorkspaceID)
	require.NoError(t, err)
	_, err = verifier.Record(ctx, payload.WorkspaceID, payload.IdempotencyKey, envelope)
	require.Error(t, err, "replay must reject metadata drift on every output, not only the selected source snapshot")
	require.Equal(t, after, f.counts())
}
