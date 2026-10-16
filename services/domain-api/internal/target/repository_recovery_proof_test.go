package target

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRepositoryRecoveryActualTypeScriptSignedProjection(t *testing.T) {
	profile, payload, output := readOpenCodeSignedVector(t, "testdata/repository-recovery-closed-proof-v1.json")
	var decoded repositoryRecoveryObservation
	require.NoError(t, decodeOpenCodeJSON([]byte(payload.ObservationJSON), &decoded))
	component, err := json.Marshal(decoded.Delivery)
	require.NoError(t, err)
	nested := payload
	nested.ObservationJSON = string(component)
	_, err = decodeOpenCodeDeliveryObservation(profile, nested)
	require.NoError(t, err, "nested OpenCode contract")
	runtime, err := repositoryCIJSON(decoded.Delivery.Runtime)
	require.NoError(t, err)
	digest := sha256.Sum256(runtime)
	require.Equal(t, decoded.Recovery.PreRuntimeProofSHA256, hex.EncodeToString(digest[:]), "pre-runtime digest")
	for _, witness := range decoded.Delivery.Runtime.Witnesses {
		if witness.Component == "opencode" {
			require.Equal(t, witness.EnvelopeRef.ContentHash, decoded.Recovery.Runtime.OwnedCleanup.TerminationEnvelopeSHA256, "same archived termination")
		}
	}
	observation, err := decodeRepositoryRecoveryObservation(profile, payload)
	require.NoError(t, err)
	require.True(t, validateOpenCodeExecutionContext(observation.Delivery.Execution, payload, output.OutputReceipt))
}

func TestRepositoryRecoveryRejectsIncompleteOrMismatchedProjection(t *testing.T) {
	profile, payload, _ := readOpenCodeSignedVector(t, "testdata/repository-recovery-closed-proof-v1.json")
	for name, mutate := range map[string]func(*repositoryRecoveryObservation){
		"wrong kind":          func(o *repositoryRecoveryObservation) { o.Kind = "opencode_execution" },
		"wrong identity":      func(o *repositoryRecoveryObservation) { o.Recovery.Identity.RunAttemptID = mustNewUUID(t) },
		"unbound pre-runtime": func(o *repositoryRecoveryObservation) { o.Recovery.PreRuntimeProofSHA256 = strings.Repeat("0", 64) },
		"same process": func(o *repositoryRecoveryObservation) {
			o.Recovery.Runtime.Next.Process = o.Recovery.Runtime.Old.Process
		},
		"unreaped old":         func(o *repositoryRecoveryObservation) { o.Recovery.Runtime.OldStopped.ProcessReaped = false },
		"unreaped next":        func(o *repositoryRecoveryObservation) { o.Recovery.Runtime.NextStopped.ProcessReaped = false },
		"missing cleanup":      func(o *repositoryRecoveryObservation) { o.Recovery.Runtime.OwnedCleanup.ProcessGroupsGone = false },
		"wrong artifact count": func(o *repositoryRecoveryObservation) { o.Recovery.Before.ArtifactCount = 0 },
		"foreign source": func(o *repositoryRecoveryObservation) {
			o.Recovery.Runtime.Next.CandidateCommit = strings.Repeat("0", 40)
		},
		"stale probe replay":   func(o *repositoryRecoveryObservation) { o.Recovery.Probes.Stale.Response.Replayed = true },
		"accepted stale event": func(o *repositoryRecoveryObservation) { o.Recovery.Probes.Stale.Response.Authoritative = true },
		"wrong stale hash":     func(o *repositoryRecoveryObservation) { o.Recovery.Probes.Stale.RequestHash = strings.Repeat("0", 64) },
		"same challenge": func(o *repositoryRecoveryObservation) {
			o.Recovery.Probes.Duplicate.Challenge = o.Recovery.Probes.Stale.Challenge
		},
		"missing archive": func(o *repositoryRecoveryObservation) { o.Recovery.Archives.DuplicateJournal.Bytes = 0 },
		"foreign archive": func(o *repositoryRecoveryObservation) { o.Recovery.Archives.After.ContentRef = "storage:unverified" },
		"wrong cleanup receipt": func(o *repositoryRecoveryObservation) {
			o.Recovery.Runtime.OwnedCleanup.OutputReceiptSHA256 = strings.Repeat("0", 64)
		},
		"missing limitations": func(o *repositoryRecoveryObservation) { o.Recovery.Limitations = nil },
	} {
		t.Run(name, func(t *testing.T) {
			var observation repositoryRecoveryObservation
			require.NoError(t, decodeOpenCodeJSON([]byte(payload.ObservationJSON), &observation))
			mutate(&observation)
			raw, err := json.Marshal(observation)
			require.NoError(t, err)
			changed := payload
			changed.ObservationJSON = string(raw)
			_, err = decodeRepositoryRecoveryObservation(profile, changed)
			require.Error(t, err)
		})
	}
}

func TestRepositoryRecoveryClosedAssertions(t *testing.T) {
	assertions := []string{
		"OpenCode 仓库执行绑定 AgentVersion、DeploymentRevision、Run/Attempt、实际运行时、环境、日志、用量、成本状态与权限，并产生内容寻址工件",
		"固定提交通过独立 CI 并形成 Evidence 与 VerificationResult",
		"同一候选的仓库执行器在已清理运行时且结果持久化后发生可验证进程中断与重启，并在同一 Run/Attempt 恢复登记，不重跑模型或重复创建工件",
		"真实旧 Attempt 的固定延迟事件被 fencing 拒绝，重复恢复调用保持业务状态不变，并保留独立签名的实际请求、响应与清理记录",
	}
	require.Equal(t, "repository_recovery", deliveryProofKindForAssertions(assertions))
	require.Equal(t, "opencode_execution", deliveryProofKindForAssertions(assertions[:2]))
	require.Empty(t, deliveryProofKindForAssertions(assertions[:3]))
	require.Empty(t, deliveryProofKindForAssertions(append(assertions, assertions[0])))
	require.Empty(t, deliveryProofKindForAssertions([]string{assertions[0], assertions[1], assertions[2], assertions[2]}))
	require.Equal(t, "repository_recovery", deliveryProofKindForAssertions([]string{assertions[3], assertions[1], assertions[2], assertions[0]}))
}
