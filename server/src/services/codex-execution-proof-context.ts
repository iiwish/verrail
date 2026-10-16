import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type Db, companies, agents, heartbeatRuns, agentWakeupRequests, verrailTargets, verrailTargetRevisions,
  verrailWorkGraphs, verrailGraphRevisions, verrailWorkNodes, verrailRuns, verrailRunAttempts, verrailRunEvents,
  verrailExecutionLeases, verrailAgentDefinitions, verrailAgentVersions, verrailDeployments, verrailDeploymentRevisions,
} from "@paperclipai/db";
import { BILLING_TYPES, COST_STATUSES } from "@paperclipai/shared/constants";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { HttpError, conflict } from "../errors.js";
import { validateNativeOutputReceipt, NATIVE_OUTPUT_CONTEXT_KEY } from "./verrail-native-output.js";
import type { RunLogStore } from "./run-log-store.js";
import { NATIVE_DISPATCH_CONTEXT_KEY, validateNativeDispatchConfiguration } from "./verrail-native-dispatch.js";
import { NATIVE_PERMISSION_CONTEXT_KEY } from "./verrail-native-permission-observation.js";
import { loadCodexArtifactCiContext } from "./codex-artifact-ci-context.js";

const inputSchema = z.object({
  workspaceId: z.string().uuid(), targetId: z.string().uuid(), targetRevisionId: z.string().uuid(), graphRevisionId: z.string().uuid(),
  runId: z.string().uuid(), runAttemptId: z.string().uuid(), heartbeatRunId: z.string().uuid(),
  artifactRevisionId: z.string().uuid().optional(), fixedCiProofId: z.string().uuid().optional(),
}).strict();
export type CodexExecutionProofContextInput = z.infer<typeof inputSchema>;
export const codexExecutionProofContextInputSchema = inputSchema;
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative().nullable().optional();
const usageSchema = z.object({
  inputTokens: tokenCount, cachedInputTokens: tokenCount, outputTokens: tokenCount,
  usageSource: z.enum(["per_run", "session_delta"]), provider: z.literal("openai"), model: z.string().trim().min(1).max(256),
  billingType: z.enum(BILLING_TYPES), costStatus: z.enum(COST_STATUSES), costUsd: amount, cacheAdjustedCostUsd: amount,
});
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const LOG_READ_TIMEOUT_MS = 10_000;
const hashPattern = /^[a-f0-9]{64}$/;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function unavailable(): never { throw conflict("Codex execution proof context unavailable or changed"); }

async function loadDatabaseContext(db: Db, input: CodexExecutionProofContextInput) {
  const { workspaceId, targetId, targetRevisionId, graphRevisionId, runId, runAttemptId } = input;
  try {
    return await db.transaction(async tx => {
      const rows = await tx.select({
        targetStatus: verrailTargets.status, targetHash: verrailTargetRevisions.contentHash,
        graphStatus: verrailWorkGraphs.status, graphHash: verrailGraphRevisions.contentHash,
        nodeId: verrailWorkNodes.id, runUpdatedAt: verrailRuns.updatedAt, attemptUpdatedAt: verrailRunAttempts.updatedAt,
        nativeFinishedAt: verrailRuns.finishedAt, attemptFinishedAt: verrailRunAttempts.finishedAt,
        fence: verrailRunAttempts.fencingToken, cursor: verrailRunAttempts.lastEventCursor,
        leaseId: verrailExecutionLeases.id, leaseReleasedAt: verrailExecutionLeases.releasedAt,
        agentId: agents.id, agentDefinitionId: verrailAgentDefinitions.id, agentVersionId: verrailAgentVersions.id,
        agentVersionHash: verrailAgentVersions.contentHash, model: verrailAgentVersions.model,
        deploymentRevisionId: verrailDeploymentRevisions.id, deploymentRevisionHash: verrailDeploymentRevisions.contentHash,
        requestedCwd: sql<unknown>`${verrailDeploymentRevisions.runtimeConfig}->>'cwd'`,
        heartbeatRunId: heartbeatRuns.id, heartbeatUpdatedAt: heartbeatRuns.updatedAt, wakeId: agentWakeupRequests.id,
        startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, exitCode: heartbeatRuns.exitCode, errorCode: heartbeatRuns.errorCode,
        logStore: heartbeatRuns.logStore, logRef: heartbeatRuns.logRef, logSha256: heartbeatRuns.logSha256,
        logBytes: heartbeatRuns.logBytes, logCompressed: heartbeatRuns.logCompressed, usage: heartbeatRuns.usageJson,
        receipt: sql<unknown>`${heartbeatRuns.contextSnapshot}->${NATIVE_OUTPUT_CONTEXT_KEY}`,
        environment: sql<unknown>`${heartbeatRuns.contextSnapshot}->'verrailEnvironmentManifest'`,
        dispatchConfiguration: sql<unknown>`${heartbeatRuns.contextSnapshot}->${NATIVE_DISPATCH_CONTEXT_KEY}`,
        permissionObservation: sql<unknown>`${heartbeatRuns.contextSnapshot}->${NATIVE_PERMISSION_CONTEXT_KEY}`,
        legacyIssue: sql<unknown>`${heartbeatRuns.contextSnapshot}->'issueId'`, legacyTask: sql<unknown>`${heartbeatRuns.contextSnapshot}->'taskId'`,
      }).from(verrailRuns)
        .innerJoin(companies, and(eq(companies.id, workspaceId), eq(companies.status, "active")))
        .innerJoin(verrailTargets, and(eq(verrailTargets.id, targetId), eq(verrailTargets.workspaceId, workspaceId), eq(verrailTargets.activeTargetRevisionId, targetRevisionId)))
        .innerJoin(verrailTargetRevisions, and(eq(verrailTargetRevisions.id, targetRevisionId), eq(verrailTargetRevisions.workspaceId, workspaceId), eq(verrailTargetRevisions.targetId, targetId)))
        .innerJoin(verrailWorkGraphs, and(eq(verrailWorkGraphs.workspaceId, workspaceId), eq(verrailWorkGraphs.targetId, targetId), eq(verrailWorkGraphs.activeGraphRevisionId, graphRevisionId)))
        .innerJoin(verrailGraphRevisions, and(eq(verrailGraphRevisions.id, graphRevisionId), eq(verrailGraphRevisions.workspaceId, workspaceId),
          eq(verrailGraphRevisions.workGraphId, verrailWorkGraphs.id), eq(verrailGraphRevisions.targetId, targetId), eq(verrailGraphRevisions.targetRevisionId, targetRevisionId), eq(verrailGraphRevisions.status, "active")))
        .innerJoin(verrailWorkNodes, and(eq(verrailWorkNodes.id, verrailRuns.workNodeId), eq(verrailWorkNodes.workspaceId, workspaceId), eq(verrailWorkNodes.targetId, targetId),
          eq(verrailWorkNodes.graphRevisionId, graphRevisionId), eq(verrailWorkNodes.kind, "agent_task"), eq(verrailWorkNodes.status, "completed")))
        .innerJoin(verrailRunAttempts, and(eq(verrailRunAttempts.id, runAttemptId), eq(verrailRunAttempts.workspaceId, workspaceId), eq(verrailRunAttempts.runId, runId),
          eq(verrailRunAttempts.attemptNumber, verrailRuns.attemptCount), eq(verrailRunAttempts.agentVersionId, verrailRuns.agentVersionId), eq(verrailRunAttempts.deploymentRevisionId, verrailRuns.deploymentRevisionId),
          eq(verrailRunAttempts.status, "succeeded"), eq(verrailRunAttempts.runtimeProfile, "host_trusted"), eq(verrailRunAttempts.executorPrincipalType, "service"), eq(verrailRunAttempts.executorPrincipalId, "verrail-host-runner")))
        .innerJoin(verrailExecutionLeases, and(eq(verrailExecutionLeases.workspaceId, workspaceId), eq(verrailExecutionLeases.runId, runId), eq(verrailExecutionLeases.runAttemptId, runAttemptId),
          eq(verrailExecutionLeases.fencingToken, verrailRunAttempts.fencingToken), eq(verrailExecutionLeases.executorPrincipalId, "verrail-host-runner"),
          eq(verrailExecutionLeases.runtimeProfile, "host_trusted"), eq(verrailExecutionLeases.status, "released")))
        .innerJoin(verrailAgentVersions, and(eq(verrailAgentVersions.id, verrailRunAttempts.agentVersionId), eq(verrailAgentVersions.workspaceId, workspaceId), eq(verrailAgentVersions.runtime, "codex_local")))
        .innerJoin(verrailAgentDefinitions, and(eq(verrailAgentDefinitions.id, verrailAgentVersions.agentDefinitionId), eq(verrailAgentDefinitions.workspaceId, workspaceId)))
        .innerJoin(agents, and(eq(agents.id, verrailAgentDefinitions.compatibilityAgentId), eq(agents.companyId, workspaceId), eq(agents.adapterType, "codex_local")))
        .innerJoin(verrailDeploymentRevisions, and(eq(verrailDeploymentRevisions.id, verrailRunAttempts.deploymentRevisionId), eq(verrailDeploymentRevisions.workspaceId, workspaceId), eq(verrailDeploymentRevisions.agentVersionId, verrailAgentVersions.id)))
        .innerJoin(verrailDeployments, and(eq(verrailDeployments.id, verrailDeploymentRevisions.deploymentId), eq(verrailDeployments.workspaceId, workspaceId), eq(verrailDeployments.agentDefinitionId, verrailAgentDefinitions.id)))
        .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, workspaceId), eq(heartbeatRuns.agentId, agents.id), eq(heartbeatRuns.status, "succeeded"),
          sql`${heartbeatRuns.contextSnapshot}->>'verrailRunId' = ${runId}`, sql`${heartbeatRuns.contextSnapshot}->>'verrailRunAttemptId' = ${runAttemptId}`,
          sql`${heartbeatRuns.contextSnapshot}->>'verrailTargetId' = ${targetId}`, sql`${heartbeatRuns.contextSnapshot}->>'verrailTargetRevisionId' = ${targetRevisionId}`,
          sql`${heartbeatRuns.contextSnapshot}->>'verrailGraphRevisionId' = ${graphRevisionId}`, sql`${heartbeatRuns.contextSnapshot}->>'verrailWorkNodeId' = ${verrailWorkNodes.id}::text`,
          sql`${heartbeatRuns.contextSnapshot}->>'verrailAgentVersionId' = ${verrailAgentVersions.id}::text`, sql`${heartbeatRuns.contextSnapshot}->>'verrailDeploymentRevisionId' = ${verrailDeploymentRevisions.id}::text`))
        .innerJoin(agentWakeupRequests, and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId), eq(agentWakeupRequests.companyId, workspaceId), eq(agentWakeupRequests.agentId, agents.id),
          eq(agentWakeupRequests.runId, heartbeatRuns.id), eq(agentWakeupRequests.requestedByActorType, "system"), eq(agentWakeupRequests.requestedByActorId, "verrail-host-runner"),
          eq(agentWakeupRequests.idempotencyKey, `verrail-run-attempt:${runAttemptId}`)))
        .where(and(eq(verrailRuns.id, runId), eq(verrailRuns.workspaceId, workspaceId), eq(verrailRuns.targetId, targetId), eq(verrailRuns.targetRevisionId, targetRevisionId),
          eq(verrailRuns.graphRevisionId, graphRevisionId), eq(verrailRuns.kind, "agent"), eq(verrailRuns.status, "succeeded")))
        .limit(2);
      const row = rows[0];
      if (rows.length !== 1 || !row || row.heartbeatRunId !== input.heartbeatRunId || row.targetStatus === "canceled" || row.graphStatus !== "active"
        || row.legacyIssue != null || row.legacyTask != null || !row.leaseReleasedAt || !row.startedAt || !row.finishedAt || row.finishedAt < row.startedAt
        || !row.nativeFinishedAt || !row.attemptFinishedAt || row.nativeFinishedAt < row.finishedAt
        || row.attemptFinishedAt < row.finishedAt || row.leaseReleasedAt < row.finishedAt
        || row.exitCode !== 0 || row.errorCode !== null || !Number.isSafeInteger(row.fence) || !Number.isSafeInteger(row.cursor)
        || ![row.targetHash, row.graphHash, row.agentVersionHash, row.deploymentRevisionHash].every(value => hashPattern.test(value))
        || row.logStore !== "local_file" || row.logRef !== path.join(workspaceId, row.agentId, `${row.heartbeatRunId}.ndjson`)
        || !row.logSha256 || !hashPattern.test(row.logSha256) || row.logBytes === null || !Number.isSafeInteger(row.logBytes)
        || row.logBytes < 1 || row.logBytes > MAX_LOG_BYTES || row.logCompressed) unavailable();
      const receipt = validateNativeOutputReceipt(row.receipt, { workspaceId, runId, attemptId: runAttemptId, heartbeatRunId: row.heartbeatRunId,
        agentId: row.agentId, agentVersionId: row.agentVersionId, deploymentRevisionId: row.deploymentRevisionId });
      if (!receipt || receipt.schemaVersion !== 2 || !receipt.executionFacts || !receipt.finalizedAt || receipt.sourceStatus !== "stable"
        || receipt.beforeSource.status !== "captured" || Date.parse(receipt.finalizedAt) !== row.finishedAt.getTime()) unavailable();
      const facts = receipt.executionFacts;
      const environment = facts.environmentManifest;
      if (!environment || canonicalJson(row.environment) !== canonicalJson(environment)
        || typeof row.requestedCwd !== "string" || environment.requestedCwd !== row.requestedCwd
        || !path.isAbsolute(environment.cwd) || !path.isAbsolute(environment.requestedCwd) || environment.cwd.includes("\0") || environment.requestedCwd.includes("\0")) unavailable();
      // NativeWorkspace's v1 hash uses its original field order, not JSONB order.
      const environmentBase = { schemaVersion: 1, source: "deployment_revision", cwd: environment.cwd, deploymentRevisionId: row.deploymentRevisionId,
        agentVersionId: row.agentVersionId, workspaceId, heartbeatRunId: row.heartbeatRunId, agentId: row.agentId, runId, attemptId: runAttemptId, requestedCwd: environment.requestedCwd };
      if (createHash("sha256").update(JSON.stringify(environmentBase)).digest("hex") !== environment.contentHash) unavailable();
      const expectedFacts = { heartbeatRunId: row.heartbeatRunId, heartbeatStatus: "succeeded", agentId: row.agentId,
        logStore: row.logStore, logRef: row.logRef, logSha256: row.logSha256, logBytes: row.logBytes, usage: row.usage,
        exitCode: row.exitCode, errorCode: row.errorCode, environmentManifest: row.environment,
        ...(row.dispatchConfiguration == null ? {} : { dispatchConfiguration: row.dispatchConfiguration }),
        ...(row.permissionObservation == null ? {} : { permissionObservation: row.permissionObservation }) };
      if (canonicalJson(facts) !== canonicalJson(expectedFacts)) unavailable();
      if (row.dispatchConfiguration != null) {
        const dispatch = validateNativeDispatchConfiguration(row.dispatchConfiguration, receipt.identity);
        if (!dispatch || dispatch.model !== row.model || dispatch.agentVersionContentHash !== row.agentVersionHash
          || dispatch.deploymentRevisionContentHash !== row.deploymentRevisionHash
          || Date.parse(dispatch.recordedAt) < row.startedAt.getTime() || Date.parse(dispatch.recordedAt) > row.finishedAt.getTime()) unavailable();
      }
      const events = await tx.select().from(verrailRunEvents).where(and(eq(verrailRunEvents.workspaceId, workspaceId), eq(verrailRunEvents.runId, runId),
        eq(verrailRunEvents.runAttemptId, runAttemptId), eq(verrailRunEvents.eventType, "succeeded"))).limit(2);
      const event = events[0];
      if (events.length !== 1 || !event || event.fencingToken !== row.fence || event.cursor !== row.cursor || !hashPattern.test(event.contentHash)
        || event.emittedAt.getTime() !== row.finishedAt.getTime()
        || canonicalJson(event.payload.outputReceipt) !== canonicalJson(receipt) || canonicalJson(event.payload.sourceObservation) !== canonicalJson(receipt.beforeSource)
        || Object.entries(facts).some(([key, value]) => canonicalJson(event.payload[key]) !== canonicalJson(value))) unavailable();
      const parsedUsage = usageSchema.safeParse(row.usage);
      if (!parsedUsage.success) unavailable();
      const usage = parsedUsage.data;
      const costUsd = usage.cacheAdjustedCostUsd ?? usage.costUsd ?? null;
      if (usage.model !== row.model || usage.model === "unknown" || usage.billingType === "unknown"
        || (usage.inputTokens === 0 && usage.cachedInputTokens === 0 && usage.outputTokens === 0)
        || (usage.costStatus === "unpriced" && costUsd !== null) || (usage.costStatus === "reported" && costUsd === null)) unavailable();
      return { row, receipt, event,
        log: { handle: { store: "local_file" as const, logRef: path.join(workspaceId, row.agentId, `${row.heartbeatRunId}.ndjson`) }, bytes: row.logBytes, sha256: row.logSha256 },
        usage: { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens,
        usageSource: usage.usageSource, provider: usage.provider, model: usage.model, billingType: usage.billingType, costStatus: usage.costStatus, costUsd },
        contextSha256: digest({ input, row, event }) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && error.message === "Codex execution proof context unavailable or changed") throw error;
    throw new HttpError(503, "Codex execution proof context unavailable");
  }
}

/** Internal composition only. The caller supplies an authorized store, never HTTP-provided facts or paths. */
export async function loadCodexExecutionProofContext(db: Db, raw: CodexExecutionProofContextInput, options: { logs: Pick<RunLogStore, "read"> }) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) unavailable();
  const input = parsed.data;
  if (Boolean(input.artifactRevisionId) !== Boolean(input.fixedCiProofId)) unavailable();
  const context = await loadDatabaseContext(db, input);
  const { row } = context;
  const loadCi = async () => {
    if (!input.artifactRevisionId || !input.fixedCiProofId) return null;
    try {
      return await loadCodexArtifactCiContext(db, { ...input, artifactRevisionId: input.artifactRevisionId, fixedCiProofId: input.fixedCiProofId }, {
        runEventId: context.event.id, runEventContentHash: context.event.contentHash, outputReceiptSha256: context.receipt.sha256 });
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) unavailable();
      throw new HttpError(503, "Codex artifact and CI context unavailable");
    }
  };
  const artifactAndFixedCi = await loadCi();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let log;
  try {
    // Read once so a UTF-8 code point cannot be split across decoded chunks.
    log = await Promise.race([
      options.logs.read(context.log.handle, { offset: 0, limitBytes: context.log.bytes + 1 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("LOG_READ_TIMEOUT")), LOG_READ_TIMEOUT_MS); }),
    ]);
  } catch {
    throw new HttpError(502, "Codex execution log could not be verified");
  } finally { if (timer) clearTimeout(timer); }
  if (!log || typeof log.content !== "string" || log.nextOffset !== undefined || Buffer.byteLength(log.content, "utf8") !== context.log.bytes
    || createHash("sha256").update(log.content, "utf8").digest("hex") !== context.log.sha256) unavailable();
  const rechecked = await loadDatabaseContext(db, input);
  if (rechecked.contextSha256 !== context.contextSha256) unavailable();
  const recheckedCi = await loadCi();
  if (recheckedCi?.contextSha256 !== artifactAndFixedCi?.contextSha256) unavailable();
  return {
    schemaVersion: 1 as const, kind: "verrail.codex-execution-database-context" as const, assurance: "execution_context_only" as const,
    ...input, workNodeId: row.nodeId, agentId: row.agentId, agentDefinitionId: row.agentDefinitionId, agentVersionId: row.agentVersionId,
    agentVersionContentHash: row.agentVersionHash, deploymentRevisionId: row.deploymentRevisionId, deploymentRevisionContentHash: row.deploymentRevisionHash,
    runEventId: context.event.id, runEventContentHash: context.event.contentHash, outputReceiptSha256: context.receipt.sha256,
    environmentManifestSha256: context.receipt.executionFacts!.environmentManifest!.contentHash,
    executionWindow: { startedAt: row.startedAt!.toISOString(), finishedAt: row.finishedAt!.toISOString() },
    dispatchConfiguration: context.receipt.executionFacts!.dispatchConfiguration ?? null,
    permissionObservation: context.receipt.executionFacts!.permissionObservation ?? null,
    log: { handleSha256: digest([input.workspaceId, row.heartbeatRunId, row.logStore, row.logRef]), sha256: context.log.sha256, bytes: context.log.bytes, integrity: "verified" as const },
    artifactAndFixedCi,
    usage: context.usage, contextSha256: artifactAndFixedCi ? digest([context.contextSha256, artifactAndFixedCi.contextSha256]) : context.contextSha256,
    unverified: ["effective_permission_enforcement", ...(!artifactAndFixedCi ? ["artifact_and_fixed_ci_binding"] : []), "candidate_runtime_binding"],
  };
}
