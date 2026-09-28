package target

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

type CriterionProofRequirement struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"`
	Phase      string   `json:"phase"`
	Assertions []string `json:"assertions,omitempty"`
}
type CriterionProofContract struct {
	SchemaVersion int                         `json:"schemaVersion"`
	AllOf         []CriterionProofRequirement `json:"allOf"`
}
type CriterionProofChange struct {
	CriterionID   string                 `json:"criterionId"`
	ProofContract CriterionProofContract `json:"proofContract"`
}
type ReviseTargetProofInput struct {
	ExpectedTargetRevisionID string                 `json:"expectedTargetRevisionId"`
	Criteria                 []CriterionProofChange `json:"criteria"`
}
type ReviseTargetProofCommand struct {
	WorkspaceID, TargetID       string
	Principal                   Principal
	IdempotencyKey, RequestHash string
	Input                       ReviseTargetProofInput
}
type ReviseTargetProofResult struct {
	SchemaVersion    int    `json:"schemaVersion"`
	TargetID         string `json:"targetId"`
	TargetRevisionID string `json:"targetRevisionId"`
	RevisionNumber   int    `json:"revisionNumber"`
	Replayed         bool   `json:"replayed"`
}
type CriterionProofContext struct {
	RequirementID   string  `json:"requirementId"`
	SubmissionID    *string `json:"submissionId,omitempty"`
	EffectReceiptID *string `json:"effectReceiptId,omitempty"`
}

func ValidateCriterionProofContract(contract *CriterionProofContract) error {
	if contract == nil {
		return nil
	}
	if contract.SchemaVersion != 1 || len(contract.AllOf) < 1 || len(contract.AllOf) > 10 {
		return validation("proofContract requires schemaVersion 1 and 1 to 10 mandatory requirements")
	}
	seen := map[string]bool{}
	phases := map[string]bool{}
	for _, requirement := range contract.AllOf {
		if requirement.ID == "" || len(requirement.ID) > 100 || !idempotencyKeyPattern.MatchString(requirement.ID) || seen[requirement.ID] {
			return validation("proof requirement IDs must be unique safe identifiers")
		}
		seen[requirement.ID] = true
		switch requirement.Kind {
		case "independent_verification":
			if requirement.Phase != "pre_acceptance" && requirement.Phase != "post_effect" || phases[requirement.Phase] {
				return validation("one independent verification requirement is allowed per phase")
			}
			phases[requirement.Phase] = true
			if len(requirement.Assertions) < 1 || len(requirement.Assertions) > 20 {
				return validation("independent verification must name every required assertion")
			}
			assertions := map[string]bool{}
			for _, assertion := range requirement.Assertions {
				if strings.TrimSpace(assertion) == "" || len(assertion) > 1000 || assertions[assertion] {
					return validation("assertions must be nonempty bounded unique entries")
				}
				assertions[assertion] = true
			}
		case "human_governance":
			if requirement.Phase != "post_governance" || requirement.Assertions != nil {
				return validation("human governance requires its fixed post-governance facts")
			}
		case "pull_request_effect":
			if requirement.Phase != "post_effect" || requirement.Assertions != nil {
				return validation("pull request effect requires a post-effect receipt")
			}
		default:
			return validation("unknown proof requirement kind")
		}
	}
	return nil
}
func ValidateReviseTargetProofCommand(command *ReviseTargetProofCommand) error {
	if err := validateCommandIdentity(command.WorkspaceID, command.TargetID, command.Principal, command.IdempotencyKey); err != nil {
		return err
	}
	if !uuidPattern.MatchString(command.Input.ExpectedTargetRevisionID) || len(command.Input.Criteria) < 1 || len(command.Input.Criteria) > 20 {
		return validation("expectedTargetRevisionId and criterion proof changes are required")
	}
	seen := map[string]bool{}
	for index := range command.Input.Criteria {
		change := &command.Input.Criteria[index]
		if change.CriterionID == "" || len(change.CriterionID) > 100 || seen[change.CriterionID] {
			return validation("criterion IDs must be unique and bounded")
		}
		seen[change.CriterionID] = true
		if err := ValidateCriterionProofContract(&change.ProofContract); err != nil {
			return err
		}
	}
	payload := map[string]any{"targetId": command.TargetID, "input": command.Input}
	command.RequestHash = proofHash(payload)
	return nil
}
func proofHash(value any) string {
	raw, _ := json.Marshal(value)
	var canonical any
	_ = json.Unmarshal(raw, &canonical)
	raw, _ = json.Marshal(canonical)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func ValidateCriterionProofContext(context *CriterionProofContext) error {
	if context == nil {
		return nil
	}
	if context.RequirementID == "" || len(context.RequirementID) > 100 || !idempotencyKeyPattern.MatchString(context.RequirementID) {
		return validation("proofContext requirementId is invalid")
	}
	if (context.SubmissionID == nil) != (context.EffectReceiptID == nil) {
		return validation("late proof requires both Submission and EffectReceipt")
	}
	for _, id := range []*string{context.SubmissionID, context.EffectReceiptID} {
		if id != nil && !uuidPattern.MatchString(*id) {
			return validation("proofContext identities must be UUIDs")
		}
	}
	return nil
}
