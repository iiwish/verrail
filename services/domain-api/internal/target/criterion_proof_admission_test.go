package target

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGenericIntegrationProofAdmissionRejectsCallerCoverageBeforeDatabase(t *testing.T) {
	for _, principal := range []Principal{{Type: "user", ID: "owner"}, {Type: "service", ID: "arbitrary"}, {Type: "service", ID: "verrail/github-fixed-ci-reader"}, {Type: "agent", ID: "executor"}} {
		for _, input := range []RecordIntegrationRunInput{
			{ProofContext: &CriterionProofContext{RequirementID: "technical"}},
			{ProviderReceipt: map[string]any{"criterionProof": map[string]any{"assertions": []string{"ts_tests", "live_codex"}}}},
			{ProviderReceipt: map[string]any{"criterionProof": nil}},
		} {
			command := AgentLifecycleCommand[RecordIntegrationRunInput]{Principal: principal, Input: input}
			_, err := (&Store{}).RecordIntegrationRun(context.Background(), command)
			requireLifecycleCode(t, err, "CRITERION_PROOF_VERIFIER_REQUIRED")
			require.Equal(t, 403, AsError(err).Status)
		}
	}
}
