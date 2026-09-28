import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";

// Read-only execution gate. The Go engine remains the owner of claims, renewal,
// terminal transitions and fencing. Dispatch must separately bind the full input.
// All phases continue an admitted Run: archive is presentation metadata, and
// deployment pause blocks new Runs in Go rather than revoking their pinned versions.
export function createRepositoryLeaseValidator(db: Pick<Db, "execute">) {
  return createPhaseValidator(db, "running");
}

export function createRepositoryOfferedLeaseValidator(db: Pick<Db, "execute">) {
  return createPhaseValidator(db, "offered");
}

export function createRepositoryClaimedLeaseValidator(db: Pick<Db, "execute">) {
  return createPhaseValidator(db, "claimed");
}

function createPhaseValidator(db: Pick<Db, "execute">, phase: "running" | "offered" | "claimed") {
  const state = phase === "running"
    ? sql`lease.status='active' and attempt.status='running' and run.status='running'`
    : phase === "offered"
      ? sql`lease.status='offered' and attempt.status='pending' and run.status='queued'`
      : sql`lease.status='active' and attempt.status='pending' and run.status='queued'`;
  return async (raw: RepositoryExecutionRequest, signal: AbortSignal): Promise<void> => {
    const r = repositoryExecutionRequestSchema.parse(raw);
    signal.throwIfAborted();
    const rows = await db.execute(sql`
      select lease.id from verrail_execution_leases lease
      join verrail_run_attempts attempt on attempt.id=lease.run_attempt_id
        and attempt.run_id=lease.run_id and attempt.workspace_id=lease.workspace_id
      join verrail_runs run on run.id=attempt.run_id and run.workspace_id=attempt.workspace_id
      join verrail_work_nodes node on node.id=run.work_node_id and node.workspace_id=run.workspace_id
        and node.graph_revision_id=run.graph_revision_id and node.target_id=run.target_id
      join verrail_graph_revisions graph on graph.id=run.graph_revision_id and graph.workspace_id=run.workspace_id
        and graph.target_id=run.target_id and graph.target_revision_id=run.target_revision_id
      join verrail_work_graphs work_graph on work_graph.id=graph.work_graph_id
        and work_graph.workspace_id=run.workspace_id and work_graph.target_id=run.target_id
      join verrail_targets target on target.id=run.target_id and target.workspace_id=run.workspace_id
      join verrail_deployment_revisions revision on revision.id=run.deployment_revision_id
        and revision.workspace_id=run.workspace_id and revision.agent_version_id=run.agent_version_id
      join verrail_deployments deployment on deployment.id=revision.deployment_id
        and deployment.workspace_id=run.workspace_id
      join verrail_agent_versions version on version.id=run.agent_version_id
        and version.workspace_id=run.workspace_id and version.agent_definition_id=deployment.agent_definition_id
      where lease.id=${r.leaseId} and lease.workspace_id=${r.workspaceId}
        and run.id=${r.runId} and attempt.id=${r.runAttemptId}
        and run.target_id=${r.targetId} and run.target_revision_id=${r.targetRevisionId}
        and run.graph_revision_id=${r.graphRevisionId} and run.work_node_id=${r.workNodeId}
        and run.agent_version_id=${r.agentVersionId} and run.deployment_revision_id=${r.deploymentRevisionId}
        and attempt.agent_version_id=run.agent_version_id and attempt.deployment_revision_id=run.deployment_revision_id
        and attempt.attempt_number=run.attempt_count
        and lease.fencing_token=${r.fencingToken} and attempt.fencing_token=lease.fencing_token
        and lease.executor_principal_id='verrail-repository-runner'
        and attempt.executor_principal_id=lease.executor_principal_id and attempt.executor_principal_type='service'
        and lease.runtime_profile='repository_sandbox' and attempt.runtime_profile=lease.runtime_profile
        and ${state} and lease.expires_at > clock_timestamp()
        and run.cancel_requested_at is null
        and node.status='running' and node.kind='agent_task' and run.kind='agent'
        and graph.status='active' and work_graph.status='active' and work_graph.active_graph_revision_id=graph.id
        and target.active_target_revision_id=run.target_revision_id
        and target.status not in ('canceled', 'accepted')
        and deployment.status in ('active', 'paused') and revision.state in ('active', 'superseded')
        and version.runtime=${r.runtime} and version.model=${r.model}
      limit 1
    `);
    signal.throwIfAborted();
    if (rows.length !== 1) throw new Error("REPOSITORY_LEASE_LOST");
  };
}
