package target

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func fixedCIProfileFixture() FixedCIProofTrustProfile {
	return FixedCIProofTrustProfile{SchemaVersion: 1, WorkspaceID: "11111111-1111-4111-8111-111111111111", TargetID: "22222222-2222-4222-8222-222222222222", TargetRevisionID: "33333333-3333-4333-8333-333333333333", GraphRevisionID: "44444444-4444-4444-8444-444444444444", ConnectionID: "55555555-5555-4555-8555-555555555555", BindingID: "66666666-6666-4666-8666-666666666666", Repository: "owner/repo", RepositoryID: 1, WorkflowID: 2, WorkflowExecutionSHA: strings.Repeat("a", 40), PolicySHA256: strings.Repeat("b", 64), WorkflowSHA256: strings.Repeat("c", 64), HelperSHA256: strings.Repeat("d", 64), MaxAgeMS: 86400000}
}

func fixedCIInputFixture(t *testing.T, profile FixedCIProofTrustProfile) FixedCIProofInput {
	return FixedCIProofInput{SchemaVersion: 1, TargetID: profile.TargetID, TargetRevisionID: profile.TargetRevisionID, GraphRevisionID: profile.GraphRevisionID, ClaimID: mustNewUUID(t), WorkNodeID: mustNewUUID(t), ArtifactRevisionID: mustNewUUID(t), CriterionKey: "criterion-1", RequirementID: "technical",
		Source:  FixedCIProofSource{RunID: mustNewUUID(t), RunAttemptID: mustNewUUID(t), RunEventID: mustNewUUID(t), RunEventContentHash: strings.Repeat("e", 64), OutputReceiptSHA256: strings.Repeat("f", 64)},
		CI:      FixedCIProofObservation{ProviderRunID: "123", ProviderAttempt: 1, TestedCommit: profile.WorkflowExecutionSHA, VerifiedAt: time.Now().UTC().Format(time.RFC3339Nano), ArtifactID: "456", ArchiveSHA256: strings.Repeat("1", 64), ReportSHA256: strings.Repeat("2", 64), ObservationSHA256: strings.Repeat("3", 64)},
		Mapping: FixedCIProofMapping{Version: 1, CommitTreeSHA: strings.Repeat("4", 40), SourceSnapshotTreeSHA: strings.Repeat("5", 40), SourceContentSHA256: strings.Repeat("6", 64)}}
}

func TestFixedCIProofTrustAndWire(t *testing.T) {
	profile := fixedCIProfileFixture()
	raw, err := json.Marshal(profile)
	require.NoError(t, err)
	parsed, err := ParseFixedCIProofTrustProfile(string(raw))
	require.NoError(t, err)
	require.Equal(t, profile, parsed)
	require.Equal(t, "5ddc960b6e6b576f7032b1532c0ae306db312608517d8c45cf5e42138d6448f6", parsed.SHA256(), "same ASCII profile canonicalized with the TypeScript sorted-key JSON algorithm")
	for _, invalid := range []string{"", "null", "[]", string(raw) + " {}", strings.Replace(string(raw), `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1), strings.Replace(string(raw), `"schemaVersion":1`, `"schemaVersion":1,"assertions":["live_codex"]`, 1)} {
		_, err := ParseFixedCIProofTrustProfile(invalid)
		require.Error(t, err)
		require.Equal(t, "FIXED_CI_PROOF_CONFIG_INVALID", err.Error())
	}
	verifier, err := NewFixedCIProofVerifier(&Store{}, profile)
	require.NoError(t, err)
	profile.Repository = "changed/repo"
	require.Equal(t, "owner/repo", verifier.profile.Repository)
	input := fixedCIInputFixture(t, parsed)
	require.NoError(t, input.validate(parsed.WorkspaceID, "test-proof-key"))
	body, err := json.Marshal(input)
	require.NoError(t, err)
	decoded, err := DecodeFixedCIProofInput(body)
	require.NoError(t, err)
	require.Equal(t, input, decoded)
	for _, invalid := range []string{
		strings.Replace(string(body), `"artifactOrdinal":0`, `"ArtifactOrdinal":0`, 1),
		strings.Replace(string(body), `,"artifactOrdinal":0`, "", 1),
		strings.Replace(string(body), `"targetId":`, `"TargetId":`, 1),
		strings.Replace(string(body), `"schemaVersion":1`, `"schemaVersion":1,"SchemaVersion":1`, 1),
	} {
		_, err := DecodeFixedCIProofInput([]byte(invalid))
		require.Error(t, err)
	}
	for _, field := range []string{`"principal":{"type":"service"}`, `"assertions":["live_codex"]`, `"conclusion":"success"`, `"providerReceipt":{}`, `"schemaVersion":1`} {
		_, err := DecodeFixedCIProofInput([]byte(strings.Replace(string(body), `"schemaVersion":1`, `"schemaVersion":1,`+field, 1)))
		require.Error(t, err)
	}
	require.True(t, fixedCIAssertionsSupported([]string{"ts_tests", "ts_typecheck", "ts_build", "go_tests"}))
	require.True(t, fixedCIAssertionsSupported([]string{"go_tests"}))
	require.False(t, fixedCIAssertionsSupported(nil))
	require.False(t, fixedCIAssertionsSupported([]string{"ts_tests", "live_codex"}))
}
