package target

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"time"
)

const deliveryProofSignatureDomain = "verrail.closed-delivery-proof.v1\x00"

// This profile is operator configuration, never a field supplied by a request.
type DeliveryProofTrustProfile struct {
	SchemaVersion         int                      `json:"schemaVersion"`
	CI                    FixedCIProofTrustProfile `json:"ci"`
	PublicKey             string                   `json:"publicKey"`
	ReaderPolicySHA256    string                   `json:"readerPolicySha256"`
	VerifierBuildSHA256   string                   `json:"verifierBuildSha256"`
	RuntimeManifestSHA256 string                   `json:"runtimeManifestSha256"`
	MaxAgeMS              int64                    `json:"maxAgeMs"`
}

func (profile DeliveryProofTrustProfile) validate() error {
	if profile.SchemaVersion != 1 || profile.CI.validate() != nil || profile.MaxAgeMS < 1 || profile.MaxAgeMS > 300000 {
		return validation("DELIVERY_PROOF_CONFIG_INVALID")
	}
	if _, err := deliveryProofBase64(profile.PublicKey, ed25519.PublicKeySize); err != nil {
		return validation("DELIVERY_PROOF_CONFIG_INVALID")
	}
	for _, hash := range []string{profile.ReaderPolicySHA256, profile.VerifierBuildSHA256, profile.RuntimeManifestSHA256} {
		if !fixedCIDigestPattern.MatchString(hash) {
			return validation("DELIVERY_PROOF_CONFIG_INVALID")
		}
	}
	return nil
}

func ParseDeliveryProofTrustProfile(raw string) (DeliveryProofTrustProfile, error) {
	var profile DeliveryProofTrustProfile
	if len(raw) > 16384 || strictFixedCIJSON([]byte(raw), &profile) != nil || profile.validate() != nil {
		return profile, validation("DELIVERY_PROOF_CONFIG_INVALID")
	}
	return profile, nil
}

func (profile DeliveryProofTrustProfile) SHA256() string { return proofHash(profile) }

type DeliveryProofEnvelope struct {
	SchemaVersion int    `json:"schemaVersion"`
	Payload       string `json:"payload"`
	Signature     string `json:"signature"`
}

// The envelope authenticates a fixed verifier's output. It does not itself
// validate observations or grant Store/Principal independent-proof authority.
type DeliveryProofPayload struct {
	SchemaVersion         int               `json:"schemaVersion"`
	Kind                  string            `json:"kind"`
	ObservationID         string            `json:"observationId"`
	IdempotencyKey        string            `json:"idempotencyKey"`
	WorkspaceID           string            `json:"workspaceId"`
	TrustProfileSHA256    string            `json:"trustProfileSha256"`
	ReaderPolicySHA256    string            `json:"readerPolicySha256"`
	VerifierBuildSHA256   string            `json:"verifierBuildSha256"`
	RuntimeManifestSHA256 string            `json:"runtimeManifestSha256"`
	StartedAt             string            `json:"startedAt"`
	VerifiedAt            string            `json:"verifiedAt"`
	Source                FixedCIProofInput `json:"source"`
	ObservationSHA256     string            `json:"observationSha256"`
	ObservationJSON       string            `json:"observationJson"`
}

func DecodeDeliveryProofEnvelope(raw []byte) (DeliveryProofEnvelope, error) {
	var envelope DeliveryProofEnvelope
	if len(raw) > 65536 || strictFixedCIJSON(raw, &envelope) != nil {
		return envelope, validation("DELIVERY_PROOF_ENVELOPE_INVALID")
	}
	return envelope, nil
}

func deliveryProofBase64(value string, size int) ([]byte, error) {
	if len(value) != base64.StdEncoding.EncodedLen(size) {
		return nil, validation("DELIVERY_PROOF_ENVELOPE_INVALID")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(decoded) != size || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, validation("DELIVERY_PROOF_ENVELOPE_INVALID")
	}
	return decoded, nil
}

func verifyDeliveryProofEnvelope(profile DeliveryProofTrustProfile, workspaceID, key string, envelope DeliveryProofEnvelope) (DeliveryProofPayload, error) {
	var payload DeliveryProofPayload
	invalid := func() (DeliveryProofPayload, error) {
		return DeliveryProofPayload{}, validation("DELIVERY_PROOF_ENVELOPE_INVALID")
	}
	if profile.validate() != nil || envelope.SchemaVersion != 1 || len(envelope.Payload) < 4 || len(envelope.Payload) > 60000 {
		return invalid()
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(envelope.Payload)
	if err != nil || base64.StdEncoding.EncodeToString(raw) != envelope.Payload {
		return invalid()
	}
	public, _ := deliveryProofBase64(profile.PublicKey, ed25519.PublicKeySize)
	signature, err := deliveryProofBase64(envelope.Signature, ed25519.SignatureSize)
	if err != nil || !ed25519.Verify(public, append([]byte(deliveryProofSignatureDomain), raw...), signature) {
		return invalid()
	}
	if strictFixedCIJSON(raw, &payload) != nil || payload.SchemaVersion != 1 || !uuidPattern.MatchString(payload.ObservationID) ||
		payload.Source.validate(workspaceID, key) != nil || payload.IdempotencyKey != key ||
		payload.WorkspaceID != workspaceID || workspaceID != profile.CI.WorkspaceID ||
		payload.TrustProfileSHA256 != profile.SHA256() || payload.ReaderPolicySHA256 != profile.ReaderPolicySHA256 ||
		payload.VerifierBuildSHA256 != profile.VerifierBuildSHA256 || payload.RuntimeManifestSHA256 != profile.RuntimeManifestSHA256 ||
		!fixedCIDigestPattern.MatchString(payload.ObservationSHA256) ||
		payload.Source.TargetID != profile.CI.TargetID || payload.Source.TargetRevisionID != profile.CI.TargetRevisionID ||
		payload.Source.GraphRevisionID != profile.CI.GraphRevisionID || payload.Source.CI.TestedCommit != profile.CI.WorkflowExecutionSHA ||
		(payload.Kind != "feishu_target" && payload.Kind != "codex_execution" && payload.Kind != "opencode_execution" && payload.Kind != "repository_recovery") {
		return invalid()
	}
	observationHash := sha256.Sum256([]byte(payload.ObservationJSON))
	if len(payload.ObservationJSON) < 2 || len(payload.ObservationJSON) > 40000 || !json.Valid([]byte(payload.ObservationJSON)) ||
		hex.EncodeToString(observationHash[:]) != payload.ObservationSHA256 {
		return invalid()
	}
	started, startErr := time.Parse(time.RFC3339Nano, payload.StartedAt)
	verified, verifiedErr := time.Parse(time.RFC3339Nano, payload.VerifiedAt)
	ciVerified, ciErr := time.Parse(time.RFC3339Nano, payload.Source.CI.VerifiedAt)
	now := time.Now()
	if startErr != nil || verifiedErr != nil || ciErr != nil || verified.Before(started) ||
		started.Before(now.Add(-time.Duration(profile.MaxAgeMS)*time.Millisecond)) || verified.After(now.Add(30*time.Second)) ||
		ciVerified.After(verified.Add(30*time.Second)) || ciVerified.Before(now.Add(-time.Duration(profile.CI.MaxAgeMS)*time.Millisecond)) {
		return invalid()
	}
	if payload.Kind == "opencode_execution" {
		if _, err := decodeOpenCodeDeliveryObservation(profile, payload); err != nil {
			return invalid()
		}
	}
	if payload.Kind == "repository_recovery" {
		if _, err := decodeRepositoryRecoveryObservation(profile, payload); err != nil {
			return invalid()
		}
	}
	return payload, nil
}

func deliveryProofKindForAssertions(assertions []string) string {
	for kind, expected := range map[string][]string{
		"feishu_target":      {"真实飞书消息经明确确认创建版本化 Target，并返回可追踪回复", "保留 callback、事件、会话和回复的脱敏 Provider 标识"},
		"codex_execution":    {"Codex 执行绑定版本、运行、环境、日志、成本与权限，并产生内容寻址工件", "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult"},
		"opencode_execution": {"OpenCode 仓库执行绑定 AgentVersion、DeploymentRevision、Run/Attempt、实际运行时、环境、日志、用量、成本状态与权限，并产生内容寻址工件", "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult"},
		"repository_recovery": {
			"OpenCode 仓库执行绑定 AgentVersion、DeploymentRevision、Run/Attempt、实际运行时、环境、日志、用量、成本状态与权限，并产生内容寻址工件",
			"固定提交通过独立 CI 并形成 Evidence 与 VerificationResult",
			"同一候选的仓库执行器在已清理运行时且结果持久化后发生可验证进程中断与重启，并在同一 Run/Attempt 恢复登记，不重跑模型或重复创建工件",
			"真实旧 Attempt 的固定延迟事件被 fencing 拒绝，重复恢复调用保持业务状态不变，并保留独立签名的实际请求、响应与清理记录",
		},
	} {
		if len(assertions) != len(expected) {
			continue
		}
		remaining := make(map[string]bool, len(expected))
		for _, assertion := range expected {
			remaining[assertion] = true
		}
		for _, assertion := range assertions {
			delete(remaining, assertion)
		}
		if len(remaining) == 0 {
			return kind
		}
	}
	return ""
}
