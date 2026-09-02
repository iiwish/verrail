package target

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestUpdateAgentDefinitionTracksExplicitNullDescription(t *testing.T) {
	var input UpdateAgentDefinitionInput
	if err := json.Unmarshal([]byte(`{"description":null}`), &input); err != nil {
		t.Fatal(err)
	}
	if !input.DescriptionPresent || input.Description != nil {
		t.Fatal("expected explicit null description to be preserved")
	}
	if err := ValidateUpdateDefinitionInput(&input); err != nil {
		t.Fatalf("expected description-only update to validate, got %v", err)
	}
}

func TestPassingEvaluationRequiresPassingSafety(t *testing.T) {
	input := EvaluationRunInput{
		CandidateAgentVersionID: "11111111-1111-4111-8111-111111111111",
		Status:                  "passed",
		SafetyStatus:            "failed",
	}
	if err := ValidateEvaluationInput(&input); err == nil {
		t.Fatal("expected safety gate validation error")
	}
}

func TestAgentTaskRequiresDeploymentRevisionIdentity(t *testing.T) {
	completion := "produce a reviewed change"
	command := CreateGraphRevisionCommand{
		WorkspaceID:    "11111111-1111-4111-8111-111111111111",
		TargetID:       "22222222-2222-4222-8222-222222222222",
		Principal:      Principal{Type: "user", ID: "local-board"},
		IdempotencyKey: "graph.identity.1",
		Input: CreateGraphRevisionInput{
			ExpectedTargetRevisionID: "33333333-3333-4333-8333-333333333333",
			Nodes: []WorkNodeInput{{
				NodeKey:              "execute",
				Kind:                 "agent_task",
				Stage:                "execute",
				Title:                "Execute",
				CompletionDefinition: &completion,
				ResponsiblePrincipal: &ResponsiblePrincipal{PrincipalType: "agent", PrincipalID: "mutable-agent-id"},
			}},
		},
	}
	if err := ValidateCreateGraphRevisionCommand(&command); err == nil {
		t.Fatal("expected DeploymentRevision UUID validation error")
	}
	command.Input.Nodes[0].ResponsiblePrincipal.PrincipalID = "44444444-4444-4444-8444-444444444444"
	if err := ValidateCreateGraphRevisionCommand(&command); err != nil {
		t.Fatalf("expected valid DeploymentRevision identity, got %v", err)
	}
}

func TestDeploymentRevisionGateRejectsRetiredDeployment(t *testing.T) {
	actions := []string{"pause", "resume", "upgrade", "rollback", "set_default", "retire"}
	for _, action := range actions {
		t.Run(action, func(t *testing.T) {
			err := deploymentRevisionGate(action, "retired")
			var lifecycleErr *Error
			if !errors.As(err, &lifecycleErr) {
				t.Fatalf("expected *Error for %q on retired Deployment, got %v", action, err)
			}
			if lifecycleErr.Status != 409 {
				t.Fatalf("expected HTTP 409 for %q on retired Deployment, got %d", action, lifecycleErr.Status)
			}
			if lifecycleErr.Code != "DEPLOYMENT_RETIRED" {
				t.Fatalf("expected code DEPLOYMENT_RETIRED for %q, got %q", action, lifecycleErr.Code)
			}
		})
	}
}

func TestDeploymentRevisionGateAllowsNonRetiredStatuses(t *testing.T) {
	actions := []string{"pause", "resume", "upgrade", "rollback", "set_default", "retire"}
	for _, action := range actions {
		for _, status := range []string{"active", "paused"} {
			if err := deploymentRevisionGate(action, status); err != nil {
				t.Fatalf("expected %q on %q Deployment to pass the retired gate, got %v", action, status, err)
			}
		}
	}
}

type lifecycleTestHarness struct {
	t            *testing.T
	store        *Store
	workspaceID  string
	principalID  string
	receiptKeys  []string
	aggregateIDs []string
	revisionIDs  []string
}

func newLifecycleTestHarness(t *testing.T, pool *pgxpool.Pool) *lifecycleTestHarness {
	t.Helper()
	var workspaceID string
	err := pool.QueryRow(context.Background(), `select id from companies where status='active' order by created_at limit 1`).Scan(&workspaceID)
	if err != nil {
		t.Skipf("no seeded active workspace for lifecycle test: %v", err)
	}
	principalID := "lifecycle-guard-test-user"
	_, err = pool.Exec(context.Background(), `
		insert into company_memberships (company_id, principal_type, principal_id, status, membership_role)
		values ($1, 'user', $2, 'active', 'member')
	`, workspaceID, principalID)
	require.NoError(t, err)
	return &lifecycleTestHarness{t: t, store: NewStore(pool), workspaceID: workspaceID, principalID: principalID}
}

func buildLifecycleCommand[T any](h *lifecycleTestHarness, commandType string, resourceID string, input T) AgentLifecycleCommand[T] {
	h.t.Helper()
	idempotencyKey := "lifecycle-it-" + mustNewUUID(h.t)
	h.receiptKeys = append(h.receiptKeys, idempotencyKey)
	command := AgentLifecycleCommand[T]{
		WorkspaceID:    h.workspaceID,
		ResourceID:     resourceID,
		Principal:      Principal{Type: "user", ID: h.principalID},
		IdempotencyKey: idempotencyKey,
		CommandType:    commandType,
		Input:          input,
	}
	if err := ValidateAgentLifecycleCommand(&command); err != nil {
		h.t.Fatalf("validate %s command: %v", commandType, err)
	}
	return command
}

func (h *lifecycleTestHarness) trackAggregate(id string) {
	h.aggregateIDs = append(h.aggregateIDs, id)
}

func (h *lifecycleTestHarness) createDefinition() string {
	h.t.Helper()
	result, err := h.store.CreateAgentDefinition(context.Background(), buildLifecycleCommand(h, "agent_definition.create.v1", "", AgentDefinitionInput{
		Name:        "lifecycle-guard-test-" + mustNewUUID(h.t)[:8],
		Description: ptr("definition used by the retired-deployment guard integration test"),
	}))
	require.NoError(h.t, err)
	h.trackAggregate(result.ResourceID)
	return result.ResourceID
}

func (h *lifecycleTestHarness) publishVersion(definitionID, prompt string) string {
	h.t.Helper()
	result, err := h.store.PublishAgentVersion(context.Background(), buildLifecycleCommand(h, "agent_version.publish.v1", definitionID, PublishAgentVersionInput{
		Runtime: "test-runtime",
		Model:   "test-model",
		Prompt:  prompt,
	}))
	require.NoError(h.t, err)
	h.trackAggregate(result.ResourceID)
	return result.ResourceID
}

func (h *lifecycleTestHarness) recordPassingEvaluation(versionID string) string {
	h.t.Helper()
	result, err := h.store.RecordEvaluationRun(context.Background(), buildLifecycleCommand(h, "evaluation_run.record.v1", "", EvaluationRunInput{
		CandidateAgentVersionID: versionID,
		Status:                  "passed",
		SafetyStatus:            "passed",
	}))
	require.NoError(h.t, err)
	h.trackAggregate(result.ResourceID)
	return result.ResourceID
}

func (h *lifecycleTestHarness) createDeployment(definitionID, versionID, evaluationID, name string) string {
	h.t.Helper()
	result, err := h.store.CreateDeployment(context.Background(), buildLifecycleCommand(h, "deployment.create.v1", "", CreateDeploymentInput{
		AgentDefinitionID: definitionID,
		AgentVersionID:    versionID,
		EvaluationRunID:   evaluationID,
		Name:              name,
	}))
	require.NoError(h.t, err)
	h.trackAggregate(result.ResourceID)
	return result.ResourceID
}

func (h *lifecycleTestHarness) revise(action string, deploymentID string, input ReviseDeploymentInput) (AgentLifecycleResult, error) {
	h.t.Helper()
	input.Action = action
	command := buildLifecycleCommand(h, "deployment.revise.v1", deploymentID, input)
	if err := ValidateReviseDeploymentInput(&command.Input); err != nil {
		h.t.Fatalf("validate deployment.%s input: %v", action, err)
	}
	return h.store.ReviseDeployment(context.Background(), command)
}

func (h *lifecycleTestHarness) deploymentStatus(deploymentID string) string {
	h.t.Helper()
	var status string
	if err := h.store.pool.QueryRow(context.Background(), `select status from verrail_deployments where id=$1`, deploymentID).Scan(&status); err != nil {
		h.t.Fatalf("read deployment status: %v", err)
	}
	return status
}

func (h *lifecycleTestHarness) firstRevisionID(deploymentID string) string {
	h.t.Helper()
	var revisionID string
	if err := h.store.pool.QueryRow(context.Background(), `select id from verrail_deployment_revisions where deployment_id=$1 order by revision_number asc limit 1`, deploymentID).Scan(&revisionID); err != nil {
		h.t.Fatalf("read first deployment revision: %v", err)
	}
	h.revisionIDs = append(h.revisionIDs, revisionID)
	return revisionID
}

func (h *lifecycleTestHarness) cleanup(pool *pgxpool.Pool) {
	ctx := context.Background()
	cleanups := []func(){
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_deployment_revisions where deployment_id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_deployments where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_evaluation_runs where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_versions where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_definitions where id = any($1::uuid[])`, h.aggregateIDs)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from company_memberships where company_id=$1 and principal_id=$2`, h.workspaceID, h.principalID)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_agent_command_receipts where workspace_id=$1 and principal_id=$2 and idempotency_key = any($3)`, h.workspaceID, h.principalID, h.receiptKeys)
		},
		func() {
			_, _ = pool.Exec(ctx, `delete from verrail_audit_events where workspace_id=$1 and principal_id=$2 and aggregate_id = any($3::uuid[])`, h.workspaceID, h.principalID, h.aggregateIDs)
		},
	}
	for _, cleanup := range cleanups {
		cleanup()
	}
}

func mustNewUUID(t *testing.T) string {
	t.Helper()
	id, err := NewUUID()
	require.NoError(t, err)
	return id
}

func ptr[T any](value T) *T { return &value }

func requireLifecycleCode(t *testing.T, err error, code string) {
	t.Helper()
	require.Error(t, err)
	var lifecycleErr *Error
	require.True(t, errors.As(err, &lifecycleErr), "expected *Error with code %q, got %T: %v", code, err, err)
	require.Equal(t, code, lifecycleErr.Code)
}

func TestReviseDeploymentRetiredGuardIntegration(t *testing.T) {
	databaseURL := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	require.NoError(t, err)
	defer pool.Close()

	harness := newLifecycleTestHarness(t, pool)
	defer harness.cleanup(pool)

	definitionID := harness.createDefinition()
	versionOne := harness.publishVersion(definitionID, "prompt one for the retired-deployment guard test")
	evaluationOne := harness.recordPassingEvaluation(versionOne)
	deploymentA := harness.createDeployment(definitionID, versionOne, evaluationOne, "guard-test-a")
	versionTwo := harness.publishVersion(definitionID, "prompt two for the retired-deployment guard test")
	evaluationTwo := harness.recordPassingEvaluation(versionTwo)
	deploymentB := harness.createDeployment(definitionID, versionTwo, evaluationTwo, "guard-test-b")

	t.Run("fresh deployment accepts pause upgrade rollback set_default", func(t *testing.T) {
		_, err := harness.revise("pause", deploymentA, ReviseDeploymentInput{})
		require.NoError(t, err)
		require.Equal(t, "paused", harness.deploymentStatus(deploymentA))

		_, err = harness.revise("upgrade", deploymentA, ReviseDeploymentInput{
			AgentVersionID:  &versionTwo,
			EvaluationRunID: &evaluationTwo,
		})
		require.NoError(t, err)
		require.Equal(t, "active", harness.deploymentStatus(deploymentA))

		_, err = harness.revise("rollback", deploymentA, ReviseDeploymentInput{
			SourceDeploymentRevisionID: ptr(harness.firstRevisionID(deploymentA)),
		})
		require.NoError(t, err)
		require.Equal(t, "active", harness.deploymentStatus(deploymentA))

		_, err = harness.revise("set_default", deploymentA, ReviseDeploymentInput{})
		require.NoError(t, err)
		require.Equal(t, "active", harness.deploymentStatus(deploymentA))
	})

	t.Run("pause on paused and resume semantics unchanged", func(t *testing.T) {
		_, err := harness.revise("pause", deploymentA, ReviseDeploymentInput{})
		require.NoError(t, err)
		require.Equal(t, "paused", harness.deploymentStatus(deploymentA))

		_, err = harness.revise("pause", deploymentA, ReviseDeploymentInput{})
		require.NoError(t, err, "pausing an already-paused Deployment must keep succeeding")
		require.Equal(t, "paused", harness.deploymentStatus(deploymentA))

		_, err = harness.revise("resume", deploymentA, ReviseDeploymentInput{})
		require.NoError(t, err)
		require.Equal(t, "active", harness.deploymentStatus(deploymentA))

		_, err = harness.revise("resume", deploymentA, ReviseDeploymentInput{})
		requireLifecycleCode(t, err, "DEPLOYMENT_NOT_PAUSED")
	})

	t.Run("retired deployment rejects every revision action", func(t *testing.T) {
		_, err := harness.revise("retire", deploymentB, ReviseDeploymentInput{})
		require.NoError(t, err)
		require.Equal(t, "retired", harness.deploymentStatus(deploymentB))

		actions := []struct {
			name  string
			input ReviseDeploymentInput
		}{
			{"pause", ReviseDeploymentInput{}},
			{"resume", ReviseDeploymentInput{}},
			{"upgrade", ReviseDeploymentInput{AgentVersionID: &versionOne, EvaluationRunID: &evaluationOne}},
			{"rollback", ReviseDeploymentInput{SourceDeploymentRevisionID: ptr(harness.firstRevisionID(deploymentB))}},
			{"set_default", ReviseDeploymentInput{}},
			{"retire", ReviseDeploymentInput{}},
		}
		for _, action := range actions {
			t.Run(action.name, func(t *testing.T) {
				_, err := harness.revise(action.name, deploymentB, action.input)
				requireLifecycleCode(t, err, "DEPLOYMENT_RETIRED")
			})
		}
		require.Equal(t, "retired", harness.deploymentStatus(deploymentB), "no action may resurrect a retired Deployment")
	})
}
