package target

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newExplicitProofAdmissionFixture(t *testing.T, h *connectorTestHarness) RecordIntegrationRunInput {
	t.Helper()
	targetID, revisionID := h.createTarget()
	var criterionID string
	require.NoError(t, h.pool.QueryRow(context.Background(), `select acceptance_criteria->0->>'id' from verrail_target_revisions where id=$1`, revisionID).Scan(&criterionID))
	contract := CriterionProofContract{SchemaVersion: 1, AllOf: []CriterionProofRequirement{{ID: "technical", Kind: "independent_verification", Phase: "pre_acceptance", Assertions: []string{"live Codex execution", "independent CI passes"}}}}
	command := ReviseTargetProofCommand{WorkspaceID: h.workspaceID, TargetID: targetID, Principal: Principal{Type: "user", ID: h.principalID}, IdempotencyKey: "admission-revise-" + mustNewUUID(t), Input: ReviseTargetProofInput{ExpectedTargetRevisionID: revisionID, Criteria: []CriterionProofChange{{CriterionID: criterionID, ProofContract: contract}}}}
	require.NoError(t, ValidateReviseTargetProofCommand(&command))
	revised, err := h.store.ReviseTargetProof(context.Background(), command)
	require.NoError(t, err)
	fixture := h.provisionTaskForTarget("integration_task", targetID, revised.TargetRevisionID)
	input := h.integrationRunInput(fixture, "ci/"+mustNewUUID(t), "success", assuranceTestHash, "ci:admission")
	input.ProofContext = &CriterionProofContext{RequirementID: "technical"}
	input.ProviderReceipt["criterionProof"] = map[string]any{
		"contractHash": proofHash(contract), "requirementId": "technical", "assertions": contract.AllOf[0].Assertions,
		"targetRevisionId": revised.TargetRevisionID, "graphRevisionId": fixture.graphRevisionID, "commitRef": input.CommitRef,
		"verifiedAt": time.Now().UTC().Format(time.RFC3339Nano), "providerRunId": input.ExternalRef, "providerAttempt": 1,
	}
	return input
}

func proofAdmissionSnapshot(t *testing.T, h *connectorTestHarness) map[string]string {
	t.Helper()
	snapshot := map[string]string{}
	for _, table := range []string{"verrail_evidence", "verrail_verification_results", "verrail_integration_runs", "verrail_criterion_proofs", "verrail_integration_attempts", "verrail_agent_command_receipts", "verrail_audit_events", "verrail_claims", "verrail_work_nodes", "verrail_targets", "verrail_work_graphs", "verrail_outbox_events"} {
		var digest string
		require.NoError(t, h.pool.QueryRow(context.Background(), `select md5(coalesce(jsonb_agg(to_jsonb(fact) order by fact.id),'[]'::jsonb)::text) from `+table+` fact where workspace_id=$1`, h.workspaceID).Scan(&digest))
		snapshot[table] = digest
	}
	return snapshot
}

func TestGenericIntegrationProofAdmissionIntegration(t *testing.T) {
	url := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	defer pool.Close()
	h := newConnectorTestHarness(t, pool)
	defer h.cleanup(pool)
	defer func() {
		_, _ = pool.Exec(ctx, `delete from verrail_criterion_proofs where workspace_id=$1`, h.workspaceID)
	}()
	h.createCIConnection()

	for _, scenario := range []struct {
		name, principalType, principalID        string
		omitContext, omitCoverage, emptyContext bool
	}{
		{name: "service copied compound coverage", principalType: "service", principalID: "arbitrary-service"},
		{name: "spoofed verifier service name", principalType: "service", principalID: "verrail/github-fixed-ci-reader"},
		{name: "human copied compound coverage", principalType: "user", principalID: h.principalID},
		{name: "forged empty proof context", principalType: "service", principalID: "arbitrary-service", emptyContext: true},
		{name: "explicit contract without context", principalType: "service", principalID: "arbitrary-service", omitContext: true, omitCoverage: true},
		{name: "coverage without context", principalType: "service", principalID: "arbitrary-service", omitContext: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			input := newExplicitProofAdmissionFixture(t, h)
			if scenario.emptyContext {
				input.ProofContext = &CriterionProofContext{}
			}
			if scenario.omitContext {
				input.ProofContext = nil
			}
			if scenario.omitCoverage {
				delete(input.ProviderReceipt, "criterionProof")
			}
			command := buildConnectorResultCommandAs(h, scenario.principalType, scenario.principalID, ConnectorIntegrationRunRecordCommand, input)
			before := proofAdmissionSnapshot(t, h)
			result, err := h.store.RecordIntegrationRun(ctx, command)
			if err == nil {
				h.runIDs = append(h.runIDs, result.ResourceID)
			}
			assert.Error(t, err, "generic ingress cannot authenticate an independent verifier")
			if err != nil {
				assert.Equal(t, "CRITERION_PROOF_VERIFIER_REQUIRED", AsError(err).Code)
				assert.Equal(t, 403, AsError(err).Status)
			}
			assert.Equal(t, before, proofAdmissionSnapshot(t, h), "denial must append no facts, audit, receipt or outbox and change no state")
		})
	}

	t.Run("historical explicit receipt cannot bypass admission", func(t *testing.T) {
		input := newExplicitProofAdmissionFixture(t, h)
		command := buildConnectorResultCommandAs(h, "service", "historical-verifier", ConnectorIntegrationRunRecordCommand, input)
		// Only this test fixture can create the historical explicit proof chain.
		historical, err := recordTrustedIntegrationProofFixture(ctx, h.store, command)
		require.NoError(t, err)
		h.runIDs = append(h.runIDs, historical.ResourceID)
		before := proofAdmissionSnapshot(t, h)
		_, err = h.store.RecordIntegrationRun(ctx, command)
		assert.Error(t, err)
		if err != nil {
			assert.Equal(t, "CRITERION_PROOF_VERIFIER_REQUIRED", AsError(err).Code)
		}
		assert.Equal(t, before, proofAdmissionSnapshot(t, h), "historical facts remain unchanged on denied replay")
	})

	t.Run("omitted context cannot replay an injected generic receipt", func(t *testing.T) {
		input := newExplicitProofAdmissionFixture(t, h)
		input.ProofContext = nil
		delete(input.ProviderReceipt, "criterionProof")
		command := buildConnectorResultCommandAs(h, "service", "arbitrary-service", ConnectorIntegrationRunRecordCommand, input)
		response, err := json.Marshal(AgentLifecycleResult{SchemaVersion: 1, ResourceType: "integration_run", ResourceID: mustNewUUID(t)})
		require.NoError(t, err)
		// An adversarial isolated fixture, not a claim that this is valid history.
		_, err = pool.Exec(ctx, `insert into verrail_agent_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,response) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, mustNewUUID(t), h.workspaceID, command.Principal.Type, command.Principal.ID, command.CommandType, command.IdempotencyKey, command.RequestHash, response)
		require.NoError(t, err)
		before := proofAdmissionSnapshot(t, h)
		_, err = h.store.RecordIntegrationRun(ctx, command)
		requireLifecycleCode(t, err, "CRITERION_PROOF_VERIFIER_REQUIRED")
		require.Equal(t, before, proofAdmissionSnapshot(t, h))
	})

	for _, criterionKey := range []string{"", "unknown-criterion"} {
		t.Run("unknown or absent criterion cannot replay: "+criterionKey, func(t *testing.T) {
			input := newExplicitProofAdmissionFixture(t, h)
			input.ProofContext = nil
			delete(input.ProviderReceipt, "criterionProof")
			input.CriterionKey = criterionKey
			command := buildConnectorResultCommandAs(h, "service", "arbitrary-service", ConnectorIntegrationRunRecordCommand, input)
			response, err := json.Marshal(AgentLifecycleResult{SchemaVersion: 1, ResourceType: "integration_run", ResourceID: mustNewUUID(t)})
			require.NoError(t, err)
			_, err = pool.Exec(ctx, `insert into verrail_agent_command_receipts(id,workspace_id,principal_type,principal_id,command_type,idempotency_key,request_hash,response) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, mustNewUUID(t), h.workspaceID, command.Principal.Type, command.Principal.ID, command.CommandType, command.IdempotencyKey, command.RequestHash, response)
			require.NoError(t, err)
			before := proofAdmissionSnapshot(t, h)
			_, err = h.store.RecordIntegrationRun(ctx, command)
			requireLifecycleCode(t, err, "TARGET_COMMAND_INVALID")
			require.Equal(t, before, proofAdmissionSnapshot(t, h))
		})
	}

	t.Run("legacy criterion cannot carry reserved proof coverage", func(t *testing.T) {
		input := h.integrationRunInput(h.provisionTask("integration_task"), "legacy/"+mustNewUUID(t), "success", assuranceTestHash, "ci:legacy-reserved")
		input.ProviderReceipt["criterionProof"] = nil
		command := buildConnectorResultCommandAs(h, "service", "legacy-connector", ConnectorIntegrationRunRecordCommand, input)
		before := proofAdmissionSnapshot(t, h)
		_, err = h.store.RecordIntegrationRun(ctx, command)
		requireLifecycleCode(t, err, "CRITERION_PROOF_VERIFIER_REQUIRED")
		require.Equal(t, before, proofAdmissionSnapshot(t, h))
	})

	t.Run("test-only explicit writer rolls back all facts after late constraint failure", func(t *testing.T) {
		legacyInput := h.integrationRunInput(h.provisionTask("integration_task"), "legacy/"+mustNewUUID(t), "success", assuranceTestHash, "ci:rollback-fixture")
		legacy, err := h.recordIntegrationRun(legacyInput)
		require.NoError(t, err)
		input := newExplicitProofAdmissionFixture(t, h)
		command := buildConnectorResultCommandAs(h, "service", "fixture-verifier", ConnectorIntegrationRunRecordCommand, input)
		// An isolated fixture reserves the attempt key so the actual writer fails
		// after appending Evidence, VerificationResult, IntegrationRun and proof.
		_, err = pool.Exec(ctx, `update verrail_integration_attempts set idempotency_key=$1 where integration_run_id=$2`, command.IdempotencyKey, legacy.ResourceID)
		require.NoError(t, err)
		before := proofAdmissionSnapshot(t, h)
		_, err = recordTrustedIntegrationProofFixture(ctx, h.store, command)
		require.ErrorContains(t, err, "insert IntegrationAttempt")
		require.Equal(t, before, proofAdmissionSnapshot(t, h), "a late write failure rolls back the entire proof transaction")
	})

	for _, principal := range []Principal{{Type: "service", ID: "legacy-connector"}, {Type: "user", ID: h.principalID}} {
		t.Run("legacy no-contract "+principal.Type+" ingestion and replay remain compatible", func(t *testing.T) {
			fixture := h.provisionTask("integration_task")
			input := h.integrationRunInput(fixture, "legacy/"+mustNewUUID(t), "success", assuranceTestHash, "ci:legacy")
			command := buildConnectorResultCommandAs(h, principal.Type, principal.ID, ConnectorIntegrationRunRecordCommand, input)
			result, err := h.store.RecordIntegrationRun(ctx, command)
			require.NoError(t, err)
			h.runIDs = append(h.runIDs, result.ResourceID)
			before := proofAdmissionSnapshot(t, h)
			replay, err := h.store.RecordIntegrationRun(ctx, command)
			require.NoError(t, err)
			require.True(t, replay.Replayed)
			require.Equal(t, result.ResourceID, replay.ResourceID)
			require.Equal(t, before, proofAdmissionSnapshot(t, h))
			for _, changed := range []string{"criterion", "target", "revision", "valid legacy binding"} {
				altered := command
				switch changed {
				case "criterion":
					altered.Input.CriterionKey = "unknown-criterion"
				case "target":
					altered.Input.TargetID = mustNewUUID(t)
				case "revision":
					altered.Input.TargetRevisionID = mustNewUUID(t)
				case "valid legacy binding":
					next := h.provisionTask("integration_task")
					altered.Input = h.integrationRunInput(next, "legacy/"+mustNewUUID(t), "success", assuranceTestHash, "ci:altered-binding")
				}
				require.NoError(t, ValidateResultLifecycleCommand(&altered))
				before := proofAdmissionSnapshot(t, h)
				_, err = h.store.RecordIntegrationRun(ctx, altered)
				require.Error(t, err, "substituted %s cannot replay another binding", changed)
				if changed == "valid legacy binding" {
					requireLifecycleCode(t, err, "TARGET_IDEMPOTENCY_CONFLICT")
				}
				require.Equal(t, before, proofAdmissionSnapshot(t, h))
			}
		})
	}
}
