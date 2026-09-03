package target

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	adjudicationResourceSubmission    = "submission"
	adjudicationResourceDeliveryReview = "delivery_review"
	adjudicationResourceAcceptance     = "acceptance"
	adjudicationSubmissionCreatedEvent = "adjudication.submission_created.v1"
	adjudicationReviewRecordedEvent    = "adjudication.review_recorded.v1"
	adjudicationAcceptanceCreatedEvent = "adjudication.acceptance_created.v1"
	AdjudicationSubmissionCreateCommand = "adjudication.submission.create.v1"
	AdjudicationReviewRecordCommand     = "adjudication.review.record.v1"
	AdjudicationAcceptanceCreateCommand = "adjudication.acceptance.create.v1"
)

// Acceptance authority for G2: the target revision's outcomeOwner principal.
// Fine-grained RBAC stays in G4 (spec.md product contract item 2).
const adjudicationAuthorityOutcomeOwner = "outcome_owner"

type CreateSubmissionInput struct {
	TargetID              string   `json:"targetId"`
	TargetRevisionID      string   `json:"targetRevisionId"`
	ArtifactRevisionIDs   []string `json:"artifactRevisionIds"`
	VerificationResultIDs []string `json:"verificationResultIds"`
	CommitRef             *string  `json:"commitRef,omitempty"`
	EnvironmentSummary    *string  `json:"environmentSummary,omitempty"`
	Notes                 *string  `json:"notes,omitempty"`
}

type RecordDeliveryReviewInput struct {
	SubmissionID           string   `json:"submissionId"`
	ReviewerPrincipalType  string   `json:"reviewerPrincipalType"`
	ReviewerPrincipalID    string   `json:"reviewerPrincipalId"`
	Verdict                string   `json:"verdict"`
	Risks                  *string  `json:"risks,omitempty"`
	UnprovenItems          []string `json:"unprovenItems"`
	Comments               *string  `json:"comments,omitempty"`
}

type AcceptSubmissionInput struct {
	SubmissionID string `json:"submissionId"`
	ReviewID     string `json:"reviewId"`
}

func adjudicationNotFound(resource string) error {
	return &Error{Status: 404, Code: "ASSURANCE_RESOURCE_NOT_FOUND", Message: resource + " not found in this Workspace"}
}

func ValidateCreateSubmissionInput(input *CreateSubmissionInput) error {
	if !uuidPattern.MatchString(input.TargetID) || !uuidPattern.MatchString(input.TargetRevisionID) {
		return validation("targetId and targetRevisionId must be UUIDs")
	}
	if input.ArtifactRevisionIDs == nil {
		input.ArtifactRevisionIDs = []string{}
	}
	if input.VerificationResultIDs == nil {
		input.VerificationResultIDs = []string{}
	}
	if len(input.ArtifactRevisionIDs) < 1 || len(input.ArtifactRevisionIDs) > 100 {
		return validation("artifactRevisionIds must contain 1 to 100 entries")
	}
	seenArtifacts := make(map[string]bool, len(input.ArtifactRevisionIDs))
	for index, id := range input.ArtifactRevisionIDs {
		trimmed := strings.TrimSpace(id)
		if !uuidPattern.MatchString(trimmed) {
			return validation("artifactRevisionIds entries must be UUIDs")
		}
		if seenArtifacts[trimmed] {
			return validation("artifactRevisionIds must not contain duplicates")
		}
		seenArtifacts[trimmed] = true
		input.ArtifactRevisionIDs[index] = trimmed
	}
	if len(input.VerificationResultIDs) > 200 {
		return validation("verificationResultIds may contain at most 200 entries")
	}
	seenResults := make(map[string]bool, len(input.VerificationResultIDs))
	for index, id := range input.VerificationResultIDs {
		trimmed := strings.TrimSpace(id)
		if !uuidPattern.MatchString(trimmed) {
			return validation("verificationResultIds entries must be UUIDs")
		}
		if seenResults[trimmed] {
			return validation("verificationResultIds must not contain duplicates")
		}
		seenResults[trimmed] = true
		input.VerificationResultIDs[index] = trimmed
	}
	for _, ref := range []*string{input.CommitRef, input.EnvironmentSummary, input.Notes} {
		if ref != nil {
			value := strings.TrimSpace(*ref)
			if value == "" {
				return validation("Optional Submission text fields must be empty or non-blank")
			}
			*ref = value
		}
	}
	if input.CommitRef != nil && utf8.RuneCountInString(*input.CommitRef) > 500 {
		return validation("commitRef must contain 1 to 500 characters")
	}
	if input.EnvironmentSummary != nil && utf8.RuneCountInString(*input.EnvironmentSummary) > 2000 {
		return validation("environmentSummary must contain 1 to 2000 characters")
	}
	if input.Notes != nil && utf8.RuneCountInString(*input.Notes) > 2000 {
		return validation("notes must contain 1 to 2000 characters")
	}
	return nil
}

func ValidateRecordDeliveryReviewInput(input *RecordDeliveryReviewInput) error {
	if !uuidPattern.MatchString(input.SubmissionID) {
		return validation("submissionId must be a UUID")
	}
	input.ReviewerPrincipalType = strings.TrimSpace(input.ReviewerPrincipalType)
	// G2 authority model: the reviewer is a human workspace member. The field
	// is kept on the wire for parity; only "user" is accepted.
	if input.ReviewerPrincipalType != "user" {
		return validation("reviewerPrincipalType must be user")
	}
	input.ReviewerPrincipalID = strings.TrimSpace(input.ReviewerPrincipalID)
	if input.ReviewerPrincipalID == "" || utf8.RuneCountInString(input.ReviewerPrincipalID) > 200 {
		return validation("reviewerPrincipalId must contain 1 to 200 characters")
	}
	if input.Verdict != "approved" && input.Verdict != "changes_requested" && input.Verdict != "rejected" {
		return validation("Review verdict is invalid")
	}
	if len(input.UnprovenItems) > 20 {
		return validation("unprovenItems may contain at most 20 entries")
	}
	if input.UnprovenItems == nil {
		input.UnprovenItems = []string{}
	}
	for index, item := range input.UnprovenItems {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" || utf8.RuneCountInString(trimmed) > 500 {
			return validation("each unprovenItem must contain 1 to 500 characters")
		}
		input.UnprovenItems[index] = trimmed
	}
	if input.Risks != nil {
		value := strings.TrimSpace(*input.Risks)
		if value == "" || utf8.RuneCountInString(value) > 2000 {
			return validation("risks must contain 1 to 2000 characters")
		}
		input.Risks = &value
	}
	if input.Comments != nil {
		value := strings.TrimSpace(*input.Comments)
		if value == "" || utf8.RuneCountInString(value) > 4000 {
			return validation("comments must contain 1 to 4000 characters")
		}
		input.Comments = &value
	}
	return nil
}

func ValidateAcceptSubmissionInput(input *AcceptSubmissionInput) error {
	if !uuidPattern.MatchString(input.SubmissionID) || !uuidPattern.MatchString(input.ReviewID) {
		return validation("submissionId and reviewId must be UUIDs")
	}
	return nil
}

// submissionHash derives the content hash of a Submission: sha256 over the
// canonical JSON payload of the binding facts, with the artifact revision and
// verification result sets sorted so logically identical submissions hash
// identically regardless of list order.
func submissionHash(targetRevisionID string, artifactRevisionIDs, verificationResultIDs []string, commitRef, environmentSummary *string) (string, error) {
	sortedArtifacts := make([]string, len(artifactRevisionIDs))
	copy(sortedArtifacts, artifactRevisionIDs)
	sort.Strings(sortedArtifacts)
	sortedResults := make([]string, len(verificationResultIDs))
	copy(sortedResults, verificationResultIDs)
	sort.Strings(sortedResults)
	payload := map[string]any{
		"targetRevisionId":      targetRevisionID,
		"artifactRevisionIds":   sortedArtifacts,
		"verificationResultIds": sortedResults,
		"commitRef":             commitRef,
		"environmentSummary":    environmentSummary,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// deliveryReviewHash derives the content hash of a DeliveryReview: sha256
// over the canonical JSON payload of the review facts, with the unproven item
// list sorted so logically identical reviews hash identically.
func deliveryReviewHash(submissionID, reviewerPrincipalType, reviewerPrincipalID, verdict string, risks *string, unprovenItems []string, comments *string) (string, error) {
	sortedItems := make([]string, len(unprovenItems))
	copy(sortedItems, unprovenItems)
	sort.Strings(sortedItems)
	payload := map[string]any{
		"submissionId":          submissionID,
		"reviewerPrincipalType": reviewerPrincipalType,
		"reviewerPrincipalId":   reviewerPrincipalID,
		"verdict":               verdict,
		"risks":                 risks,
		"unprovenItems":         sortedItems,
		"comments":              comments,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// acceptanceHash derives the content hash of an Acceptance: sha256 over the
// canonical JSON payload of the facts the acceptance binds (ontology 153):
// the DeliveryReview, the Submission, the TargetRevision, and the
// AcceptanceAuthority.
func acceptanceHash(submissionID, reviewID, targetRevisionID, authority string) (string, error) {
	payload := map[string]any{
		"submissionId":      submissionID,
		"reviewId":          reviewID,
		"targetRevisionId":  targetRevisionID,
		"authority":         authority,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// deriveAcceptanceValidity implements ontology invariant 10 without
// mutation: an acceptance is valid iff its submission is the latest
// submission for the target AND its target revision is still the target's
// active revision. When both facts changed, supersession takes precedence.
// The TS read model (packages/shared) mirrors this exact rule.
func deriveAcceptanceValidity(submissionIsLatest, revisionMatches bool) (string, string) {
	if !submissionIsLatest {
		return "invalid", "superseded_submission"
	}
	if !revisionMatches {
		return "invalid", "target_revision_changed"
	}
	return "valid", ""
}
