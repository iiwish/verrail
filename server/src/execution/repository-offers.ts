import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { z } from "zod";

const offerSchema = z.object({
  runAttemptId: z.string().uuid(), runId: z.string().uuid(), targetId: z.string().uuid(),
  targetRevisionId: z.string().uuid(), graphRevisionId: z.string().uuid(), workNodeId: z.string().uuid(),
  leaseId: z.string().uuid(),
  fencingToken: z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)])
    .pipe(z.number().int().positive().max(2_147_483_647)),
  agentVersionId: z.string().uuid(), deploymentRevisionId: z.string().uuid(),
});

// Discovery is not authority to execute. Resolve an immutable source and apply
// the full offered-lease gate before sending a Go claim event.
export async function listOfferedRepositoryAttempts(options: {
  db: Pick<Db, "execute">; workspaceId: string; after?: string; limit?: number; signal: AbortSignal;
}) {
  const workspaceId = z.string().uuid().parse(options.workspaceId);
  const after = z.string().uuid().optional().parse(options.after);
  const limit = z.number().int().min(1).max(100).parse(options.limit ?? 20);
  options.signal.throwIfAborted();
  const rows = await options.db.execute(sql`
    select attempt.id as "runAttemptId", run.id as "runId", run.target_id as "targetId",
      run.target_revision_id as "targetRevisionId", run.graph_revision_id as "graphRevisionId",
      run.work_node_id as "workNodeId", lease.id as "leaseId", lease.fencing_token as "fencingToken",
      run.agent_version_id as "agentVersionId", run.deployment_revision_id as "deploymentRevisionId"
    from verrail_run_attempts attempt
    join verrail_runs run on run.id=attempt.run_id and run.workspace_id=attempt.workspace_id
    join verrail_execution_leases lease on lease.run_attempt_id=attempt.id
      and lease.run_id=run.id and lease.workspace_id=attempt.workspace_id
    where attempt.workspace_id=${workspaceId} and attempt.status='pending' and run.status='queued'
      and run.kind='agent' and run.cancel_requested_at is null
      and attempt.attempt_number=run.attempt_count
      and attempt.agent_version_id=run.agent_version_id and attempt.deployment_revision_id=run.deployment_revision_id
      and lease.status='offered' and lease.expires_at > clock_timestamp()
      and lease.fencing_token=attempt.fencing_token
      and attempt.runtime_profile='repository_sandbox' and lease.runtime_profile=attempt.runtime_profile
      and attempt.executor_principal_type='service' and attempt.executor_principal_id='verrail-repository-runner'
      and lease.executor_principal_id=attempt.executor_principal_id
      and not exists (select 1 from verrail_repository_dispatches dispatch where dispatch.run_attempt_id=attempt.id)
      ${after ? sql`and attempt.id > ${after}::uuid` : sql``}
    order by attempt.id limit ${limit}
  `);
  options.signal.throwIfAborted();
  return z.array(offerSchema).parse(rows);
}
