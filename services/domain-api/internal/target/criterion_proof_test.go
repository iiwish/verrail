package target

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCriterionProofContract(t *testing.T) {
	legacy := AcceptanceCriterion{ID: "criterion", Title: "Delivery"}
	encoded, err := json.Marshal(legacy)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"criterion","title":"Delivery","description":null}`, string(encoded))
	contract := &CriterionProofContract{SchemaVersion: 1, AllOf: []CriterionProofRequirement{
		{ID: "technical", Kind: "independent_verification", Phase: "pre_acceptance", Assertions: []string{"recovery", "secret-handling"}},
		{ID: "governance", Kind: "human_governance", Phase: "post_governance"},
		{ID: "effect", Kind: "pull_request_effect", Phase: "post_effect"},
		{ID: "recovery", Kind: "independent_verification", Phase: "post_effect", Assertions: []string{"recovery", "secret-handling"}},
	}}
	require.NoError(t, ValidateCriterionProofContract(contract))
	for _, mutate := range []func(*CriterionProofContract){
		func(c *CriterionProofContract) { c.SchemaVersion = 2 },
		func(c *CriterionProofContract) { c.AllOf = nil },
		func(c *CriterionProofContract) { c.AllOf[1].ID = c.AllOf[0].ID },
		func(c *CriterionProofContract) { c.AllOf[0].Assertions = nil },
		func(c *CriterionProofContract) { c.AllOf[1].Phase = "pre_acceptance" },
		func(c *CriterionProofContract) { c.AllOf[2].Assertions = []string{"receipt-is-not-a-scan"} },
	} {
		raw, _ := json.Marshal(contract)
		var invalid CriterionProofContract
		require.NoError(t, json.Unmarshal(raw, &invalid))
		mutate(&invalid)
		require.Error(t, ValidateCriterionProofContract(&invalid))
	}
}

func TestReviseTargetProofCommandIdentity(t *testing.T) {
	command := ReviseTargetProofCommand{WorkspaceID: "00000000-0000-4000-8000-000000000001", TargetID: "00000000-0000-4000-8000-000000000002", Principal: Principal{Type: "user", ID: "owner"}, IdempotencyKey: "proof-revision-1", Input: ReviseTargetProofInput{ExpectedTargetRevisionID: "00000000-0000-4000-8000-000000000003", Criteria: []CriterionProofChange{{CriterionID: "criterion", ProofContract: CriterionProofContract{SchemaVersion: 1, AllOf: []CriterionProofRequirement{{ID: "technical", Kind: "independent_verification", Phase: "pre_acceptance", Assertions: []string{"creation-entry"}}}}}}}}
	require.NoError(t, ValidateReviseTargetProofCommand(&command))
	require.Len(t, command.RequestHash, 64)
	command.Principal.Type = "service"
	require.Error(t, ValidateReviseTargetProofCommand(&command))
}
