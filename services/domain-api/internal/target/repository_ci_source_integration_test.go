package target

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// Database boundary fixture only: domain transitions and artifact registration
// are real; repository runtime, storage bytes and provider observations are not.
func seedRepositoryCIIntegration(t *testing.T, pool *pgxpool.Pool, assertions []string) *fixedCIIntegrationFixture {
	return seedRepositoryCIIntegrationWithReceipt(t, pool, assertions, nil)
}

func seedRepositoryCIIntegrationWithReceipt(t *testing.T, pool *pgxpool.Pool, assertions []string, enhance func(*repositoryCISourceProjection, *repositoryCIOutputReceipt)) *fixedCIIntegrationFixture {
	t.Helper()
	if assertions == nil {
		assertions = []string{"ts_tests", "ts_typecheck", "ts_build", "go_tests"}
	}
	f := seedProofIntegration(t, pool, false, assertions)
	ctx := context.Background()
	t.Cleanup(func() {
		for _, table := range []string{"verrail_repository_dispatches", "verrail_run_sources"} {
			_, err := pool.Exec(ctx, "delete from "+table+" where workspace_id=$1", f.profile.WorkspaceID)
			require.NoError(t, err)
		}
	})
	facts, _, receipt := repositoryCIFixture(t)
	facts.Identity = repositoryCIIdentity{WorkspaceID: f.profile.WorkspaceID, TargetID: f.profile.TargetID,
		TargetRevisionID: f.profile.TargetRevisionID, GraphRevisionID: f.profile.GraphRevisionID,
		WorkNodeID: f.sourceNodeID, RunID: f.input.Source.RunID, RunAttemptID: f.input.Source.RunAttemptID,
		LeaseID: f.event.Input.LeaseID, FencingToken: int64(f.event.Input.FencingToken),
		AgentVersionID: f.identity["agentVersionId"].(string), DeploymentRevisionID: f.identity["deploymentRevisionId"].(string)}
	facts.ContentRef = "storage:" + f.profile.WorkspaceID + "/verrail/run-artifacts/sha256/" + facts.ContentHash
	receipt.Identity = facts.Identity
	receipt.Artifacts[0].ContentRef = facts.ContentRef
	receipt.Artifacts[0].SourceSnapshot.SourceContentSHA256 = f.input.Mapping.SourceContentSHA256
	receipt.Artifacts[0].SourceSnapshot.SnapshotTree = f.input.Mapping.SourceSnapshotTreeSHA
	receipt.SourceBefore.Manifest.ContentSHA256 = f.input.Mapping.SourceContentSHA256
	receipt.SourceAfter.Manifest.ContentSHA256 = f.input.Mapping.SourceContentSHA256
	seedArtifact := func(artifactID, revisionID, kind, hash string) {
		_, err := pool.Exec(ctx, `insert into verrail_artifacts(id,workspace_id,target_id,kind,title,created_by_principal_type,created_by_principal_id)
			values($1,$2,$3,$4,'Repository CI synthetic input','user',$5)`, artifactID, f.profile.WorkspaceID, f.profile.TargetID, kind, f.principalID)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, `insert into verrail_artifact_revisions(id,workspace_id,artifact_id,revision_number,content_hash,content_ref,created_by_principal_type,created_by_principal_id)
			values($1,$2,$3,1,$4,$5,'user',$6)`, revisionID, f.profile.WorkspaceID, artifactID, hash,
			"storage:"+f.profile.WorkspaceID+"/verrail/run-artifacts/sha256/"+hash, f.principalID)
		require.NoError(t, err)
	}
	seedArtifact(receipt.InputSource.ArtifactID, mustNewUUID(t), "code_change", receipt.InputSource.ContentHash)
	seedArtifact(mustNewUUID(t), facts.SourceBinding.RepositorySourceRevisionID, "report", facts.SourceBinding.ProvenanceContentHash)
	_, err := pool.Exec(ctx, `insert into verrail_run_sources(run_id,workspace_id,repository_source_revision_id) values($1,$2,$3)`,
		f.input.Source.RunID, f.profile.WorkspaceID, facts.SourceBinding.RepositorySourceRevisionID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `update verrail_agent_versions set runtime='opencode',model=$2 where id=$1`, facts.Identity.AgentVersionID, facts.Model)
	require.NoError(t, err)
	for _, table := range []string{"verrail_run_attempts", "verrail_execution_leases"} {
		_, err = pool.Exec(ctx, "update "+table+" set runtime_profile='repository_sandbox',executor_principal_id=$3 where workspace_id=$1 and run_id=$2",
			f.profile.WorkspaceID, f.input.Source.RunID, fixedCIRepositoryExecutor)
		require.NoError(t, err)
	}
	var request map[string]any
	require.NoError(t, json.Unmarshal(facts.DispatchInput, &request))
	identityBytes, err := json.Marshal(facts.Identity)
	require.NoError(t, err)
	var identity map[string]any
	require.NoError(t, json.Unmarshal(identityBytes, &identity))
	for key, value := range identity {
		request[key] = value
	}
	facts.DispatchInput, err = json.Marshal(request)
	require.NoError(t, err)
	var typedRequest repositoryCIRequest
	require.NoError(t, decodeRepositoryCIJSON(facts.DispatchInput, &typedRequest))
	facts.RequestHash, err = repositoryCIRequestHash(typedRequest)
	require.NoError(t, err)
	receipt.RequestSHA256, receipt.ExecutionFacts.RequestSHA256 = facts.RequestHash, facts.RequestHash
	if enhance != nil {
		enhance(&facts, &receipt)
	}
	repositoryCIProject(t, &facts, &f.input, receipt)
	_, err = pool.Exec(ctx, `insert into verrail_repository_dispatches(run_attempt_id,workspace_id,run_id,lease_id,fencing_token,controller_id,request_hash,input,status,result,controller_expires_at,finished_at)
		values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'succeeded',$9::jsonb,now(),now())`, f.input.Source.RunAttemptID, f.profile.WorkspaceID, f.input.Source.RunID,
		facts.Identity.LeaseID, facts.Identity.FencingToken, mustNewUUID(t), facts.RequestHash, string(facts.DispatchInput), string(facts.DispatchResult))
	require.NoError(t, err)
	var output repositoryCIOutput
	require.NoError(t, json.Unmarshal(facts.DispatchResult, &output))
	f.event.Principal.ID = fixedCIRepositoryExecutor
	f.event.Input.Payload = map[string]any{"repositoryOutput": output}
	f.event.Input.Artifacts = []RunArtifactInput{{Title: facts.Title, Kind: "code_change", ContentHash: facts.ContentHash, ContentRef: facts.ContentRef}}
	require.NoError(t, ValidateReportRunEventCommand(&f.event))
	result, err := f.lifecycle.store.ReportRunEvent(ctx, f.event)
	require.NoError(t, err)
	require.True(t, result.Authoritative)
	require.NoError(t, pool.QueryRow(ctx, `select id,content_hash from verrail_run_events where run_attempt_id=$1 and event_type='succeeded'`, f.input.Source.RunAttemptID).
		Scan(&f.input.Source.RunEventID, &f.input.Source.RunEventContentHash))
	require.NoError(t, pool.QueryRow(ctx, `select id from verrail_artifact_revisions where workspace_id=$1 and source_run_id=$2`, f.profile.WorkspaceID, f.input.Source.RunID).
		Scan(&f.input.ArtifactRevisionID))
	return f
}

func TestRepositoryCIAdmissionAtomicIntegration(t *testing.T) {
	pool := fixedCIIntegrationPool(t)
	f := seedRepositoryCIIntegration(t, pool, nil)
	verifier, err := NewFixedCIProofVerifier(f.lifecycle.store, f.profile)
	require.NoError(t, err)
	before := f.counts()
	result, err := verifier.Record(context.Background(), f.profile.WorkspaceID, "repository-ci-record", f.input)
	require.NoError(t, err)
	require.False(t, result.Replayed)
	after := f.counts()
	for table, count := range after {
		require.Equal(t, before[table]+1, count, table)
	}
	replayed, err := verifier.Record(context.Background(), f.profile.WorkspaceID, "repository-ci-record", f.input)
	require.NoError(t, err)
	require.True(t, replayed.Replayed)
	require.Equal(t, result.ResourceID, replayed.ResourceID)
	require.Equal(t, after, f.counts())
	_, err = pool.Exec(context.Background(), `update verrail_repository_dispatches set error_code='untrusted' where run_attempt_id=$1`, f.input.Source.RunAttemptID)
	require.NoError(t, err)
	_, err = verifier.Record(context.Background(), f.profile.WorkspaceID, "repository-ci-record", f.input)
	requireLifecycleCode(t, err, "FIXED_CI_PROOF_CONTEXT_MISMATCH")
	require.Equal(t, after, f.counts(), "source revalidation precedes historical replay")
}

func TestRepositoryCIProjectionDatabaseDenialsIntegration(t *testing.T) {
	pool := fixedCIIntegrationPool(t)
	f := seedRepositoryCIIntegration(t, pool, nil)
	ctx := context.Background()
	before := f.counts()
	cases := map[string]string{
		"runtime":                     `update verrail_agent_versions set runtime='claude_local' where workspace_id=$1`,
		"executor":                    `update verrail_run_attempts set executor_principal_id='verrail-host-runner' where workspace_id=$1`,
		"profile":                     `update verrail_run_attempts set runtime_profile='host_trusted' where workspace_id=$1`,
		"native executor pair":        `update verrail_run_attempts set runtime_profile='host_trusted',executor_principal_id='verrail-host-runner' where workspace_id=$1`,
		"latest attempt":              `update verrail_runs set attempt_count=attempt_count+1 where workspace_id=$1`,
		"run state":                   `update verrail_runs set status='failed' where workspace_id=$1`,
		"node state":                  `update verrail_work_nodes set status='blocked' where workspace_id=$1 and kind='agent_task'`,
		"lease":                       `update verrail_execution_leases set status='revoked' where workspace_id=$1`,
		"lease fence":                 `update verrail_execution_leases set fencing_token=fencing_token+1 where workspace_id=$1`,
		"dispatch failed":             `update verrail_repository_dispatches set status='failed' where workspace_id=$1`,
		"dispatch hash":               `update verrail_repository_dispatches set request_hash=repeat('0',64) where workspace_id=$1`,
		"dispatch instructions drift": `update verrail_repository_dispatches set input=jsonb_set(input,'{instructions}','"Changed after signing"') where workspace_id=$1`,
		"dispatch timeout drift":      `update verrail_repository_dispatches set input=jsonb_set(input,'{timeoutSeconds}','61') where workspace_id=$1`,
		"dispatch result":             `update verrail_repository_dispatches set result='{}'::jsonb where workspace_id=$1`,
		"bound source absent":         `delete from verrail_run_sources where workspace_id=$1`,
		"bound report hash":           `update verrail_artifact_revisions set content_hash=repeat('0',64) where workspace_id=$1 and id in (select repository_source_revision_id from verrail_run_sources where workspace_id=$1)`,
		"input source storage":        `update verrail_artifact_revisions set content_ref='unbound' where workspace_id=$1 and source_run_id is null and artifact_id in (select id from verrail_artifacts where workspace_id=$1 and kind='code_change')`,
		"output provenance":           `update verrail_artifact_revisions set created_by_principal_id='foreign' where workspace_id=$1 and source_run_id is not null`,
		"audit absent":                `delete from verrail_audit_events where workspace_id=$1 and event_type='assurance.artifact_revision_added.v1'`,
		"audit extra payload field":   `update verrail_audit_events set payload=payload||'{"untrusted":true}' where workspace_id=$1 and event_type='assurance.artifact_revision_added.v1'`,
		"audit numeric string":        `update verrail_audit_events set payload=jsonb_set(payload,'{fencingToken}',to_jsonb(payload->>'fencingToken')) where workspace_id=$1 and event_type='assurance.artifact_revision_added.v1'`,
		"additional malformed audit": `insert into verrail_audit_events(id,workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,idempotency_key,payload)
		 select gen_random_uuid(),workspace_id,principal_type,principal_id,event_type,aggregate_type,aggregate_id,'extra-invalid-audit','{}'::jsonb
		 from verrail_audit_events where workspace_id=$1 and event_type='assurance.artifact_revision_added.v1'`,
		"additional succeeded event": `insert into verrail_run_events(id,workspace_id,run_id,run_attempt_id,cursor,fencing_token,event_type,payload,content_hash,emitted_at)
		 select gen_random_uuid(),workspace_id,run_id,run_attempt_id,cursor+1,fencing_token,event_type,'{}'::jsonb,content_hash,emitted_at
		 from verrail_run_events where workspace_id=$1 and event_type='succeeded'`,
	}
	for name, statement := range cases {
		t.Run(name, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			require.NoError(t, err)
			defer func() { require.NoError(t, tx.Rollback(ctx)) }()
			changed, err := tx.Exec(ctx, statement, f.profile.WorkspaceID)
			if name == "profile" || name == "executor" {
				var constraint *pgconn.PgError
				require.ErrorAs(t, err, &constraint)
				require.Equal(t, "23514", constraint.Code)
				require.Equal(t, "verrail_run_attempts_repository_executor_check", constraint.ConstraintName)
				return
			}
			require.NoError(t, err)
			require.Positive(t, changed.RowsAffected())
			_, err = validateFixedCISource(ctx, tx, f.profile, f.input)
			requireLifecycleCode(t, err, "FIXED_CI_PROOF_CONTEXT_MISMATCH")
		})
	}
	require.Equal(t, before, f.counts(), "rejected projections and rolled-back mutations leave no authority rows")
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	contentHash, err := validateFixedCISource(ctx, tx, f.profile, f.input)
	require.NoError(t, err)
	require.Equal(t, strings.Repeat("7", 64), contentHash)
}

func TestRepositoryCICannotSatisfyExistingNativeDeliveryKindsIntegration(t *testing.T) {
	pool := fixedCIIntegrationPool(t)
	for kind, assertions := range map[string][]string{
		"feishu_target":   {"真实飞书消息经明确确认创建版本化 Target，并返回可追踪回复", "保留 callback、事件、会话和回复的脱敏 Provider 标识"},
		"codex_execution": {"Codex 执行绑定版本、运行、环境、日志、成本与权限，并产生内容寻址工件", "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult"},
	} {
		t.Run(kind, func(t *testing.T) {
			f := seedRepositoryCIIntegration(t, pool, assertions)
			verifier, err := NewFixedCIProofVerifier(f.lifecycle.store, f.profile)
			require.NoError(t, err)
			before := f.counts()
			ctx := context.Background()
			tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
			require.NoError(t, err)
			_, _, err = verifier.admitForRequirement(ctx, tx, agentCommandMeta{}, f.input, kind)
			requireLifecycleCode(t, err, "FIXED_CI_PROOF_CONTEXT_MISMATCH")
			require.NoError(t, tx.Rollback(ctx))
			require.Equal(t, before, f.counts())
		})
	}
}
