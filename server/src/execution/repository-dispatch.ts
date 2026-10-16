import { createHash } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { verrailRepositoryDispatches as dispatches, type Db } from "@paperclipai/db";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import { z } from "zod";
import { createRepositoryLeaseValidator } from "./repository-lease.js";
import { validateRepositoryResult } from "./repository-result.js";

export function createRepositoryDispatchStore(db: Db, rawControllerId: string) {
  const controllerId = z.string().uuid().parse(rawControllerId);
  const identity = (raw: RepositoryExecutionRequest) => {
    const request = repositoryExecutionRequestSchema.parse(raw);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    return { request, hash };
  };
  const active = (r: RepositoryExecutionRequest, hash: string) => and(
    eq(dispatches.runAttemptId, r.runAttemptId), eq(dispatches.workspaceId, r.workspaceId),
    eq(dispatches.runId, r.runId), eq(dispatches.leaseId, r.leaseId), eq(dispatches.fencingToken, r.fencingToken),
    eq(dispatches.controllerId, controllerId), eq(dispatches.requestHash, hash),
    eq(dispatches.status, "dispatched"), gt(dispatches.controllerExpiresAt, sql`clock_timestamp()`),
  );
  async function authorize(raw: RepositoryExecutionRequest, signal: AbortSignal) {
    const { request, hash } = identity(raw);
    await createRepositoryLeaseValidator(db)(request, signal);
    const rows = await db.select({ id: dispatches.runAttemptId }).from(dispatches).where(active(request, hash)).limit(1);
    signal.throwIfAborted();
    if (rows.length !== 1) throw new Error("REPOSITORY_DISPATCH_NOT_ACTIVE");
  }
  return {
    // Commit intent before invoking the harness. A conflict never authorizes a
    // second invocation, including identical inputs after an ambiguous response.
    async claim(raw: RepositoryExecutionRequest, signal: AbortSignal): Promise<boolean> {
      const { request, hash } = identity(raw);
      await createRepositoryLeaseValidator(db)(request, signal);
      const rows = await db.insert(dispatches).values({ runAttemptId: request.runAttemptId,
        workspaceId: request.workspaceId, runId: request.runId, leaseId: request.leaseId,
        fencingToken: request.fencingToken, controllerId, requestHash: hash, input: request,
        controllerExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
      }).onConflictDoNothing({ target: dispatches.runAttemptId }).returning({ id: dispatches.runAttemptId });
      signal.throwIfAborted();
      return rows.length === 1;
    },
    authorize,
    async finishSucceeded(raw: RepositoryExecutionRequest, output: unknown, signal: AbortSignal) {
      const { request, hash } = identity(raw);
      const result = validateRepositoryResult(output, request);
      await createRepositoryLeaseValidator(db)(request, signal);
      const rows = await db.update(dispatches).set({ status: "succeeded", result,
        finishedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(active(request, hash)).returning({ id: dispatches.runAttemptId });
      signal.throwIfAborted();
      if (rows.length !== 1) throw new Error("REPOSITORY_DISPATCH_NOT_ACTIVE");
    },
    // A canceled dispatch is a durable cleanup receipt, not Run authority.
    // Serialize with Go cancellation/recovery before recording that receipt.
    async finishCancellation(raw: RepositoryExecutionRequest, signal: AbortSignal): Promise<boolean> {
      const { request: r, hash } = identity(raw);
      signal.throwIfAborted();
      return db.transaction(async tx => {
        const rows = await tx.execute(sql`select lease.id from verrail_execution_leases lease
          join verrail_run_attempts attempt on attempt.id=lease.run_attempt_id and attempt.workspace_id=lease.workspace_id
          join verrail_runs run on run.id=attempt.run_id and run.workspace_id=attempt.workspace_id
          where lease.id=${r.leaseId} and lease.workspace_id=${r.workspaceId} and lease.run_id=run.id
            and run.id=${r.runId} and attempt.id=${r.runAttemptId}
            and run.target_id=${r.targetId} and run.target_revision_id=${r.targetRevisionId}
            and run.graph_revision_id=${r.graphRevisionId} and run.work_node_id=${r.workNodeId}
            and run.agent_version_id=${r.agentVersionId} and run.deployment_revision_id=${r.deploymentRevisionId}
            and attempt.agent_version_id=run.agent_version_id and attempt.deployment_revision_id=run.deployment_revision_id
            and attempt.attempt_number=run.attempt_count
            and lease.fencing_token=${r.fencingToken} and attempt.fencing_token=lease.fencing_token
            and lease.status='active' and lease.expires_at > clock_timestamp()
            and run.status='cancel_requested' and run.cancel_requested_at is not null
            and attempt.status in ('cancel_requested','cancel_acknowledged')
            and attempt.runtime_profile='repository_sandbox' and lease.runtime_profile=attempt.runtime_profile
            and attempt.executor_principal_type='service' and attempt.executor_principal_id='verrail-repository-runner'
            and lease.executor_principal_id=attempt.executor_principal_id
          for update of run,attempt,lease`);
        signal.throwIfAborted();
        if (rows.length !== 1) return false;
        const finished = await tx.update(dispatches).set({ status: "canceled", errorCode: "REPOSITORY_CANCELED",
          finishedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
          .where(active(r, hash)).returning({ id: dispatches.runAttemptId });
        signal.throwIfAborted();
        if (finished.length !== 1) throw new Error("REPOSITORY_DISPATCH_NOT_ACTIVE");
        return true;
      });
    },
    // Call only after runtime cleanup has settled. This is transport status,
    // never an acknowledgement of Go Run cancellation or acceptance.
    async finishFailure(raw: RepositoryExecutionRequest, status: "failed", signal: AbortSignal) {
      const { request, hash } = identity(raw);
      signal.throwIfAborted();
      const outcome = z.literal("failed").parse(status);
      const rows = await db.update(dispatches).set({ status: outcome,
        errorCode: "REPOSITORY_EXECUTION_FAILED",
        finishedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
        .where(active(request, hash)).returning({ id: dispatches.runAttemptId });
      signal.throwIfAborted();
      if (rows.length !== 1) throw new Error("REPOSITORY_DISPATCH_NOT_ACTIVE");
    },
    async renew(raw: RepositoryExecutionRequest, signal: AbortSignal) {
      const { request, hash } = identity(raw);
      await createRepositoryLeaseValidator(db)(request, signal);
      const rows = await db.update(dispatches).set({ controllerExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
        updatedAt: sql`clock_timestamp()` }).where(active(request, hash)).returning({ id: dispatches.runAttemptId });
      signal.throwIfAborted();
      if (rows.length !== 1) throw new Error("REPOSITORY_DISPATCH_NOT_ACTIVE");
    },
    async consumeToolCall(raw: RepositoryExecutionRequest, signal: AbortSignal) {
      const { request, hash } = identity(raw);
      await db.transaction(async tx => {
        // Serialize admission with Go cancellation and lease transitions.
        await tx.execute(sql`select lease.id from verrail_execution_leases lease
          join verrail_run_attempts attempt on attempt.id=lease.run_attempt_id and attempt.workspace_id=lease.workspace_id
          join verrail_runs run on run.id=attempt.run_id and run.workspace_id=attempt.workspace_id
          where lease.id=${request.leaseId} and lease.workspace_id=${request.workspaceId}
          for update of run, attempt, lease`);
        await createRepositoryLeaseValidator(tx)(request, signal);
        const rows = await tx.update(dispatches).set({ toolCalls: sql`${dispatches.toolCalls} + 1`, updatedAt: sql`clock_timestamp()` })
          .where(and(active(request, hash), lt(dispatches.toolCalls, 20))).returning({ id: dispatches.runAttemptId });
        signal.throwIfAborted();
        if (rows.length !== 1) throw new Error("REPOSITORY_DISPATCH_OR_BUDGET_REJECTED");
      });
    },
  };
}
