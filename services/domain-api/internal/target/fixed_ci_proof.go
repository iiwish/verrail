package target

import (
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const FixedCIProofVerifierVersion = "github-fixed-ci-verifier.v1"
const fixedCIProofPrincipalID = "github-fixed-ci-verifier"
const fixedCIProofCommand = "github.fixed_ci_proof.record.v1"
const fixedCINativeExecutor = "verrail-host-runner"

var fixedCICommitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var fixedCIDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var fixedCIRepositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
var fixedCIProviderIDPattern = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)

type FixedCIProofTrustProfile struct {
	SchemaVersion        int    `json:"schemaVersion"`
	WorkspaceID          string `json:"workspaceId"`
	TargetID             string `json:"targetId"`
	TargetRevisionID     string `json:"targetRevisionId"`
	GraphRevisionID      string `json:"graphRevisionId"`
	ConnectionID         string `json:"connectionId"`
	BindingID            string `json:"bindingId"`
	PolicySHA256         string `json:"policySha256"`
	Repository           string `json:"repository"`
	RepositoryID         int64  `json:"repositoryId"`
	WorkflowID           int64  `json:"workflowId"`
	WorkflowExecutionSHA string `json:"workflowExecutionSha"`
	WorkflowSHA256       string `json:"workflowSha256"`
	HelperSHA256         string `json:"helperSha256"`
	MaxAgeMS             int64  `json:"maxAgeMs"`
}

func ParseFixedCIProofTrustProfile(raw string) (FixedCIProofTrustProfile, error) {
	var profile FixedCIProofTrustProfile
	if len(raw) == 0 || len(raw) > 16384 || strictFixedCIJSON([]byte(raw), &profile) != nil || profile.validate() != nil {
		return FixedCIProofTrustProfile{}, validation("FIXED_CI_PROOF_CONFIG_INVALID")
	}
	return profile, nil
}

func (profile FixedCIProofTrustProfile) validate() error {
	if profile.SchemaVersion != 1 || profile.MaxAgeMS < 1 || profile.MaxAgeMS > 604800000 || profile.RepositoryID < 1 || profile.RepositoryID > 9007199254740991 || profile.WorkflowID < 1 || profile.WorkflowID > 9007199254740991 || len(profile.Repository) > 401 || !fixedCIRepositoryPattern.MatchString(profile.Repository) || !fixedCICommitPattern.MatchString(profile.WorkflowExecutionSHA) {
		return validation("FIXED_CI_PROOF_CONFIG_INVALID")
	}
	for _, part := range strings.Split(profile.Repository, "/") {
		if part == "." || part == ".." {
			return validation("FIXED_CI_PROOF_CONFIG_INVALID")
		}
	}
	for _, id := range []string{profile.WorkspaceID, profile.TargetID, profile.TargetRevisionID, profile.GraphRevisionID, profile.ConnectionID, profile.BindingID} {
		if !uuidPattern.MatchString(id) {
			return validation("FIXED_CI_PROOF_CONFIG_INVALID")
		}
	}
	for _, hash := range []string{profile.PolicySHA256, profile.WorkflowSHA256, profile.HelperSHA256} {
		if !fixedCIDigestPattern.MatchString(hash) {
			return validation("FIXED_CI_PROOF_CONFIG_INVALID")
		}
	}
	return nil
}

func (profile FixedCIProofTrustProfile) SHA256() string { return proofHash(profile) }

type FixedCIProofSource struct {
	RunID               string `json:"runId"`
	RunAttemptID        string `json:"runAttemptId"`
	RunEventID          string `json:"runEventId"`
	RunEventContentHash string `json:"runEventContentHash"`
	OutputReceiptSHA256 string `json:"outputReceiptSha256"`
	ArtifactOrdinal     int    `json:"artifactOrdinal"`
}

type FixedCIProofObservation struct {
	ProviderRunID     string `json:"providerRunId"`
	ProviderAttempt   int64  `json:"providerAttempt"`
	TestedCommit      string `json:"testedCommit"`
	VerifiedAt        string `json:"verifiedAt"`
	ArtifactID        string `json:"artifactId"`
	ArchiveSHA256     string `json:"archiveSha256"`
	ReportSHA256      string `json:"reportSha256"`
	ObservationSHA256 string `json:"observationSha256"`
}

type FixedCIProofMapping struct {
	Version               int    `json:"version"`
	CommitTreeSHA         string `json:"commitTreeSha"`
	SourceSnapshotTreeSHA string `json:"sourceSnapshotTreeSha"`
	SourceContentSHA256   string `json:"sourceContentSha256"`
}

type FixedCIProofInput struct {
	SchemaVersion      int                     `json:"schemaVersion"`
	TargetID           string                  `json:"targetId"`
	TargetRevisionID   string                  `json:"targetRevisionId"`
	GraphRevisionID    string                  `json:"graphRevisionId"`
	ClaimID            string                  `json:"claimId"`
	WorkNodeID         string                  `json:"workNodeId"`
	ArtifactRevisionID string                  `json:"artifactRevisionId"`
	CriterionKey       string                  `json:"criterionKey"`
	RequirementID      string                  `json:"requirementId"`
	Source             FixedCIProofSource      `json:"source"`
	CI                 FixedCIProofObservation `json:"ci"`
	Mapping            FixedCIProofMapping     `json:"mapping"`
}

func DecodeFixedCIProofInput(raw []byte) (FixedCIProofInput, error) {
	var input FixedCIProofInput
	if strictFixedCIJSON(raw, &input) != nil {
		return input, validation("Invalid fixed CI proof command")
	}
	return input, nil
}

func (input FixedCIProofInput) validate(workspaceID, key string) error {
	if input.SchemaVersion != 1 || input.Mapping.Version != 1 || input.Source.ArtifactOrdinal < 0 || input.Source.ArtifactOrdinal > 9 || len(key) < 8 || len(key) > 128 || !idempotencyKeyPattern.MatchString(key) || input.CriterionKey == "" || strings.TrimSpace(input.CriterionKey) != input.CriterionKey || utf8.RuneCountInString(input.CriterionKey) > 100 || len(input.RequirementID) < 1 || len(input.RequirementID) > 100 || !idempotencyKeyPattern.MatchString(input.RequirementID) {
		return validation("Invalid fixed CI proof command")
	}
	for _, id := range []string{workspaceID, input.TargetID, input.TargetRevisionID, input.GraphRevisionID, input.ClaimID, input.WorkNodeID, input.ArtifactRevisionID, input.Source.RunID, input.Source.RunAttemptID, input.Source.RunEventID} {
		if !uuidPattern.MatchString(id) {
			return validation("Invalid fixed CI proof binding")
		}
	}
	for _, hash := range []string{input.Source.RunEventContentHash, input.Source.OutputReceiptSHA256, input.CI.ArchiveSHA256, input.CI.ReportSHA256, input.CI.ObservationSHA256, input.Mapping.SourceContentSHA256} {
		if !fixedCIDigestPattern.MatchString(hash) {
			return validation("Invalid fixed CI proof digest")
		}
	}
	for _, sha := range []string{input.CI.TestedCommit, input.Mapping.CommitTreeSHA, input.Mapping.SourceSnapshotTreeSHA} {
		if !fixedCICommitPattern.MatchString(sha) {
			return validation("Invalid fixed CI proof Git identity")
		}
	}
	for _, id := range []string{input.CI.ProviderRunID, input.CI.ArtifactID} {
		parsed, err := strconv.ParseInt(id, 10, 64)
		if err != nil || !fixedCIProviderIDPattern.MatchString(id) || parsed > 9007199254740991 {
			return validation("Invalid fixed CI Provider identity")
		}
	}
	if input.CI.ProviderAttempt < 1 || input.CI.ProviderAttempt > 2147483647 {
		return validation("Invalid fixed CI Provider attempt")
	}
	if _, err := time.Parse(time.RFC3339Nano, input.CI.VerifiedAt); err != nil {
		return validation("Invalid fixed CI verification time")
	}
	return nil
}

func fixedCIAssertionsSupported(assertions []string) bool {
	if len(assertions) == 0 {
		return false
	}
	for _, assertion := range assertions {
		switch assertion {
		case "ts_tests", "ts_typecheck", "ts_build", "go_tests":
		default:
			return false
		}
	}
	return true
}

// Reject duplicate keys as well as unknown fields; a startup profile has one meaning.
func strictFixedCIJSON(raw []byte, output any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var visit func() error
	visit = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		if token == nil {
			return validation("Null JSON field")
		}
		delimiter, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		keys := map[string]bool{}
		for decoder.More() {
			if delimiter == '{' {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || keys[name] {
					return validation("Duplicate JSON field")
				}
				keys[name] = true
			}
			if err := visit(); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	}
	if err := visit(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return validation("Invalid JSON object")
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return validation("Invalid JSON object")
	}
	// encoding/json otherwise accepts case aliases and defaults missing fields.
	// These two fixed wire structs have no optional fields.
	canonical, err := json.Marshal(output)
	if err != nil {
		return err
	}
	var actual, expected any
	if json.Unmarshal(raw, &actual) != nil || json.Unmarshal(canonical, &expected) != nil {
		return validation("Invalid JSON object")
	}
	var exactFields func(any, any) bool
	exactFields = func(actual, expected any) bool {
		fields, object := expected.(map[string]any)
		if !object {
			return true
		}
		values, object := actual.(map[string]any)
		if !object || len(values) != len(fields) {
			return false
		}
		for key, value := range fields {
			supplied, present := values[key]
			if !present || !exactFields(supplied, value) {
				return false
			}
		}
		return true
	}
	if !exactFields(actual, expected) {
		return validation("Invalid JSON fields")
	}
	return nil
}
