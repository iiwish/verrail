package target

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRepositoryCIActualTypeScriptCollectorVector(t *testing.T) {
	// Exported by repository-attempt.test.ts after a real temporary Git edit,
	// source bundle capture, storage write and checkout disposal. The runtime and
	// identities are synthetic; this is interoperability, not delivery proof.
	raw, err := os.ReadFile("testdata/repository-source-collector-v1.json")
	require.NoError(t, err)
	var vector struct {
		Request json.RawMessage `json:"request"`
		Result  json.RawMessage `json:"result"`
	}
	require.NoError(t, json.Unmarshal(raw, &vector))
	var output repositoryCIOutput
	require.NoError(t, decodeRepositoryCIJSON(vector.Result, &output))
	receipt := output.OutputReceipt
	digest, err := repositoryCIReceiptHash(receipt)
	require.NoError(t, err)
	require.Equal(t, "106f46b708649d5a1bb88b4f08ad963bf38d52236f94f62e1d6ad1dce0d3411e", digest)
	require.Equal(t, receipt.SHA256, digest)
	var compact bytes.Buffer
	require.NoError(t, json.Compact(&compact, vector.Request))
	requestDigest := sha256.Sum256(compact.Bytes())
	require.Equal(t, receipt.RequestSHA256, hex.EncodeToString(requestDigest[:]))
	var typedRequest repositoryCIRequest
	require.NoError(t, decodeRepositoryCIJSON(vector.Request, &typedRequest))
	typedHash, err := repositoryCIRequestHash(typedRequest)
	require.NoError(t, err)
	require.Equal(t, receipt.RequestSHA256, typedHash)
	artifact := receipt.Artifacts[0]
	facts := repositoryCISourceProjection{Identity: receipt.Identity, SourceBinding: receipt.SourceBinding,
		Title: artifact.Title, ContentHash: artifact.ContentHash, ContentRef: artifact.ContentRef,
		Model: receipt.ExecutionFacts.Model, RequestHash: receipt.RequestSHA256, DispatchInput: vector.Request, DispatchResult: vector.Result}
	facts.Event, err = json.Marshal(map[string]any{"repositoryOutput": json.RawMessage(vector.Result),
		"artifacts": []RunArtifactInput{{Title: artifact.Title, Kind: artifact.Kind, ContentHash: artifact.ContentHash, ContentRef: artifact.ContentRef}}})
	require.NoError(t, err)
	input := FixedCIProofInput{Source: FixedCIProofSource{RunID: receipt.Identity.RunID, RunAttemptID: receipt.Identity.RunAttemptID,
		OutputReceiptSHA256: receipt.SHA256, ArtifactOrdinal: 0}, Mapping: FixedCIProofMapping{
		SourceContentSHA256: artifact.SourceSnapshot.SourceContentSHA256, SourceSnapshotTreeSHA: artifact.SourceSnapshot.SnapshotTree}}
	finalized, err := time.Parse(time.RFC3339Nano, receipt.FinalizedAt)
	require.NoError(t, err)
	require.True(t, validateRepositoryCIProjection(facts, input, finalized.Add(time.Second)))
}

// A synthetic projection tests admission boundaries; it is not runtime proof.
func repositoryCIFixture(t *testing.T) (repositoryCISourceProjection, FixedCIProofInput, repositoryCIOutputReceipt) {
	t.Helper()
	profile := fixedCIProfileFixture()
	input := fixedCIInputFixture(t, profile)
	identity := repositoryCIIdentity{WorkspaceID: profile.WorkspaceID, TargetID: profile.TargetID,
		TargetRevisionID: profile.TargetRevisionID, GraphRevisionID: profile.GraphRevisionID,
		WorkNodeID: mustNewUUID(t), RunID: input.Source.RunID, RunAttemptID: input.Source.RunAttemptID,
		LeaseID: mustNewUUID(t), FencingToken: 3, AgentVersionID: mustNewUUID(t), DeploymentRevisionID: mustNewUUID(t)}
	binding := repositoryCISourceBinding{RepositorySourceRevisionID: mustNewUUID(t), ProvenanceContentHash: strings.Repeat("b", 64)}
	facts := repositoryCISourceProjection{Identity: identity, SourceBinding: binding, Title: "Source <&> \u2028\u2029 end",
		ContentHash: strings.Repeat("7", 64), Model: "fixture/test", RequestHash: strings.Repeat("8", 64)}
	facts.ContentRef = "storage:" + identity.WorkspaceID + "/verrail/run-artifacts/sha256/" + facts.ContentHash
	now := time.Now().UTC().Add(-time.Minute)
	stamp := func(seconds int) string {
		return now.Add(time.Duration(seconds) * time.Second).Format(time.RFC3339Nano)
	}
	receipt := repositoryCIOutputReceipt{SchemaVersion: 1, Kind: "verrail.repository-output-receipt", Phase: "after_runtime_cleanup",
		Identity: identity, SourceBinding: binding, RequestSHA256: facts.RequestHash,
		InputSource:  repositoryCIInputSource{ArtifactID: mustNewUUID(t), ContentHash: strings.Repeat("a", 64), BaseCommit: strings.Repeat("b", 40), Format: "git_bundle"},
		SourceStatus: "stable", CollectionStatus: "collected", FinalizedAt: stamp(4)}
	receipt.ExecutionFacts.Runtime, receipt.ExecutionFacts.RuntimeVersion, receipt.ExecutionFacts.Model = "opencode", "1.17.13", facts.Model
	receipt.ExecutionFacts.RequestSHA256 = facts.RequestHash
	receipt.ExecutionFacts.StartedAt, receipt.ExecutionFacts.FinishedAt = stamp(0), stamp(1)
	receipt.ExecutionFacts.Cleanup.Runtime, receipt.ExecutionFacts.Cleanup.Commands = true, true
	receipt.ExecutionFacts.Cleanup.Home, receipt.ExecutionFacts.Cleanup.Checkout = true, true
	source := repositoryCISourceObservation{SchemaVersion: 1, Kind: "verrail.repository-source-observation", Phase: "before_collection",
		Status: "captured", ObservedAt: stamp(2), ScopeVersion: 2}
	source.Repository.HeadCommit, source.Repository.HeadTree, source.Repository.ObjectFormat = strings.Repeat("c", 40), strings.Repeat("d", 40), "sha1"
	source.Manifest.SHA256, source.Manifest.ContentSHA256 = strings.Repeat("e", 64), input.Mapping.SourceContentSHA256
	source.Manifest.Files, source.Manifest.Bytes = 2, 10
	receipt.SourceBefore, receipt.SourceAfter = source, source
	receipt.SourceAfter.Phase, receipt.SourceAfter.ObservedAt = "after_collection", stamp(3)
	var artifact repositoryCIArtifact
	require.NoError(t, json.Unmarshal([]byte(`{"ordinal":0,"path":"source-0.bundle","type":"source_snapshot","kind":"code_change","title":"placeholder","bytes":64,"contentHash":"placeholder","contentRef":"placeholder","sourceSnapshot":{"schemaVersion":1,"format":"git_bundle","scopeVersion":2,"sourceContentSha256":"placeholder","snapshotCommit":"placeholder","snapshotTree":"placeholder"}}`), &artifact))
	artifact.Title, artifact.ContentHash, artifact.ContentRef = facts.Title, facts.ContentHash, facts.ContentRef
	artifact.SourceSnapshot.SourceContentSHA256, artifact.SourceSnapshot.SnapshotTree = input.Mapping.SourceContentSHA256, input.Mapping.SourceSnapshotTreeSHA
	artifact.SourceSnapshot.SnapshotCommit = strings.Repeat("f", 40)
	receipt.Artifacts = []repositoryCIArtifact{artifact}
	requestBytes, err := json.Marshal(identity)
	require.NoError(t, err)
	var request map[string]any
	require.NoError(t, json.Unmarshal(requestBytes, &request))
	request["schemaVersion"], request["kind"], request["runtime"], request["model"] = 1, "target_repository_execution", "opencode", facts.Model
	request["source"], request["instructions"], request["timeoutSeconds"] = receipt.InputSource, "Synthetic fixture", 60
	request["output"] = map[string]any{"maxFiles": 10, "maxFileBytes": 1024, "maxTotalBytes": 2048}
	facts.DispatchInput, err = json.Marshal(request)
	require.NoError(t, err)
	var typedRequest repositoryCIRequest
	require.NoError(t, decodeRepositoryCIJSON(facts.DispatchInput, &typedRequest))
	facts.RequestHash, err = repositoryCIRequestHash(typedRequest)
	require.NoError(t, err)
	receipt.RequestSHA256, receipt.ExecutionFacts.RequestSHA256 = facts.RequestHash, facts.RequestHash
	return facts, input, receipt
}

func repositoryCIProject(t *testing.T, facts *repositoryCISourceProjection, input *FixedCIProofInput, receipt repositoryCIOutputReceipt) {
	t.Helper()
	var err error
	receipt.SHA256, err = repositoryCIReceiptHash(receipt)
	require.NoError(t, err)
	input.Source.OutputReceiptSHA256 = receipt.SHA256
	output := repositoryCIOutput{RunID: facts.Identity.RunID, RunAttemptID: facts.Identity.RunAttemptID,
		LeaseID: facts.Identity.LeaseID, FencingToken: facts.Identity.FencingToken,
		Source: receipt.InputSource, Artifacts: receipt.Artifacts, OutputReceipt: receipt}
	facts.DispatchResult, err = json.Marshal(output)
	require.NoError(t, err)
	artifacts := make([]RunArtifactInput, len(receipt.Artifacts))
	for index, artifact := range receipt.Artifacts {
		artifacts[index] = RunArtifactInput{Title: artifact.Title, Kind: artifact.Kind, ContentHash: artifact.ContentHash, ContentRef: artifact.ContentRef}
	}
	facts.Event, err = json.Marshal(map[string]any{"repositoryOutput": output, "artifacts": artifacts})
	require.NoError(t, err)
}

func TestRepositoryCIProjectionAcceptsSourceSnapshot(t *testing.T) {
	facts, input, receipt := repositoryCIFixture(t)
	repositoryCIProject(t, &facts, &input, receipt)
	require.True(t, validateRepositoryCIProjection(facts, input, time.Now()))
}

func TestRepositoryCIProjectionRejectsRequestDrift(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"instructions":         func(r map[string]any) { r["instructions"] = "Changed after signing" },
		"timeout":              func(r map[string]any) { r["timeoutSeconds"] = 61 },
		"output budget":        func(r map[string]any) { r["output"].(map[string]any)["maxFiles"] = 9 },
		"unknown key":          func(r map[string]any) { r["untrusted"] = true },
		"missing instructions": func(r map[string]any) { delete(r, "instructions") },
	} {
		t.Run(name, func(t *testing.T) {
			facts, input, receipt := repositoryCIFixture(t)
			repositoryCIProject(t, &facts, &input, receipt)
			var request map[string]any
			require.NoError(t, json.Unmarshal(facts.DispatchInput, &request))
			mutate(request)
			var err error
			facts.DispatchInput, err = json.Marshal(request)
			require.NoError(t, err)
			require.False(t, validateRepositoryCIProjection(facts, input, time.Now()))
		})
	}
}

func TestRepositoryCIProjectionRejectsZeroByteFile(t *testing.T) {
	facts, input, receipt := repositoryCIFixture(t)
	receipt.Artifacts = append(receipt.Artifacts, repositoryCIArtifact{Ordinal: 1, Path: "empty.txt", Type: "file",
		Kind: "document", Title: "Empty", Bytes: 0, ContentHash: strings.Repeat("1", 64),
		ContentRef: "storage:" + facts.Identity.WorkspaceID + "/verrail/run-artifacts/sha256/" + strings.Repeat("1", 64)})
	repositoryCIProject(t, &facts, &input, receipt)
	require.False(t, validateRepositoryCIProjection(facts, input, time.Now()))
}

func TestRepositoryCIRequestUnicodeBudget(t *testing.T) {
	for name, instructions := range map[string]string{"three byte unicode": strings.Repeat("中", 400000), "escaped controls": strings.Repeat("\x01", 400000), "astral UTF16": strings.Repeat("\U0001f600", 200000)} {
		t.Run(name, func(t *testing.T) {
			facts, input, receipt := repositoryCIFixture(t)
			var request repositoryCIRequest
			require.NoError(t, decodeRepositoryCIJSON(facts.DispatchInput, &request))
			request.Instructions = instructions
			var err error
			facts.DispatchInput, err = json.Marshal(request)
			require.NoError(t, err)
			facts.RequestHash, err = repositoryCIRequestHash(request)
			require.NoError(t, err)
			receipt.RequestSHA256 = facts.RequestHash
			receipt.ExecutionFacts.RequestSHA256 = facts.RequestHash
			repositoryCIProject(t, &facts, &input, receipt)
			require.True(t, validateRepositoryCIProjection(facts, input, time.Now()))
			request.Instructions += "x"
			facts.DispatchInput, err = json.Marshal(request)
			require.NoError(t, err)
			facts.RequestHash, err = repositoryCIRequestHash(request)
			require.NoError(t, err)
			receipt.RequestSHA256 = facts.RequestHash
			receipt.ExecutionFacts.RequestSHA256 = facts.RequestHash
			repositoryCIProject(t, &facts, &input, receipt)
			require.False(t, validateRepositoryCIProjection(facts, input, time.Now()))
		})
	}
}

func TestRepositoryCIOptionalExecutionObservation(t *testing.T) {
	facts, input, receipt := repositoryCIFixture(t)
	hash := strings.Repeat("9", 64)
	receipt.ExecutionObservation = &repositoryCIExecutionObservation{ContentHash: hash, Bytes: 1024,
		ContentRef: "storage:" + facts.Identity.WorkspaceID + "/verrail/repository-execution-observations/sha256/" + hash}
	repositoryCIProject(t, &facts, &input, receipt)
	require.True(t, validateRepositoryCIProjection(facts, input, time.Now()))
	for name, mutate := range map[string]func(*repositoryCIExecutionObservation){
		"foreign workspace": func(o *repositoryCIExecutionObservation) {
			o.ContentRef = strings.Replace(o.ContentRef, facts.Identity.WorkspaceID, mustNewUUID(t), 1)
		},
		"ordinary artifact namespace": func(o *repositoryCIExecutionObservation) {
			o.ContentRef = strings.Replace(o.ContentRef, "repository-execution-observations", "run-artifacts", 1)
		},
		"invalid digest": func(o *repositoryCIExecutionObservation) { o.ContentHash = "not-a-hash" },
		"empty":          func(o *repositoryCIExecutionObservation) { o.Bytes = 0 },
		"oversized":      func(o *repositoryCIExecutionObservation) { o.Bytes = 65537 },
	} {
		t.Run(name, func(t *testing.T) {
			changed := *receipt.ExecutionObservation
			mutate(&changed)
			bad := receipt
			bad.ExecutionObservation = &changed
			repositoryCIProject(t, &facts, &input, bad)
			require.False(t, validateRepositoryCIProjection(facts, input, time.Now()))
		})
	}
}

func TestRepositoryCIProjectionRejectsResignedSemanticChanges(t *testing.T) {
	cases := map[string]func(*repositoryCIOutputReceipt){
		"native kind":                func(r *repositoryCIOutputReceipt) { r.Kind = "verrail.native-output-receipt" },
		"old schema":                 func(r *repositoryCIOutputReceipt) { r.SchemaVersion = 2 },
		"before cleanup":             func(r *repositoryCIOutputReceipt) { r.Phase = "after_adapter_return" },
		"foreign workspace":          func(r *repositoryCIOutputReceipt) { r.Identity.WorkspaceID = mustNewUUID(t) },
		"foreign target":             func(r *repositoryCIOutputReceipt) { r.Identity.TargetID = mustNewUUID(t) },
		"stale revision":             func(r *repositoryCIOutputReceipt) { r.Identity.TargetRevisionID = mustNewUUID(t) },
		"stale graph":                func(r *repositoryCIOutputReceipt) { r.Identity.GraphRevisionID = mustNewUUID(t) },
		"foreign run":                func(r *repositoryCIOutputReceipt) { r.Identity.RunID = mustNewUUID(t) },
		"older attempt":              func(r *repositoryCIOutputReceipt) { r.Identity.RunAttemptID = mustNewUUID(t) },
		"stale lease":                func(r *repositoryCIOutputReceipt) { r.Identity.LeaseID = mustNewUUID(t) },
		"stale fence":                func(r *repositoryCIOutputReceipt) { r.Identity.FencingToken-- },
		"wrong version":              func(r *repositoryCIOutputReceipt) { r.Identity.AgentVersionID = mustNewUUID(t) },
		"wrong deployment":           func(r *repositoryCIOutputReceipt) { r.Identity.DeploymentRevisionID = mustNewUUID(t) },
		"wrong bound report":         func(r *repositoryCIOutputReceipt) { r.SourceBinding.RepositorySourceRevisionID = mustNewUUID(t) },
		"wrong provenance hash":      func(r *repositoryCIOutputReceipt) { r.SourceBinding.ProvenanceContentHash = strings.Repeat("0", 64) },
		"wrong request":              func(r *repositoryCIOutputReceipt) { r.RequestSHA256 = strings.Repeat("0", 64) },
		"wrong source":               func(r *repositoryCIOutputReceipt) { r.InputSource.ArtifactID = mustNewUUID(t) },
		"no stable collection":       func(r *repositoryCIOutputReceipt) { r.SourceStatus = "unavailable" },
		"no collection":              func(r *repositoryCIOutputReceipt) { r.CollectionStatus = "missing" },
		"wrong runtime":              func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.Runtime = "codex_local" },
		"unversioned runtime":        func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.RuntimeVersion = "latest" },
		"wrong model":                func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.Model = "other/model" },
		"wrong facts request":        func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.RequestSHA256 = strings.Repeat("0", 64) },
		"runtime failed":             func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.ExitCode = 1 },
		"runtime cleanup uncertain":  func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.Cleanup.Runtime = false },
		"command cleanup uncertain":  func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.Cleanup.Commands = false },
		"home cleanup uncertain":     func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.Cleanup.Home = false },
		"checkout cleanup uncertain": func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.Cleanup.Checkout = false },
		"runtime finished too late":  func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.FinishedAt = r.FinalizedAt },
		"runtime reversed":           func(r *repositoryCIOutputReceipt) { r.ExecutionFacts.StartedAt = r.FinalizedAt },
		"source phase":               func(r *repositoryCIOutputReceipt) { r.SourceBefore.Phase = "before_dispatch" },
		"source scope":               func(r *repositoryCIOutputReceipt) { r.SourceBefore.ScopeVersion = 1 },
		"source changed":             func(r *repositoryCIOutputReceipt) { r.SourceAfter.Manifest.ContentSHA256 = strings.Repeat("0", 64) },
		"source HEAD changed":        func(r *repositoryCIOutputReceipt) { r.SourceAfter.Repository.HeadCommit = strings.Repeat("0", 40) },
		"source negative bytes": func(r *repositoryCIOutputReceipt) {
			r.SourceBefore.Manifest.Bytes = -1
			r.SourceAfter.Manifest.Bytes = -1
		},
		"source reversed time":     func(r *repositoryCIOutputReceipt) { r.SourceAfter.ObservedAt = r.ExecutionFacts.StartedAt },
		"finalized before capture": func(r *repositoryCIOutputReceipt) { r.FinalizedAt = r.SourceBefore.ObservedAt },
		"future finalized": func(r *repositoryCIOutputReceipt) {
			r.FinalizedAt = time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
		},
		"snapshot tree": func(r *repositoryCIOutputReceipt) {
			r.Artifacts[0].SourceSnapshot.SnapshotTree = strings.Repeat("0", 40)
		},
		"snapshot content": func(r *repositoryCIOutputReceipt) {
			r.Artifacts[0].SourceSnapshot.SourceContentSHA256 = strings.Repeat("0", 64)
		},
		"snapshot scope":     func(r *repositoryCIOutputReceipt) { r.Artifacts[0].SourceSnapshot.ScopeVersion = 1 },
		"snapshot path":      func(r *repositoryCIOutputReceipt) { r.Artifacts[0].Path = "copied.bundle" },
		"ordinary artifact":  func(r *repositoryCIOutputReceipt) { r.Artifacts[0].Type = "file"; r.Artifacts[0].SourceSnapshot = nil },
		"byte budget":        func(r *repositoryCIOutputReceipt) { r.Artifacts[0].Bytes = 1025 },
		"foreign storage":    func(r *repositoryCIOutputReceipt) { r.Artifacts[0].ContentRef = "storage:foreign/source" },
		"duplicate artifact": func(r *repositoryCIOutputReceipt) { r.Artifacts = append(r.Artifacts, r.Artifacts[0]) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			facts, input, receipt := repositoryCIFixture(t)
			mutate(&receipt)
			repositoryCIProject(t, &facts, &input, receipt)
			require.False(t, validateRepositoryCIProjection(facts, input, time.Now()))
		})
	}
}

func TestRepositoryCIStrictReceiptJSON(t *testing.T) {
	facts, input, receipt := repositoryCIFixture(t)
	repositoryCIProject(t, &facts, &input, receipt)
	for name, changed := range map[string]string{
		"missing ordinal": strings.Replace(string(facts.DispatchResult), `"ordinal":0,`, "", 1),
		"duplicate":       strings.Replace(string(facts.DispatchResult), `"fencingToken":3`, `"fencingToken":3,"fencingToken":3`, 1),
		"unknown":         strings.Replace(string(facts.DispatchResult), `"outputReceipt":{`, `"outputReceipt":{"verdict":"passed",`, 1),
		"aliased":         strings.Replace(string(facts.DispatchResult), `"ordinal":0`, `"Ordinal":0`, 1),
		"null":            strings.Replace(string(facts.DispatchResult), `"ordinal":0`, `"ordinal":null`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			var output repositoryCIOutput
			require.Error(t, decodeRepositoryCIJSON([]byte(changed), &output))
		})
	}
}

func TestRepositoryCIJSONMatchesCanonicalJSONStringify(t *testing.T) {
	value := map[string]any{"sourceStatus": "stable", "inputSource": "<>&\u2028\u2029\n\u0001", "identity": map[string]any{"runAttemptId": "a", "runId": "b"}}
	got, err := repositoryCIJSON(value)
	require.NoError(t, err)
	require.Equal(t, "{\"identity\":{\"runAttemptId\":\"a\",\"runId\":\"b\"},\"inputSource\":\"<>&\u2028\u2029\\n\\u0001\",\"sourceStatus\":\"stable\"}", string(got))
	for _, invalid := range []any{1.5, float64(9007199254740992)} {
		_, err := repositoryCIJSON(map[string]any{"bytes": invalid})
		require.Error(t, err)
	}
}
