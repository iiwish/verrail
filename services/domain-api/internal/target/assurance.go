package target

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

var assuranceHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

const (
	assuranceResourceArtifact           = "artifact"
	assuranceResourceArtifactRevision   = "artifact_revision"
	assuranceResourceClaim              = "claim"
	assuranceResourceEvidence           = "evidence"
	assuranceResourceVerificationResult = "verification_result"
	assuranceArtifactCreatedEvent       = "assurance.artifact_created.v1"
	assuranceArtifactRevisionAddedEvent = "assurance.artifact_revision_added.v1"
	assuranceClaimCreatedEvent          = "assurance.claim_created.v1"
	assuranceEvidenceRecordedEvent      = "assurance.evidence_recorded.v1"
	assuranceVerificationRecordedEvent  = "assurance.verification_recorded.v1"
	AssuranceArtifactCreateCommand      = "assurance.artifact.create.v1"
	AssuranceArtifactRevisionAddCommand = "assurance.artifact_revision.add.v1"
	AssuranceClaimCreateCommand         = "assurance.claim.create.v1"
	AssuranceEvidenceRecordCommand      = "assurance.evidence.record.v1"
	AssuranceVerificationRecordCommand  = "assurance.verification.record.v1"
)

type CreateArtifactInput struct {
	TargetID string `json:"targetId"`
	Kind     string `json:"kind"`
	Title    string `json:"title"`
}

type AddArtifactRevisionInput struct {
	ArtifactID       string  `json:"artifactId"`
	ContentHash      string  `json:"contentHash"`
	ContentRef       string  `json:"contentRef"`
	SourceRunID      *string `json:"sourceRunId,omitempty"`
	SourceWorkNodeID *string `json:"sourceWorkNodeId,omitempty"`
	BaseRevisionID   *string `json:"baseRevisionId,omitempty"`
}

type CreateClaimInput struct {
	TargetID         string `json:"targetId"`
	TargetRevisionID string `json:"targetRevisionId"`
	CriterionKey     string `json:"criterionKey"`
	Title            string `json:"title"`
}

type RecordEvidenceInput struct {
	TargetID              string  `json:"targetId"`
	ClaimID               *string `json:"claimId,omitempty"`
	Kind                  string  `json:"kind"`
	ProducerPrincipalType string  `json:"producerPrincipalType"`
	ProducerPrincipalID   string  `json:"producerPrincipalId"`
	ObjectHash            string  `json:"objectHash"`
	Reference             string  `json:"reference"`
	TrustLevel            string  `json:"trustLevel"`
}

type RecordVerificationResultInput struct {
	ClaimID         string   `json:"claimId"`
	Verdict         string   `json:"verdict"`
	VerifierVersion string   `json:"verifierVersion"`
	EvidenceIDs     []string `json:"evidenceIds"`
	WaiverReference *string  `json:"waiverReference,omitempty"`
}

func assuranceNotFound(resource string) error {
	return &Error{Status: 404, Code: "ASSURANCE_RESOURCE_NOT_FOUND", Message: resource + " not found in this Workspace"}
}

func ValidateCreateArtifactInput(input *CreateArtifactInput) error {
	if !uuidPattern.MatchString(input.TargetID) {
		return validation("targetId must be a UUID")
	}
	input.Kind = strings.TrimSpace(input.Kind)
	if input.Kind != "code_change" && input.Kind != "document" && input.Kind != "report" && input.Kind != "external_reference" {
		return validation("Artifact kind is invalid")
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" || utf8.RuneCountInString(input.Title) > 200 {
		return validation("Artifact title must contain 1 to 200 characters")
	}
	return nil
}

func validateAssuranceHash(value *string, field string) error {
	trimmed := strings.TrimSpace(*value)
	if !assuranceHashPattern.MatchString(trimmed) {
		return validation(field + " must be a lowercase 64-character sha256 hex digest")
	}
	*value = trimmed
	return nil
}

func ValidateAddArtifactRevisionInput(input *AddArtifactRevisionInput) error {
	if !uuidPattern.MatchString(input.ArtifactID) {
		return validation("artifactId must be a UUID")
	}
	if err := validateAssuranceHash(&input.ContentHash, "contentHash"); err != nil {
		return err
	}
	input.ContentRef = strings.TrimSpace(input.ContentRef)
	if input.ContentRef == "" || utf8.RuneCountInString(input.ContentRef) > 500 {
		return validation("contentRef must contain 1 to 500 characters")
	}
	for _, id := range []*string{input.SourceRunID, input.SourceWorkNodeID, input.BaseRevisionID} {
		if id != nil && !uuidPattern.MatchString(strings.TrimSpace(*id)) {
			return validation("Optional ArtifactRevision references must be UUIDs")
		}
	}
	if input.SourceRunID != nil {
		*input.SourceRunID = strings.TrimSpace(*input.SourceRunID)
	}
	if input.SourceWorkNodeID != nil {
		*input.SourceWorkNodeID = strings.TrimSpace(*input.SourceWorkNodeID)
	}
	if input.BaseRevisionID != nil {
		*input.BaseRevisionID = strings.TrimSpace(*input.BaseRevisionID)
	}
	return nil
}

func ValidateCreateClaimInput(input *CreateClaimInput) error {
	if !uuidPattern.MatchString(input.TargetID) || !uuidPattern.MatchString(input.TargetRevisionID) {
		return validation("targetId and targetRevisionId must be UUIDs")
	}
	input.CriterionKey = strings.TrimSpace(input.CriterionKey)
	if input.CriterionKey == "" || utf8.RuneCountInString(input.CriterionKey) > 100 {
		return validation("criterionKey must contain 1 to 100 characters")
	}
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" || utf8.RuneCountInString(input.Title) > 200 {
		return validation("Claim title must contain 1 to 200 characters")
	}
	return nil
}

func ValidateRecordEvidenceInput(input *RecordEvidenceInput) error {
	if !uuidPattern.MatchString(input.TargetID) {
		return validation("targetId must be a UUID")
	}
	if input.ClaimID != nil {
		value := strings.TrimSpace(*input.ClaimID)
		if !uuidPattern.MatchString(value) {
			return validation("claimId must be a UUID")
		}
		input.ClaimID = &value
	}
	validKinds := map[string]bool{"ci_result": true, "scan_result": true, "human_review": true, "agent_observation": true, "external_reference": true}
	input.Kind = strings.TrimSpace(input.Kind)
	if !validKinds[input.Kind] {
		return validation("Evidence kind is invalid")
	}
	if input.ProducerPrincipalType != "user" && input.ProducerPrincipalType != "service" && input.ProducerPrincipalType != "agent" {
		return validation("producerPrincipalType must be user, service, or agent")
	}
	input.ProducerPrincipalID = strings.TrimSpace(input.ProducerPrincipalID)
	if input.ProducerPrincipalID == "" || utf8.RuneCountInString(input.ProducerPrincipalID) > 200 {
		return validation("producerPrincipalId must contain 1 to 200 characters")
	}
	if err := validateAssuranceHash(&input.ObjectHash, "objectHash"); err != nil {
		return err
	}
	input.Reference = strings.TrimSpace(input.Reference)
	if input.Reference == "" || utf8.RuneCountInString(input.Reference) > 500 {
		return validation("reference must contain 1 to 500 characters")
	}
	if input.TrustLevel != "high" && input.TrustLevel != "medium" && input.TrustLevel != "low" {
		return validation("trustLevel must be high, medium, or low")
	}
	if input.ProducerPrincipalType == "agent" && (input.Kind != "agent_observation" || input.TrustLevel != "low") {
		return validation("agent-produced evidence must be a low-trust agent observation")
	}
	return nil
}

func ValidateRecordVerificationResultInput(input *RecordVerificationResultInput) error {
	if !uuidPattern.MatchString(input.ClaimID) {
		return validation("claimId must be a UUID")
	}
	if input.Verdict != "passed" && input.Verdict != "failed" && input.Verdict != "inconclusive" && input.Verdict != "waived" {
		return validation("Verification verdict is invalid")
	}
	input.VerifierVersion = strings.TrimSpace(input.VerifierVersion)
	if input.VerifierVersion == "" || utf8.RuneCountInString(input.VerifierVersion) > 100 {
		return validation("verifierVersion must contain 1 to 100 characters")
	}
	seen := make(map[string]bool, len(input.EvidenceIDs))
	for index, id := range input.EvidenceIDs {
		trimmed := strings.TrimSpace(id)
		if !uuidPattern.MatchString(trimmed) {
			return validation("evidenceIds entries must be UUIDs")
		}
		if seen[trimmed] {
			return validation("evidenceIds must not contain duplicates")
		}
		seen[trimmed] = true
		input.EvidenceIDs[index] = trimmed
	}
	if len(input.EvidenceIDs) > 100 {
		return validation("evidenceIds may contain at most 100 entries")
	}
	if input.WaiverReference != nil {
		value := strings.TrimSpace(*input.WaiverReference)
		if value == "" || utf8.RuneCountInString(value) > 500 {
			return validation("waiverReference must contain 1 to 500 characters")
		}
		input.WaiverReference = &value
	}
	if input.Verdict == "waived" {
		if input.WaiverReference == nil {
			return validation("A waived verdict requires a waiverReference")
		}
		return nil
	}
	if input.WaiverReference != nil {
		return validation("waiverReference is only allowed for waived verdicts")
	}
	if len(input.EvidenceIDs) < 1 {
		return validation("A non-waived verdict requires at least one evidenceId")
	}
	return nil
}

// claimStatusForVerdict maps a VerificationResult verdict onto the Claim
// status it transactionally asserts. The second return is false for
// inconclusive verdicts, which leave the claim unchanged.
func claimStatusForVerdict(verdict string) (string, bool) {
	switch verdict {
	case "passed":
		return "supported", true
	case "failed":
		return "refuted", true
	case "waived":
		return "waived", true
	default:
		return "", false
	}
}

// verificationResultHash derives the content hash of a VerificationResult:
// sha256 over the canonical JSON payload of the result facts, with the
// evidence set sorted so logically identical results hash identically.
func verificationResultHash(claimID, verdict, verifierVersion string, evidenceIDs []string, waiverReference *string) (string, error) {
	sorted := make([]string, len(evidenceIDs))
	copy(sorted, evidenceIDs)
	sort.Strings(sorted)
	payload := map[string]any{
		"claimId":         claimID,
		"verdict":         verdict,
		"verifierVersion": verifierVersion,
		"evidenceIds":     sorted,
	}
	if waiverReference != nil {
		payload["waiverReference"] = *waiverReference
	} else {
		payload["waiverReference"] = nil
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
