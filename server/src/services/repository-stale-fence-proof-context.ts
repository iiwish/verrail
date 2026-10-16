import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, verrailExecutionCommandReceipts, verrailRunAttempts, verrailRuns, verrailExecutionLeases,
  verrailRunEvents, verrailAuditEvents } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { repositoryExecutionIdentitySchema, targetIdempotencyKeySchema } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { repositoryRecoveryStateSha256 as stateDigest } from "./repository-recovery-state-hash.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// A delayed heartbeat tests the fence without submitting a fabricated model result.
export const repositoryStaleFenceProbeSchema = z.object({ workspaceId: z.string().uuid(), runId: z.string().uuid(),
  runAttemptId: z.string().uuid(), idempotencyKey: targetIdempotencyKeySchema,
  input: z.object({ leaseId: z.string().uuid(), fencingToken: positive, cursor: positive, eventType: z.literal("heartbeat"),
    emittedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).refine(value => {
      const time = Date.parse(value);
      return Number.isFinite(time) && new Date(time).toISOString() === value.replace(/Z$/, ".000Z");
    }) }).strict(),
}).strict();
export type RepositoryStaleFenceProbe = z.infer<typeof repositoryStaleFenceProbeSchema>;
const responseSchema = z.object({ schemaVersion: z.literal(1), runId: z.string().uuid(), runAttemptId: z.string().uuid(),
  cursor: positive, eventType: z.literal("heartbeat"), authoritative: z.literal(false), rejectionCode: z.literal("STALE_FENCING_TOKEN"),
  runStatus: z.literal("succeeded"), attemptStatus: z.enum(["failed", "superseded"]), leaseStatus: z.enum(["expired", "revoked"]),
  replayed: z.literal(false) }).strict();
function unavailable(): never { throw conflict("Repository stale-fence context unavailable or changed"); }
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");
type Identity = z.infer<typeof repositoryExecutionIdentitySchema>;

async function readProbeCheckpoint(db: Pick<Db, "select">, identity: Identity, oldAttemptId: string) {
  const attempts = await db.select().from(verrailRunAttempts).where(and(eq(verrailRunAttempts.workspaceId, identity.workspaceId),
    eq(verrailRunAttempts.runId, identity.runId))).orderBy(asc(verrailRunAttempts.attemptNumber)).limit(101);
  const current = attempts.at(-1), old = attempts.find(attempt => attempt.id === oldAttemptId);
  const [run] = await db.select().from(verrailRuns).where(and(eq(verrailRuns.workspaceId, identity.workspaceId),
    eq(verrailRuns.id, identity.runId))).limit(1);
  if (attempts.length > 100 || !old || !current || current.id !== identity.runAttemptId || current.id === old.id
    || !run || run.kind !== "agent" || run.status !== "succeeded" || current.status !== "succeeded"
    || run.attemptCount !== current.attemptNumber || run.targetId !== identity.targetId || run.targetRevisionId !== identity.targetRevisionId
    || run.graphRevisionId !== identity.graphRevisionId || run.workNodeId !== identity.workNodeId
    || run.agentVersionId !== identity.agentVersionId || run.deploymentRevisionId !== identity.deploymentRevisionId
    || current.fencingToken !== identity.fencingToken || old.fencingToken >= current.fencingToken
    || old.attemptNumber >= current.attemptNumber || !["failed", "superseded"].includes(old.status)
    || !old.startedAt || !old.finishedAt || !current.startedAt || !current.finishedAt || !run.finishedAt || !current.result
    || old.startedAt.getTime() > old.finishedAt.getTime() || old.finishedAt.getTime() > current.startedAt.getTime()
    || current.startedAt.getTime() > current.finishedAt.getTime() || current.finishedAt.getTime() > Date.now()
    || [old, current].some(attempt => attempt.runtimeProfile !== "repository_sandbox" || attempt.executorPrincipalType !== "service"
      || attempt.executorPrincipalId !== "verrail-repository-runner" || attempt.agentVersionId !== identity.agentVersionId
      || attempt.deploymentRevisionId !== identity.deploymentRevisionId)) unavailable();
  const leases = await db.select().from(verrailExecutionLeases).where(and(eq(verrailExecutionLeases.workspaceId, identity.workspaceId),
    eq(verrailExecutionLeases.runId, identity.runId), eq(verrailExecutionLeases.runAttemptId, old.id))).limit(2);
  const lease = leases[0];
  if (leases.length !== 1 || !lease || !["expired", "revoked"].includes(lease.status) || lease.fencingToken !== old.fencingToken
    || lease.runtimeProfile !== "repository_sandbox" || lease.executorPrincipalId !== "verrail-repository-runner"
    || !lease.releasedAt || lease.releasedAt.getTime() > current.startedAt.getTime()) unavailable();
  const [currentLease] = await db.select().from(verrailExecutionLeases).where(and(eq(verrailExecutionLeases.workspaceId, identity.workspaceId),
    eq(verrailExecutionLeases.id, identity.leaseId), eq(verrailExecutionLeases.runId, identity.runId),
    eq(verrailExecutionLeases.runAttemptId, current.id), eq(verrailExecutionLeases.fencingToken, current.fencingToken))).limit(1);
  if (!currentLease || currentLease.status !== "released" || !currentLease.releasedAt
    || currentLease.runtimeProfile !== "repository_sandbox" || currentLease.executorPrincipalId !== "verrail-repository-runner") unavailable();
  const events = await db.select().from(verrailRunEvents).where(and(eq(verrailRunEvents.workspaceId, identity.workspaceId),
    eq(verrailRunEvents.runId, identity.runId), eq(verrailRunEvents.runAttemptId, old.id)))
    .orderBy(asc(verrailRunEvents.cursor)).limit(4097);
  if (events.length < 2 || events.length > 4096 || events.at(-1)!.cursor !== old.lastEventCursor
    || events[0]!.eventType !== "claimed" || !events.some(event => event.eventType === "started")
    || events.some((event, index) => event.fencingToken !== old.fencingToken || event.cursor !== index + 1
      || event.receivedAt.getTime() > old.finishedAt!.getTime())) unavailable();
  const context = { schemaVersion: 1 as const, kind: "verrail.repository-stale-fence-probe-checkpoint" as const,
    identity, oldAttemptId: old.id, oldAttemptNumber: old.attemptNumber, oldLeaseId: lease.id,
    oldFencingToken: old.fencingToken, nextCursor: old.lastEventCursor + 1,
    oldAttemptSha256: stateDigest(old), oldLeaseSha256: stateDigest(lease), oldEventsSha256: stateDigest(events),
    currentAttemptSha256: stateDigest(current), currentRunSha256: stateDigest(run), currentLeaseSha256: stateDigest(currentLease) };
  return { ...context, contextSha256: digest(context) };
}

/** Captured after recovery registration but before any verification probe. Does not issue an event. */
export async function collectRepositoryStaleFenceProbeCheckpoint(db: Db, rawIdentity: Identity, oldAttemptId: string) {
  const identity = repositoryExecutionIdentitySchema.parse(rawIdentity);
  z.string().uuid().parse(oldAttemptId);
  return db.transaction(tx => readProbeCheckpoint(tx, identity, oldAttemptId),
    { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** The fixed, payload-free wire shape matches Go ReportRunEventInput field order and UTC-second timestamps. */
export function repositoryStaleFenceRequestHash(raw: RepositoryStaleFenceProbe) {
  const { input } = repositoryStaleFenceProbeSchema.parse(raw);
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Read-only correlation, not authority. The outer verifier must authenticate the probe journal and compare its current-state checkpoint. */
export async function collectRepositoryStaleFenceContext(db: Db, raw: RepositoryStaleFenceProbe, receiptId?: string) {
  const probe = repositoryStaleFenceProbeSchema.parse(raw);
  z.string().uuid().optional().parse(receiptId);
  const requestHash = repositoryStaleFenceRequestHash(probe);
  return db.transaction(async tx => {
    const receipts = await tx.select().from(verrailExecutionCommandReceipts).where(and(
      receiptId ? eq(verrailExecutionCommandReceipts.id, receiptId) : undefined,
      eq(verrailExecutionCommandReceipts.workspaceId, probe.workspaceId),
      eq(verrailExecutionCommandReceipts.principalType, "service"), eq(verrailExecutionCommandReceipts.principalId, "verrail-repository-runner"),
      eq(verrailExecutionCommandReceipts.commandType, "run_event.report.v1"),
      eq(verrailExecutionCommandReceipts.idempotencyKey, probe.idempotencyKey), eq(verrailExecutionCommandReceipts.requestHash, requestHash))).limit(2);
    const receipt = receipts[0];
    if (receipts.length !== 1 || !receipt) unavailable();
    const parsed = responseSchema.safeParse(receipt.response);
    if (!parsed.success) unavailable();
    const response = parsed.data;
    if (response.runId !== probe.runId || response.runAttemptId !== probe.runAttemptId || response.cursor !== probe.input.cursor
      || receipt.createdAt.getTime() < Date.parse(probe.input.emittedAt) || receipt.createdAt.getTime() > Date.now()) unavailable();
    const attempts = await tx.select().from(verrailRunAttempts).where(and(eq(verrailRunAttempts.workspaceId, probe.workspaceId),
      eq(verrailRunAttempts.runId, probe.runId))).orderBy(asc(verrailRunAttempts.attemptNumber)).limit(101);
    const old = attempts.find(attempt => attempt.id === probe.runAttemptId), current = attempts.at(-1);
    if (attempts.length > 100 || !old || !current || old.id === current.id || old.attemptNumber >= current.attemptNumber
      || old.fencingToken >= current.fencingToken || old.fencingToken !== probe.input.fencingToken
      || old.status !== response.attemptStatus || current.status !== "succeeded"
      || !old.startedAt || !old.finishedAt || !current.finishedAt || current.finishedAt.getTime() > receipt.createdAt.getTime()
      || old.lastEventCursor + 1 !== probe.input.cursor || old.startedAt.getTime() > Date.parse(probe.input.emittedAt)
      || old.agentVersionId !== current.agentVersionId || old.deploymentRevisionId !== current.deploymentRevisionId
      || [old, current].some(attempt => attempt.runtimeProfile !== "repository_sandbox" || attempt.executorPrincipalType !== "service"
        || attempt.executorPrincipalId !== "verrail-repository-runner")) unavailable();
    const [run] = await tx.select().from(verrailRuns).where(and(eq(verrailRuns.workspaceId, probe.workspaceId), eq(verrailRuns.id, probe.runId))).limit(1);
    if (!run || run.kind !== "agent" || run.status !== "succeeded" || run.attemptCount !== current.attemptNumber
      || run.agentVersionId !== current.agentVersionId || run.deploymentRevisionId !== current.deploymentRevisionId) unavailable();
    const [lease] = await tx.select().from(verrailExecutionLeases).where(and(eq(verrailExecutionLeases.workspaceId, probe.workspaceId),
      eq(verrailExecutionLeases.id, probe.input.leaseId), eq(verrailExecutionLeases.runId, probe.runId),
      eq(verrailExecutionLeases.runAttemptId, old.id), eq(verrailExecutionLeases.fencingToken, old.fencingToken))).limit(1);
    if (!lease || lease.status !== response.leaseStatus || lease.runtimeProfile !== "repository_sandbox"
      || lease.executorPrincipalId !== "verrail-repository-runner" || !lease.releasedAt) unavailable();
    const accepted = await tx.select({ id: verrailRunEvents.id }).from(verrailRunEvents).where(and(
      eq(verrailRunEvents.workspaceId, probe.workspaceId), eq(verrailRunEvents.runId, probe.runId),
      eq(verrailRunEvents.runAttemptId, old.id), eq(verrailRunEvents.cursor, probe.input.cursor))).limit(1);
    if (accepted.length) unavailable();
    const audits = await tx.select().from(verrailAuditEvents).where(and(eq(verrailAuditEvents.workspaceId, probe.workspaceId),
      eq(verrailAuditEvents.aggregateType, "target"), eq(verrailAuditEvents.aggregateId, run.targetId),
      eq(verrailAuditEvents.idempotencyKey, probe.idempotencyKey), eq(verrailAuditEvents.eventType, "run.event_rejected_stale_fence"))).limit(2);
    const audit = audits[0];
    if (audits.length !== 1 || !audit || audit.principalType !== "service" || audit.principalId !== "verrail-repository-runner"
      || canonicalJson(audit.payload) !== canonicalJson({ schemaVersion: 1, targetId: run.targetId, runId: probe.runId,
        runAttemptId: old.id, eventType: "run.event_rejected_stale_fence" })) unavailable();
    const [currentLease] = await tx.select().from(verrailExecutionLeases).where(and(eq(verrailExecutionLeases.workspaceId, probe.workspaceId),
      eq(verrailExecutionLeases.runId, run.id), eq(verrailExecutionLeases.runAttemptId, current.id))).limit(1);
    if (!currentLease) unavailable();
    const checkpoint = await readProbeCheckpoint(tx, repositoryExecutionIdentitySchema.parse({ workspaceId: run.workspaceId,
      targetId: run.targetId, targetRevisionId: run.targetRevisionId, graphRevisionId: run.graphRevisionId, workNodeId: run.workNodeId,
      runId: run.id, runAttemptId: current.id, leaseId: currentLease.id, fencingToken: current.fencingToken,
      agentVersionId: current.agentVersionId, deploymentRevisionId: current.deploymentRevisionId }), old.id);
    const context = { schemaVersion: 1 as const, kind: "verrail.repository-stale-fence-context" as const,
      workspaceId: probe.workspaceId, targetId: run.targetId, targetRevisionId: run.targetRevisionId, graphRevisionId: run.graphRevisionId,
      runId: probe.runId, oldAttemptId: old.id, oldLeaseId: lease.id, oldFencingToken: old.fencingToken,
      currentAttemptId: current.id, currentFencingToken: current.fencingToken, requestHash, idempotencyKey: probe.idempotencyKey,
      receiptId: receipt.id, receiptSha256: stateDigest(receipt), auditId: audit.id, auditSha256: stateDigest(audit),
      receiptCreatedAt: receipt.createdAt.toISOString(), auditOccurredAt: audit.occurredAt.toISOString(),
      response, currentAttemptSha256: checkpoint.currentAttemptSha256, currentRunSha256: checkpoint.currentRunSha256,
      probeCheckpoint: checkpoint };
    return { ...context, contextSha256: digest(context) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
