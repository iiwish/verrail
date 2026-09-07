import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests, heartbeatRuns, verrailAgentDefinitions, verrailAgentVersions,
  verrailDeploymentRevisions, verrailExecutionLeases, verrailRunAttempts, verrailRuns, type Db,
} from "@paperclipai/db";

export interface NativeWorkspaceBinding {
  workspaceId: string;
  agentId: string;
  compatibilityAgentId: string | null;
  runId: string;
  attemptId: string;
  deploymentRevisionId: string;
  agentVersionId: string;
  revisionAgentVersionId: string;
  executorPrincipalId: string;
  runtimeProfile: string;
  leaseStatus: string;
  leaseGraceExpiresAt: Date;
  attemptStatus: string;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
  wakeIdempotencyKey: string | null;
  runtimeConfig: Record<string, unknown>;
}

export function validateNativeWorkspaceBinding(
  row: NativeWorkspaceBinding | null,
  input: { workspaceId: string; agentId: string; attemptId: string; runId: string },
) {
  if (!row || row.workspaceId !== input.workspaceId || row.agentId !== input.agentId
    || row.compatibilityAgentId !== input.agentId || row.attemptId !== input.attemptId || row.runId !== input.runId
    || row.agentVersionId !== row.revisionAgentVersionId
    || row.requestedByActorType !== "system" || row.requestedByActorId !== "verrail-host-runner"
    || row.wakeIdempotencyKey !== `verrail-run-attempt:${input.attemptId}`
    || row.executorPrincipalId !== "verrail-host-runner" || row.runtimeProfile !== "host_trusted"
    || !["pending", "running"].includes(row.attemptStatus)
    || !["active", "suspect"].includes(row.leaseStatus)
    || !(row.leaseGraceExpiresAt.getTime() > Date.now())) {
    throw new Error("NATIVE_WORKSPACE_BINDING_INVALID: trusted Run/Attempt/wakeup binding is required");
  }
  const cwd = row.runtimeConfig.cwd;
  if (typeof cwd !== "string" || !cwd.trim() || !path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new Error("NATIVE_WORKSPACE_UNCONFIGURED: DeploymentRevision requires an absolute local cwd");
  }
  return { cwd, deploymentRevisionId: row.deploymentRevisionId, agentVersionId: row.agentVersionId };
}

export async function resolveNativeRunWorkspace(
  db: Db,
  input: { heartbeatRunId: string; workspaceId: string; agentId: string; context: Record<string, unknown> },
) {
  const attemptId = input.context.verrailRunAttemptId;
  if (typeof attemptId !== "string" || !attemptId) return null;
  const runId = input.context.verrailRunId;
  if (typeof runId !== "string" || input.context.issueId || input.context.taskId) {
    throw new Error("NATIVE_WORKSPACE_BINDING_INVALID: native Run identity is required without a legacy Issue");
  }
  // Runtime settings come from the immutable revision, never wake payload config.
  const rows = await db.select({
    workspaceId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    compatibilityAgentId: verrailAgentDefinitions.compatibilityAgentId,
    runId: verrailRuns.id,
    attemptId: verrailRunAttempts.id,
    deploymentRevisionId: verrailDeploymentRevisions.id,
    agentVersionId: verrailRunAttempts.agentVersionId,
    revisionAgentVersionId: verrailDeploymentRevisions.agentVersionId,
    executorPrincipalId: verrailRunAttempts.executorPrincipalId,
    runtimeProfile: verrailRunAttempts.runtimeProfile,
    leaseStatus: verrailExecutionLeases.status,
    leaseGraceExpiresAt: verrailExecutionLeases.graceExpiresAt,
    attemptStatus: verrailRunAttempts.status,
    requestedByActorType: agentWakeupRequests.requestedByActorType,
    requestedByActorId: agentWakeupRequests.requestedByActorId,
    wakeIdempotencyKey: agentWakeupRequests.idempotencyKey,
    runtimeConfig: verrailDeploymentRevisions.runtimeConfig,
  }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
      eq(agentWakeupRequests.companyId, heartbeatRuns.companyId),
      eq(agentWakeupRequests.agentId, heartbeatRuns.agentId),
      eq(agentWakeupRequests.runId, heartbeatRuns.id),
    ))
    .innerJoin(verrailRunAttempts, and(eq(verrailRunAttempts.id, attemptId), eq(verrailRunAttempts.workspaceId, heartbeatRuns.companyId)))
    .innerJoin(verrailRuns, and(
      eq(verrailRuns.id, verrailRunAttempts.runId), eq(verrailRuns.workspaceId, verrailRunAttempts.workspaceId),
      eq(verrailRuns.deploymentRevisionId, verrailRunAttempts.deploymentRevisionId),
      eq(verrailRuns.agentVersionId, verrailRunAttempts.agentVersionId),
    ))
    .innerJoin(verrailExecutionLeases, and(
      eq(verrailExecutionLeases.runAttemptId, verrailRunAttempts.id), eq(verrailExecutionLeases.workspaceId, verrailRunAttempts.workspaceId),
      eq(verrailExecutionLeases.fencingToken, verrailRunAttempts.fencingToken),
      eq(verrailExecutionLeases.executorPrincipalId, verrailRunAttempts.executorPrincipalId),
      eq(verrailExecutionLeases.runtimeProfile, verrailRunAttempts.runtimeProfile),
    ))
    .innerJoin(verrailDeploymentRevisions, and(eq(verrailDeploymentRevisions.id, verrailRunAttempts.deploymentRevisionId), eq(verrailDeploymentRevisions.workspaceId, verrailRunAttempts.workspaceId)))
    .innerJoin(verrailAgentVersions, and(eq(verrailAgentVersions.id, verrailRunAttempts.agentVersionId), eq(verrailAgentVersions.workspaceId, verrailRunAttempts.workspaceId)))
    .innerJoin(verrailAgentDefinitions, and(eq(verrailAgentDefinitions.id, verrailAgentVersions.agentDefinitionId), eq(verrailAgentDefinitions.workspaceId, verrailRunAttempts.workspaceId)))
    .where(and(eq(heartbeatRuns.id, input.heartbeatRunId), eq(heartbeatRuns.companyId, input.workspaceId), eq(heartbeatRuns.agentId, input.agentId)));
  const binding = validateNativeWorkspaceBinding(rows[0] ?? null, {...input, attemptId, runId});
  const cwd = await realpath(binding.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("NATIVE_WORKSPACE_INVALID: cwd must be an existing directory");
  const manifest = { schemaVersion: 1, source: "deployment_revision", ...binding,
    workspaceId: input.workspaceId, heartbeatRunId: input.heartbeatRunId, agentId: input.agentId, runId, attemptId,
    requestedCwd: binding.cwd, cwd };
  return { ...manifest, contentHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
}
