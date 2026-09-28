package target

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Real domain commands and transactions; signed observations are synthetic here.
func TestDeliveryProofTransaction(t *testing.T) {
	pool := fixedCIIntegrationPool(t)
	for kind, assertions := range map[string][]string{
		"feishu_target":   {"真实飞书消息经明确确认创建版本化 Target，并返回可追踪回复", "保留 callback、事件、会话和回复的脱敏 Provider 标识"},
		"codex_execution": {"Codex 执行绑定版本、运行、环境、日志、成本与权限，并产生内容寻址工件", "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult"},
	} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			f := seedProofIntegration(t, pool, false, assertions)
			f.completeSource()
			public, private, err := ed25519.GenerateKey(rand.Reader)
			require.NoError(t, err)
			profile := DeliveryProofTrustProfile{SchemaVersion: 1, CI: f.profile, PublicKey: base64.StdEncoding.EncodeToString(public),
				ReaderPolicySHA256: strings.Repeat("1", 64), VerifierBuildSHA256: strings.Repeat("2", 64), RuntimeManifestSHA256: strings.Repeat("3", 64), MaxAgeMS: 300000}
			verifier, err := NewDeliveryProofVerifier(f.lifecycle.store, profile)
			require.NoError(t, err)
			payload := DeliveryProofPayload{SchemaVersion: 1, Kind: kind, ObservationID: mustNewUUID(t), IdempotencyKey: "closed-proof-key", WorkspaceID: profile.CI.WorkspaceID,
				TrustProfileSHA256: profile.SHA256(), ReaderPolicySHA256: profile.ReaderPolicySHA256, VerifierBuildSHA256: profile.VerifierBuildSHA256,
				RuntimeManifestSHA256: profile.RuntimeManifestSHA256, StartedAt: time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano),
				VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano), Source: f.input, ObservationJSON: "{}", ObservationSHA256: proofHash(map[string]any{})}
			sign := func(value DeliveryProofPayload) DeliveryProofEnvelope {
				raw, err := json.Marshal(value)
				require.NoError(t, err)
				return DeliveryProofEnvelope{SchemaVersion: 1, Payload: base64.StdEncoding.EncodeToString(raw),
					Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, append([]byte(deliveryProofSignatureDomain), raw...)))}
			}
			before := f.counts()
			bad := payload
			bad.Source.TargetRevisionID = mustNewUUID(t)
			_, err = verifier.Record(ctx, profile.CI.WorkspaceID, payload.IdempotencyKey, sign(bad))
			require.Error(t, err)
			_, err = verifier.Record(ctx, mustNewUUID(t), payload.IdempotencyKey, sign(payload))
			require.Error(t, err)
			require.Equal(t, before, f.counts(), "refused commands do not write proof or receipt rows")
			result, err := verifier.Record(ctx, profile.CI.WorkspaceID, payload.IdempotencyKey, sign(payload))
			require.NoError(t, err)
			var provider, evidenceKind, verdict string
			require.NoError(t, pool.QueryRow(ctx, `select run.provider,evidence.kind,result.verdict from verrail_integration_runs run
				join verrail_evidence evidence on evidence.id=run.evidence_id join verrail_verification_results result on result.id=run.verification_result_id
				join verrail_criterion_proofs proof on proof.integration_run_id=run.id where run.id=$1`, result.ResourceID).Scan(&provider, &evidenceKind, &verdict))
			require.Equal(t, "verrail", provider)
			require.Equal(t, "scan_result", evidenceKind)
			require.Equal(t, "passed", verdict)
			after := f.counts()
			replay, err := verifier.Record(ctx, profile.CI.WorkspaceID, payload.IdempotencyKey, sign(payload))
			require.NoError(t, err)
			require.True(t, replay.Replayed)
			require.Equal(t, result.ResourceID, replay.ResourceID)
			require.Equal(t, after, f.counts())
			bad = payload
			bad.ObservationSHA256 = strings.Repeat("5", 64)
			_, err = verifier.Record(ctx, profile.CI.WorkspaceID, payload.IdempotencyKey, sign(bad))
			require.Error(t, err)
			require.Equal(t, after, f.counts())
		})
	}
}
