package target

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func readOpenCodeSignedVector(t *testing.T, path string) (DeliveryProofTrustProfile, DeliveryProofPayload, repositoryCIOutput) {
	t.Helper()
	// Production recorder serialization with synthetic DB/provider/witness inputs.
	// Validate the original signature, not a Go-re-signed substitute.
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var vector struct {
		Synthetic bool                      `json:"synthetic"`
		Trust     DeliveryProofTrustProfile `json:"trust"`
		Envelope  DeliveryProofEnvelope     `json:"envelope"`
		Result    json.RawMessage           `json:"result"`
	}
	require.NoError(t, json.Unmarshal(raw, &vector))
	require.True(t, vector.Synthetic)
	encoded, err := base64.StdEncoding.Strict().DecodeString(vector.Envelope.Payload)
	require.NoError(t, err)
	public, err := deliveryProofBase64(vector.Trust.PublicKey, ed25519.PublicKeySize)
	require.NoError(t, err)
	signature, err := deliveryProofBase64(vector.Envelope.Signature, ed25519.SignatureSize)
	require.NoError(t, err)
	require.True(t, ed25519.Verify(public, append([]byte(deliveryProofSignatureDomain), encoded...), signature))
	var payload DeliveryProofPayload
	require.NoError(t, strictFixedCIJSON(encoded, &payload))
	digest := sha256.Sum256([]byte(payload.ObservationJSON))
	require.Equal(t, hex.EncodeToString(digest[:]), payload.ObservationSHA256)
	require.Equal(t, vector.Trust.SHA256(), payload.TrustProfileSHA256)
	var output repositoryCIOutput
	require.NoError(t, decodeRepositoryCIJSON(vector.Result, &output))
	return vector.Trust, payload, output
}

func TestOpenCodeActualTypeScriptSignedProjection(t *testing.T) {
	profile, payload, output := readOpenCodeSignedVector(t, "testdata/opencode-closed-proof-v1.json")
	var decoded openCodeDeliveryObservation
	require.NoError(t, decodeOpenCodeJSON([]byte(payload.ObservationJSON), &decoded))
	require.True(t, validateOpenCodeRuntimeProof(decoded.Runtime, decoded.Execution, payload), "runtime projection")
	observation, err := decodeOpenCodeDeliveryObservation(profile, payload)
	require.NoError(t, err)
	require.True(t, validateOpenCodeExecutionContext(observation.Execution, payload, output.OutputReceipt))
}

func TestOpenCodeRejectsSignedInvalidSyntheticFacts(t *testing.T) {
	profile, payload, _ := readOpenCodeSignedVector(t, "testdata/opencode-closed-proof-invalid-mocks-v1.json")
	var observation openCodeDeliveryObservation
	require.NoError(t, decodeOpenCodeJSON([]byte(payload.ObservationJSON), &observation))
	require.Empty(t, observation.CI.Checks)
	require.False(t, validateOpenCodeRuntimeProof(observation.Runtime, observation.Execution, payload))
	_, err := decodeOpenCodeDeliveryObservation(profile, payload)
	require.Error(t, err, "a valid verifier signature does not excuse missing CI checks or incomplete runtime coverage")
}

// Projection-only synthetic fixture; this never claims an observed execution.
func openCodeExecutionFixture(t *testing.T) (openCodeExecutionContext, DeliveryProofPayload, repositoryCIOutputReceipt) {
	facts, input, receipt := repositoryCIFixture(t)
	ref := repositoryCIExecutionObservation{ContentHash: strings.Repeat("1", 64), Bytes: 100,
		ContentRef: "storage:" + facts.Identity.WorkspaceID + "/verrail/repository-execution-observations/sha256/" + strings.Repeat("1", 64)}
	receipt.ExecutionObservation = &ref
	repositoryCIProject(t, &facts, &input, receipt)
	receipt.SHA256 = input.Source.OutputReceiptSHA256
	input.TargetID = facts.Identity.TargetID
	input.TargetRevisionID = facts.Identity.TargetRevisionID
	input.GraphRevisionID = facts.Identity.GraphRevisionID
	input.Source.RunEventID = mustNewUUID(t)
	payload := DeliveryProofPayload{Kind: "opencode_execution", WorkspaceID: facts.Identity.WorkspaceID, Source: input,
		RuntimeManifestSHA256: strings.Repeat("2", 64), VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	e := openCodeExecutionContext{repositoryCIIdentity: facts.Identity, RequestSHA256: receipt.RequestSHA256, OutputReceiptSHA256: receipt.SHA256,
		RunEventID: input.Source.RunEventID, ExecutionObservation: ref, Runtime: "opencode", RuntimeVersion: "1.17.13", Model: facts.Model,
		ProviderID: "fixture", ModelID: "test", SessionID: "ses_example", MessageID: "msg_example", UsageStatus: "complete", UsageScope: "session-step-finish",
		CostStatus: "unavailable", CostBasis: "opencode-estimate", ContextSHA256: strings.Repeat("3", 64)}
	e.LogRef = repositoryCIExecutionObservation{ContentHash: strings.Repeat("4", 64), Bytes: 200,
		ContentRef: "storage:" + facts.Identity.WorkspaceID + "/verrail/repository-execution-logs/sha256/" + strings.Repeat("4", 64)}
	e.ExecutionWindow.StartedAt = receipt.ExecutionFacts.StartedAt
	e.ExecutionWindow.FinishedAt = receipt.ExecutionFacts.FinishedAt
	e.HealthVerifiedAt = e.ExecutionWindow.StartedAt
	e.SessionCreatedAt = e.HealthVerifiedAt
	e.SessionCompletedAt = e.ExecutionWindow.FinishedAt
	e.FullHistory.SHA256 = e.LogRef.ContentHash
	e.FullHistory.ProjectionSHA256 = strings.Repeat("5", 64)
	e.FullHistory.Bytes = e.LogRef.Bytes
	e.FullHistory.MessageCount = 2
	e.FullHistory.PartCount = 4
	b := &e.RuntimeWitness.Before
	b.CheckedAt = e.SessionCreatedAt
	b.Permissions.Default = "deny"
	b.Permissions.AllowedTools = []string{"repository_execute_command"}
	b.Permissions.SessionRulesSHA256 = strings.Repeat("6", 64)
	b.Permissions.ConfigRulesSHA256 = strings.Repeat("7", 64)
	b.Environment.HomeSHA256 = strings.Repeat("8", 64)
	b.Environment.Directory = "."
	b.Environment.Config = "config/opencode"
	b.Environment.State = "state/opencode"
	b.Environment.Worktree = "isolated-home"
	b.Configuration.Share = "disabled"
	b.Configuration.Model = e.Model
	b.Configuration.SmallModel = e.Model
	b.Configuration.EnabledProviders = []string{"fixture"}
	e.RuntimeWitness.After = *b
	e.RuntimeWitness.After.CheckedAt = e.SessionCompletedAt
	e.CandidateRuntime = openCodeRuntimeBinding{Kind: "verrail.opencode-session-bound", NativePID: 123, ObserverPID: 124, SessionID: mustNewUUID(t), ManifestSHA256: payload.RuntimeManifestSHA256,
		HTTPSession: openCodeHTTPIdentity{SessionID: e.SessionID, RuntimeVersion: e.RuntimeVersion, CreatedAt: e.SessionCreatedAt, HomeSHA256: b.Environment.HomeSHA256}}
	identity, err := repositoryCIJSON(e.repositoryCIIdentity)
	require.NoError(t, err)
	digest := sha256.Sum256(identity)
	e.CandidateRuntime.ExecutionIdentitySHA256 = hex.EncodeToString(digest[:])
	e.Cleanup.Runtime = true
	e.Cleanup.Home = true
	e.Cleanup.Commands = true
	e.Cleanup.Checkout = true
	return e, payload, receipt
}

func TestOpenCodeExecutionProjection(t *testing.T) {
	e, p, r := openCodeExecutionFixture(t)
	require.True(t, validateOpenCodeExecutionContext(e, p, r))
	for name, mutate := range map[string]func(*openCodeExecutionContext){
		"wrong attempt":      func(e *openCodeExecutionContext) { e.RunAttemptID = mustNewUUID(t) },
		"wrong receipt":      func(e *openCodeExecutionContext) { e.OutputReceiptSHA256 = strings.Repeat("9", 64) },
		"wrong observation":  func(e *openCodeExecutionContext) { e.ExecutionObservation.ContentHash = strings.Repeat("9", 64) },
		"foreign log":        func(e *openCodeExecutionContext) { e.LogRef.ContentRef = "storage:foreign" },
		"missing history":    func(e *openCodeExecutionContext) { e.FullHistory.MessageCount = 0 },
		"unavailable usage":  func(e *openCodeExecutionContext) { e.UsageStatus = "unavailable" },
		"claimed billing":    func(e *openCodeExecutionContext) { e.CostStatus = "verified" },
		"negative tokens":    func(e *openCodeExecutionContext) { e.Usage.Input = -1 },
		"unsafe tokens":      func(e *openCodeExecutionContext) { e.Usage.Total = 9007199254740992 },
		"negative cost":      func(e *openCodeExecutionContext) { cost := -1.0; e.ReportedCostUSD = &cost },
		"permission default": func(e *openCodeExecutionContext) { e.RuntimeWitness.Before.Permissions.Default = "allow" },
		"permission changed": func(e *openCodeExecutionContext) {
			e.RuntimeWitness.After.Permissions.ConfigRulesSHA256 = strings.Repeat("9", 64)
		},
		"runtime cleanup":      func(e *openCodeExecutionContext) { e.Cleanup.Runtime = false },
		"home cleanup":         func(e *openCodeExecutionContext) { e.Cleanup.Home = false },
		"command cleanup":      func(e *openCodeExecutionContext) { e.Cleanup.Commands = false },
		"checkout cleanup":     func(e *openCodeExecutionContext) { e.Cleanup.Checkout = false },
		"native kind alias":    func(e *openCodeExecutionContext) { e.CandidateRuntime.Kind = "verrail.native-runtime-started" },
		"foreign manifest":     func(e *openCodeExecutionContext) { e.CandidateRuntime.ManifestSHA256 = strings.Repeat("9", 64) },
		"foreign http session": func(e *openCodeExecutionContext) { e.CandidateRuntime.HTTPSession.SessionID = "ses_foreign" },
		"late session":         func(e *openCodeExecutionContext) { e.SessionCompletedAt = r.FinalizedAt },
	} {
		t.Run(name, func(t *testing.T) {
			e, p, r := openCodeExecutionFixture(t)
			mutate(&e)
			require.False(t, validateOpenCodeExecutionContext(e, p, r))
		})
	}
}

func TestOpenCodeClosedNullableJSON(t *testing.T) {
	e, _, _ := openCodeExecutionFixture(t)
	raw, err := json.Marshal(e)
	require.NoError(t, err)
	var parsed openCodeExecutionContext
	require.NoError(t, decodeOpenCodeJSON(raw, &parsed))
	require.Nil(t, parsed.ReportedCostUSD)
	for name, body := range map[string]string{
		"empty":            "{}",
		"missing nullable": strings.Replace(string(raw), `"reportedCostUsd":null,`, "", 1),
		"null required":    strings.Replace(string(raw), `"usageStatus":"complete"`, `"usageStatus":null`, 1),
		"null usage":       strings.Replace(string(raw), `"total":0`, `"total":null`, 1),
		"duplicate":        strings.Replace(string(raw), `"usageStatus":"complete"`, `"usageStatus":"complete","usageStatus":"complete"`, 1),
		"alias":            strings.Replace(string(raw), `"usageStatus"`, `"UsageStatus"`, 1),
		"unknown":          strings.Replace(string(raw), `"usageStatus":"complete"`, `"usageStatus":"complete","verdict":"passed"`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			var value openCodeExecutionContext
			require.Error(t, decodeOpenCodeJSON([]byte(body), &value))
		})
	}
}

func openCodeRuntimeFixture(t *testing.T, e openCodeExecutionContext, p DeliveryProofPayload) openCodeRuntimeProof {
	runtime := openCodeRuntimeProof{SchemaVersion: 1, Kind: "verrail.opencode-candidate-runtime-proof", SessionID: e.CandidateRuntime.SessionID, ManifestSHA256: p.RuntimeManifestSHA256}
	for _, component := range []string{"server", "domain", "repository_executor", "opencode"} {
		nonce := mustNewUUID(t)
		w := openCodeCandidateWitness{SchemaVersion: 1, Kind: "verrail.opencode-candidate-runtime-witness-summary", Component: component,
			Phase: "checkpoint", SessionID: runtime.SessionID, RequestID: &nonce, ManifestSHA256: runtime.ManifestSHA256,
			VerifierBuildSHA256: strings.Repeat("1", 64), ObserverExecutableSHA256: strings.Repeat("2", 64), ConfigurationSHA256: strings.Repeat("3", 64), ObserverPID: 100}
		w.Observation.SourceKind = "verrail.native-runtime-observation"
		w.Observation.ObserverSessionID = mustNewUUID(t)
		w.Observation.PID = 101
		w.Observation.CandidateCommit = p.Source.CI.TestedCommit
		w.Observation.ExecutableSHA256 = strings.Repeat("4", 64)
		w.Observation.StartedAt = e.ExecutionWindow.StartedAt
		w.Observation.ObservedAt = e.ExecutionWindow.FinishedAt
		w.Observation.ObservationSHA256 = strings.Repeat("5", 64)
		w.Observation.Limitations = []string{}
		w.Launch.RootSHA256 = strings.Repeat("6", 64)
		w.Launch.ArgvSHA256 = strings.Repeat("7", 64)
		w.Launch.EnvironmentSHA256 = strings.Repeat("8", 64)
		w.EnvelopeRef = repositoryCIExecutionObservation{ContentHash: strings.Repeat("9", 64), Bytes: 200, ContentRef: "private-witness:sha256:" + strings.Repeat("9", 64)}
		if component == "server" || component == "repository_executor" {
			h := strings.Repeat("a", 64)
			w.Observation.SourceKind = "verrail.node-runtime-observation"
			w.Observation.SourceManifestSHA256 = &h
			w.Observation.ScriptCount = 1
		}
		if component == "opencode" {
			w.Phase = "terminated"
			w.RequestID = nil
			w.ExecutionIdentity = &e.repositoryCIIdentity
			w.HTTPSession = &e.CandidateRuntime.HTTPSession
			w.ObserverPID = e.CandidateRuntime.ObserverPID
			w.Observation.PID = e.CandidateRuntime.NativePID
			w.Launch.RootSHA256 = e.CandidateRuntime.HTTPSession.HomeSHA256
			require.NoError(t, json.Unmarshal([]byte(`{"requestedSignal":"SIGTERM","finishedAt":"placeholder","processGroupStopped":true,"immutableExecutableRemoved":true}`), &w.Termination))
			w.Termination.FinishedAt = e.ExecutionWindow.FinishedAt
		}
		runtime.Witnesses = append(runtime.Witnesses, w)
	}
	return runtime
}

func TestOpenCodeCompactRuntimeProjection(t *testing.T) {
	e, p, _ := openCodeExecutionFixture(t)
	r := openCodeRuntimeFixture(t, e, p)
	require.True(t, validateOpenCodeRuntimeProof(r, e, p))
	for name, mutate := range map[string]func(*openCodeRuntimeProof){
		"legacy runtime":      func(r *openCodeRuntimeProof) { r.Kind = "verrail.candidate-runtime-observation" },
		"missing component":   func(r *openCodeRuntimeProof) { r.Witnesses = r.Witnesses[:3] },
		"duplicate component": func(r *openCodeRuntimeProof) { r.Witnesses[1].Component = r.Witnesses[0].Component },
		"legacy heartbeat":    func(r *openCodeRuntimeProof) { r.Witnesses[2].Component = "heartbeat" },
		"wrong candidate":     func(r *openCodeRuntimeProof) { r.Witnesses[0].Observation.CandidateCommit = strings.Repeat("0", 40) },
		"unarchived witness":  func(r *openCodeRuntimeProof) { r.Witnesses[0].EnvelopeRef.ContentRef = "private-witness:untrusted" },
		"node without source": func(r *openCodeRuntimeProof) { r.Witnesses[0].Observation.SourceManifestSHA256 = nil },
		"empty node scripts":  func(r *openCodeRuntimeProof) { r.Witnesses[0].Observation.ScriptCount = 0 },
		"null limitations":    func(r *openCodeRuntimeProof) { r.Witnesses[0].Observation.Limitations = nil },
		"noncheckpoint":       func(r *openCodeRuntimeProof) { r.Witnesses[0].RequestID = nil },
		"wrong session":       func(r *openCodeRuntimeProof) { r.Witnesses[3].SessionID = mustNewUUID(t) },
		"wrong pid":           func(r *openCodeRuntimeProof) { r.Witnesses[3].Observation.PID++ },
		"missing identity":    func(r *openCodeRuntimeProof) { r.Witnesses[3].ExecutionIdentity = nil },
		"missing termination": func(r *openCodeRuntimeProof) { r.Witnesses[3].Termination = nil },
		"process not stopped": func(r *openCodeRuntimeProof) { r.Witnesses[3].Termination.ProcessGroupStopped = false },
		"executable retained": func(r *openCodeRuntimeProof) { r.Witnesses[3].Termination.ImmutableExecutableRemoved = false },
	} {
		t.Run(name, func(t *testing.T) {
			e, p, _ := openCodeExecutionFixture(t)
			r := openCodeRuntimeFixture(t, e, p)
			mutate(&r)
			require.False(t, validateOpenCodeRuntimeProof(r, e, p))
		})
	}
}

func openCodeObservationFixture(t *testing.T, e openCodeExecutionContext, p DeliveryProofPayload, profile DeliveryProofTrustProfile) openCodeDeliveryObservation {
	o := openCodeDeliveryObservation{SchemaVersion: 1, Kind: "opencode_execution", Execution: e, Runtime: openCodeRuntimeFixture(t, e, p),
		SourceContextSHA256: strings.Repeat("a", 64), Assurance: "host_trusted_fixed_verifier",
		Limitations: []string{"not_hostile_same_uid_isolation", "runtime_http_readback_not_os_sandbox", "reported_cost_is_not_verified_billing"}}
	o.References.IdempotencyKey = p.IdempotencyKey
	o.References.Kind = o.Kind
	o.References.Execution.RunID = e.RunID
	o.References.Execution.RunAttemptID = e.RunAttemptID
	o.References.CI.RunID = p.Source.CI.ProviderRunID
	o.References.CI.RunAttempt = p.Source.CI.ProviderAttempt
	o.References.CI.ClaimID = p.Source.ClaimID
	o.References.CI.WorkNodeID = p.Source.WorkNodeID
	o.References.CI.ArtifactRevisionID = p.Source.ArtifactRevisionID
	o.References.CI.RequirementID = p.Source.RequirementID
	o.CI.Kind = "verrail.fixed-ci-observation"
	o.CI.SchemaVersion = 1
	o.CI.Repository = profile.CI.Repository
	o.CI.RepositoryID = profile.CI.RepositoryID
	o.CI.ProviderRunID = p.Source.CI.ProviderRunID
	o.CI.ProviderAttempt = p.Source.CI.ProviderAttempt
	o.CI.WorkflowExecutionSHA = profile.CI.WorkflowExecutionSHA
	o.CI.TestedCandidateSHA = p.Source.CI.TestedCommit
	o.CI.WorkflowPath = ".github/workflows/verrail-candidate-verify.yml"
	o.CI.WorkflowSHA256 = profile.CI.WorkflowSHA256
	o.CI.HelperSHA256 = profile.CI.HelperSHA256
	o.CI.ArtifactID = p.Source.CI.ArtifactID
	o.CI.ArchiveSHA256 = p.Source.CI.ArchiveSHA256
	o.CI.ReportSHA256 = p.Source.CI.ReportSHA256
	o.CI.VerifiedAt = p.Source.CI.VerifiedAt
	o.CI.ReceiptSHA256 = p.Source.CI.ObservationSHA256
	o.CI.Reference = "https://github.com/" + profile.CI.Repository + "/actions/runs/" + o.CI.ProviderRunID + "/attempts/" + strconv.FormatInt(o.CI.ProviderAttempt, 10)
	for _, id := range []string{"ts_tests", "ts_typecheck", "ts_build", "go_tests"} {
		o.CI.Checks = append(o.CI.Checks, struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		}{id, "passed"})
	}
	o.CI.UnsupportedObligations = []string{"live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"}
	return o
}
