package target

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"os"
	"testing"
)

func TestAgentActivationIntegration(t *testing.T) {
	url := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	defer pool.Close()
	h := newLifecycleTestHarness(t, pool)
	defer h.cleanup(pool)
	definition := h.createDefinition()
	v1 := h.publishVersion(definition, "version one")
	e1 := h.recordPassingEvaluation(v1)
	deployment := h.createDeployment(definition, v1, e1, "sole-runtime")
	var primary bool
	require.NoError(t, pool.QueryRow(ctx, `select is_primary from verrail_deployments where id=$1`, deployment).Scan(&primary))
	require.True(t, primary)
	_, err = h.store.CreateDeployment(ctx, buildLifecycleCommand(h, "deployment.create.v1", "", CreateDeploymentInput{AgentDefinitionID: definition, AgentVersionID: v1, EvaluationRunID: e1, Name: "duplicate"}))
	requireLifecycleCode(t, err, "AGENT_DEPLOYMENT_EXISTS")
	v2 := h.publishVersion(definition, "version two")
	e2 := h.recordPassingEvaluation(v2)
	original := h.firstRevisionID(deployment)
	activate := ReviseDeploymentInput{Action: "activate", AgentVersionID: &v2, EvaluationRunID: &e2, ExpectedDeploymentRevisionID: &original, ExpectedPrimaryDeploymentID: deployment}
	require.NoError(t, ValidateReviseDeploymentInput(&activate))
	// Concurrent updates observing the same revision cannot both commit.
	results := make(chan error, 2)
	for range 2 {
		command := buildLifecycleCommand(h, "deployment.revise.v1", deployment, activate)
		go func() { _, err := h.store.ReviseDeployment(ctx, command); results <- err }()
	}
	first, second := <-results, <-results
	if first == nil {
		requireLifecycleCode(t, second, "AGENT_REVISION_CONFLICT")
	} else {
		require.NoError(t, second)
		requireLifecycleCode(t, first, "AGENT_REVISION_CONFLICT")
	}
	var revision, activeVersion string
	require.NoError(t, pool.QueryRow(ctx, `select id,agent_version_id from verrail_deployment_revisions where deployment_id=$1 order by revision_number desc limit 1`, deployment).Scan(&revision, &activeVersion))
	require.Equal(t, v2, activeVersion)
	_, err = h.revise("upgrade", deployment, ReviseDeploymentInput{AgentVersionID: &v1, EvaluationRunID: &e1})
	requireLifecycleCode(t, err, "AGENT_ACTIVATION_REQUIRED")
	// Rollback is a new revision referencing immutable v1, not an edit of v1 or the draft.
	rollback, err := h.revise("activate", deployment, ReviseDeploymentInput{AgentVersionID: &v1, EvaluationRunID: &e1, ExpectedDeploymentRevisionID: &revision, ExpectedPrimaryDeploymentID: deployment})
	require.NoError(t, err)
	require.NotEqual(t, original, rollback.ResourceID)
	var originalVersion string
	require.NoError(t, pool.QueryRow(ctx, `select agent_version_id from verrail_deployment_revisions where id=$1`, original).Scan(&originalVersion))
	require.Equal(t, v1, originalVersion)
	// Simulate pre-migration rows without choosing a primary automatically.
	_, err = pool.Exec(ctx, `update verrail_deployments set is_primary=false where id=$1`, deployment)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `select id from verrail_deployment_revisions where deployment_id=$1 order by revision_number desc limit 1`, deployment).Scan(&revision))
	_, err = h.revise("activate", deployment, ReviseDeploymentInput{AgentVersionID: &v2, EvaluationRunID: &e2, ExpectedDeploymentRevisionID: &revision, ExpectedPrimaryDeploymentID: deployment})
	requireLifecycleCode(t, err, "AGENT_BINDING_CONFLICT")
	_, err = h.revise("activate", deployment, ReviseDeploymentInput{AgentVersionID: &v2, EvaluationRunID: &e2, ExpectedDeploymentRevisionID: &revision, ExpectedPrimaryDeploymentID: "none"})
	requireLifecycleCode(t, err, "AGENT_BINDING_CONFLICT")
	fresh := h.createDeployment(definition, v2, e2, "sole-runtime")
	require.NotEqual(t, deployment, fresh)
	var status string
	var isDefault bool
	require.NoError(t, pool.QueryRow(ctx, `select status,is_default from verrail_deployments where id=$1`, deployment).Scan(&status, &isDefault))
	require.Equal(t, "retired", status)
	require.False(t, isDefault)
	require.NoError(t, pool.QueryRow(ctx, `select agent_version_id from verrail_deployment_revisions where id=$1`, original).Scan(&originalVersion))
	require.Equal(t, v1, originalVersion)
}

func TestActivationRequiresObservedRevisionAndBinding(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	input := ReviseDeploymentInput{Action: "activate", AgentVersionID: &id, EvaluationRunID: &id}
	require.Error(t, ValidateReviseDeploymentInput(&input))
	input.ExpectedDeploymentRevisionID = &id
	input.ExpectedPrimaryDeploymentID = "none"
	require.NoError(t, ValidateReviseDeploymentInput(&input))
	input.ExpectedPrimaryDeploymentID = "arbitrary"
	require.Error(t, ValidateReviseDeploymentInput(&input))
}

func TestDirectorRuntimeActivationIntegration(t *testing.T) {
	url := os.Getenv("VERRAIL_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("VERRAIL_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	defer pool.Close()
	for _, runtime := range []string{"opencode", "codex", "claude"} {
		t.Run(runtime, func(t *testing.T) {
			h := newLifecycleTestHarness(t, pool)
			defer h.cleanup(pool)
			definition := h.createDefinition()
			published, err := h.store.PublishAgentVersion(ctx, buildLifecycleCommand(h, "agent_version.publish.v1", definition, PublishAgentVersionInput{
				Runtime: runtime, Model: "fixture/test", Prompt: "Read the conversation context",
				SupplyChain: map[string]any{"source": "saved_agent_configuration.v2", "mode": "director_chat"},
			}))
			require.NoError(t, err)
			h.trackAggregate(published.ResourceID)
			evaluation := h.recordPassingEvaluation(published.ResourceID)
			deployment := h.createDeployment(definition, published.ResourceID, evaluation, "director-runtime")
			var pinnedRuntime string
			var config map[string]any
			require.NoError(t, pool.QueryRow(ctx, `select v.runtime,r.runtime_config from verrail_deployment_revisions r join verrail_agent_versions v on v.id=r.agent_version_id where r.deployment_id=$1`, deployment).Scan(&pinnedRuntime, &config))
			require.Equal(t, runtime, pinnedRuntime)
			require.Empty(t, config, "conversation runtimes do not require a host working directory")
		})
	}
}
