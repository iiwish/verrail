package target

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestDeliveryProofEnvelopeAuthenticatesExactBytesAndScope(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	profile := DeliveryProofTrustProfile{SchemaVersion: 1, CI: fixedCIProfileFixture(),
		PublicKey: base64.StdEncoding.EncodeToString(public), ReaderPolicySHA256: strings.Repeat("1", 64),
		VerifierBuildSHA256: strings.Repeat("2", 64), RuntimeManifestSHA256: strings.Repeat("3", 64), MaxAgeMS: 300000}
	input := DeliveryProofPayload{SchemaVersion: 1, Kind: "codex_execution", ObservationID: mustNewUUID(t),
		IdempotencyKey: "delivery-test-key",
		WorkspaceID:    profile.CI.WorkspaceID, TrustProfileSHA256: profile.SHA256(),
		ReaderPolicySHA256: profile.ReaderPolicySHA256, VerifierBuildSHA256: profile.VerifierBuildSHA256,
		RuntimeManifestSHA256: profile.RuntimeManifestSHA256,
		StartedAt:             time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Source: fixedCIInputFixture(t, profile.CI), ObservationJSON: "{}", ObservationSHA256: proofHash(map[string]any{})}
	sign := func(payload DeliveryProofPayload) DeliveryProofEnvelope {
		raw, err := json.Marshal(payload)
		require.NoError(t, err)
		return DeliveryProofEnvelope{SchemaVersion: 1, Payload: base64.StdEncoding.EncodeToString(raw),
			Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, append([]byte(deliveryProofSignatureDomain), raw...)))}
	}
	envelope := sign(input)
	decoded, err := verifyDeliveryProofEnvelope(profile, profile.CI.WorkspaceID, "delivery-test-key", envelope)
	require.NoError(t, err)
	require.Equal(t, input, decoded)
	for _, change := range []string{"scope", "target", "kind", "profile", "reader", "build", "runtime", "future", "expired", "reversed", "digest"} {
		t.Run(change, func(t *testing.T) {
			candidate := input
			switch change {
			case "scope":
				candidate.WorkspaceID = mustNewUUID(t)
			case "target":
				candidate.Source.TargetID = mustNewUUID(t)
			case "kind":
				candidate.Kind = "ts_tests"
			case "profile":
				candidate.TrustProfileSHA256 = strings.Repeat("0", 64)
			case "reader":
				candidate.ReaderPolicySHA256 = strings.Repeat("0", 64)
			case "build":
				candidate.VerifierBuildSHA256 = strings.Repeat("0", 64)
			case "runtime":
				candidate.RuntimeManifestSHA256 = strings.Repeat("0", 64)
			case "future":
				candidate.VerifiedAt = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
			case "expired":
				candidate.StartedAt = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
			case "reversed":
				candidate.StartedAt = time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano)
			case "digest":
				candidate.ObservationSHA256 = ""
			}
			_, err := verifyDeliveryProofEnvelope(profile, profile.CI.WorkspaceID, "delivery-test-key", sign(candidate))
			require.Error(t, err)
		})
	}
	for _, mutate := range []func(*DeliveryProofEnvelope){
		func(e *DeliveryProofEnvelope) { e.Payload += "\n" },
		func(e *DeliveryProofEnvelope) { e.Signature = base64.StdEncoding.EncodeToString(make([]byte, 64)) },
		func(e *DeliveryProofEnvelope) { e.SchemaVersion = 2 },
		func(e *DeliveryProofEnvelope) { e.Payload = strings.Repeat("a", 100000) },
	} {
		changed := envelope
		mutate(&changed)
		_, err := verifyDeliveryProofEnvelope(profile, profile.CI.WorkspaceID, "delivery-test-key", changed)
		require.Error(t, err)
	}
	_, other, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	raw, err := base64.StdEncoding.DecodeString(envelope.Payload)
	require.NoError(t, err)
	envelope.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(other, append([]byte(deliveryProofSignatureDomain), raw...)))
	_, err = verifyDeliveryProofEnvelope(profile, profile.CI.WorkspaceID, "delivery-test-key", envelope)
	require.Error(t, err)
}

func TestDeliveryProofWireRejectsCallerAssertionsAndDuplicateFields(t *testing.T) {
	for _, raw := range []string{`{}`, `null`, `{"schemaVersion":1,"payload":"a","signature":"b","passed":true}`,
		`{"schemaVersion":1,"payload":"a","signature":"b","schemaVersion":1}`,
		`{"schemaVersion":1,"Payload":"a","signature":"b"}`} {
		_, err := DecodeDeliveryProofEnvelope([]byte(raw))
		require.Error(t, err)
	}
	feishu := []string{"真实飞书消息经明确确认创建版本化 Target，并返回可追踪回复", "保留 callback、事件、会话和回复的脱敏 Provider 标识"}
	codex := []string{"Codex 执行绑定版本、运行、环境、日志、成本与权限，并产生内容寻址工件", "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult"}
	require.Equal(t, "feishu_target", deliveryProofKindForAssertions(feishu))
	require.Equal(t, "codex_execution", deliveryProofKindForAssertions([]string{codex[1], codex[0]}))
	for _, unsupported := range [][]string{nil, feishu[:1], {codex[0], codex[0]}, append(feishu, "ts_tests"), {"ts_tests", "ts_build"}} {
		require.Empty(t, deliveryProofKindForAssertions(unsupported))
	}
}
