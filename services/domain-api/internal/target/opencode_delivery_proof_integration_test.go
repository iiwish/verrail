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

	"github.com/stretchr/testify/require"
)

// Real PostgreSQL authority/rollback/replay; all runtime and provider facts are
// synthetic. This test is not a real OpenCode or release acceptance witness.
func TestRepositoryCIOpenCodeDeliveryTransactionIntegration(t *testing.T) {
	pool := fixedCIIntegrationPool(t)
	assertions := []string{"OpenCode 仓库执行绑定 AgentVersion、DeploymentRevision、Run/Attempt、实际运行时、环境、日志、用量、成本状态与权限，并产生内容寻址工件", "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult"}
	f := seedRepositoryCIIntegrationWithReceipt(t, pool, assertions, func(facts *repositoryCISourceProjection, r *repositoryCIOutputReceipt) {
		r.ExecutionObservation = &repositoryCIExecutionObservation{ContentHash: strings.Repeat("1", 64), Bytes: 100,
			ContentRef: "storage:" + facts.Identity.WorkspaceID + "/verrail/repository-execution-observations/sha256/" + strings.Repeat("1", 64)}
	})
	ctx := context.Background()
	var raw []byte
	require.NoError(t, pool.QueryRow(ctx, `select result from verrail_repository_dispatches where run_attempt_id=$1`, f.input.Source.RunAttemptID).Scan(&raw))
	var output repositoryCIOutput
	require.NoError(t, decodeRepositoryCIJSON(raw, &output))
	r := output.OutputReceipt
	public, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	profile := DeliveryProofTrustProfile{SchemaVersion: 1, CI: f.profile, PublicKey: base64.StdEncoding.EncodeToString(public),
		ReaderPolicySHA256: strings.Repeat("1", 64), VerifierBuildSHA256: strings.Repeat("2", 64), RuntimeManifestSHA256: strings.Repeat("3", 64), MaxAgeMS: 300000}
	p := DeliveryProofPayload{SchemaVersion: 1, Kind: "opencode_execution", ObservationID: mustNewUUID(t), IdempotencyKey: "opencode-proof-key",
		WorkspaceID: f.profile.WorkspaceID, TrustProfileSHA256: profile.SHA256(), ReaderPolicySHA256: profile.ReaderPolicySHA256,
		VerifierBuildSHA256: profile.VerifierBuildSHA256, RuntimeManifestSHA256: profile.RuntimeManifestSHA256,
		StartedAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano), Source: f.input}
	e, _, _ := openCodeExecutionFixture(t)
	e.repositoryCIIdentity = r.Identity
	e.RequestSHA256 = r.RequestSHA256
	e.OutputReceiptSHA256 = r.SHA256
	e.RunEventID = f.input.Source.RunEventID
	e.ExecutionObservation = *r.ExecutionObservation
	e.ExecutionWindow.StartedAt = r.ExecutionFacts.StartedAt
	e.ExecutionWindow.FinishedAt = r.ExecutionFacts.FinishedAt
	e.HealthVerifiedAt = e.ExecutionWindow.StartedAt
	e.SessionCreatedAt = e.ExecutionWindow.StartedAt
	e.SessionCompletedAt = e.ExecutionWindow.FinishedAt
	e.RuntimeWitness.Before.CheckedAt = e.SessionCreatedAt
	e.RuntimeWitness.After.CheckedAt = e.SessionCompletedAt
	e.LogRef.ContentRef = "storage:" + e.WorkspaceID + "/verrail/repository-execution-logs/sha256/" + e.LogRef.ContentHash
	e.CandidateRuntime.ManifestSHA256 = p.RuntimeManifestSHA256
	e.CandidateRuntime.HTTPSession.CreatedAt = e.SessionCreatedAt
	identity, err := repositoryCIJSON(e.repositoryCIIdentity)
	require.NoError(t, err)
	identityHash := sha256.Sum256(identity)
	e.CandidateRuntime.ExecutionIdentitySHA256 = hex.EncodeToString(identityHash[:])
	o := openCodeObservationFixture(t, e, p, profile)
	verifier, err := NewDeliveryProofVerifier(f.lifecycle.store, profile)
	require.NoError(t, err)
	sign := func(observation any) DeliveryProofEnvelope {
		encoded, err := json.Marshal(observation)
		require.NoError(t, err)
		p.ObservationJSON = string(encoded)
		digest := sha256.Sum256(encoded)
		p.ObservationSHA256 = hex.EncodeToString(digest[:])
		body, err := json.Marshal(p)
		require.NoError(t, err)
		return DeliveryProofEnvelope{SchemaVersion: 1, Payload: base64.StdEncoding.EncodeToString(body), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, append([]byte(deliveryProofSignatureDomain), body...)))}
	}
	before := f.counts()
	_, err = verifier.Record(ctx, p.WorkspaceID, p.IdempotencyKey, sign(map[string]any{}))
	require.Error(t, err)
	require.Equal(t, before, f.counts())
	for name, mutate := range map[string]func(*openCodeDeliveryObservation){
		"dispatch request hash":   func(o *openCodeDeliveryObservation) { o.Execution.RequestSHA256 = strings.Repeat("0", 64) },
		"stored observation":      func(o *openCodeDeliveryObservation) { o.Execution.ExecutionObservation.Bytes++ },
		"foreign run event":       func(o *openCodeDeliveryObservation) { o.Execution.RunEventID = mustNewUUID(t) },
		"version identity":        func(o *openCodeDeliveryObservation) { o.Execution.AgentVersionID = mustNewUUID(t) },
		"missing permission deny": func(o *openCodeDeliveryObservation) { o.Execution.RuntimeWitness.Before.Permissions.Default = "allow" },
		"partial usage":           func(o *openCodeDeliveryObservation) { o.Execution.UsageStatus = "unavailable" },
		"uncertain cleanup":       func(o *openCodeDeliveryObservation) { o.Execution.Cleanup.Commands = false },
		"missing runtime":         func(o *openCodeDeliveryObservation) { o.Runtime.Witnesses = nil },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := o
			mutate(&candidate)
			_, err := verifier.Record(ctx, p.WorkspaceID, p.IdempotencyKey, sign(candidate))
			require.Error(t, err)
			require.Equal(t, before, f.counts(), "denial must not mint authority or idempotency receipt")
		})
	}
	envelope := sign(o)
	result, err := verifier.Record(ctx, p.WorkspaceID, p.IdempotencyKey, envelope)
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
	var evidenceKinds []string
	require.NoError(t, pool.QueryRow(ctx, `select array_agg(evidence.kind order by evidence.kind) from verrail_integration_runs run
		join verrail_verification_results verification on verification.id=run.verification_result_id
		join verrail_evidence evidence on evidence.id=any(verification.evidence_ids)
		where run.id=$1 and evidence.producer_principal_id=$2 and evidence.trust_level='high'`, result.ResourceID, deliveryProofPrincipalID).Scan(&evidenceKinds))
	require.Equal(t, []string{"ci_result", "scan_result"}, evidenceKinds)
	replayed, err := verifier.Record(ctx, p.WorkspaceID, p.IdempotencyKey, envelope)
	require.NoError(t, err)
	require.True(t, replayed.Replayed)
	require.Equal(t, result.ResourceID, replayed.ResourceID)
	require.Equal(t, after, f.counts())
	_, err = pool.Exec(ctx, `update verrail_repository_dispatches set input=jsonb_set(input,'{instructions}','"changed after proof"') where run_attempt_id=$1`, f.input.Source.RunAttemptID)
	require.NoError(t, err)
	_, err = verifier.Record(ctx, p.WorkspaceID, p.IdempotencyKey, envelope)
	require.Error(t, err)
	require.Equal(t, after, f.counts(), "replay must recheck current source and execution bindings")
}
