import { createHash } from "node:crypto";
import { repositoryRecoveryStateSha256 as stateDigest } from "./repository-recovery-state-hash.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, verrailRuns, verrailRunAttempts, verrailExecutionLeases, verrailRunEvents,
  verrailRepositoryDispatches, verrailArtifacts, verrailArtifactRevisions, verrailAuditEvents } from "@paperclipai/db";
import { opencodeCandidateRuntimeBindingSchema, opencodeExecutionObservationSchema, repositoryExecutionIdentitySchema, repositoryExecutionRequestSchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { createRepositoryLeaseValidator } from "../execution/repository-lease.js";
import { loadBoundRepositorySourceWithBinding } from "../execution/repository-bound-source.js";
import { validateRepositoryResult } from "../execution/repository-result.js";
import { repositoryRequestSha256 } from "../execution/repository-output-receipt.js";
import { validateRepositoryExecutionObservation } from "../execution/repository-execution-observation.js";
import { conflict } from "../errors.js";
import { loadRepositoryCiSourceContext, verifyRepositoryProofArtifact, type RepositoryCiSourceOptions } from "./github-ci-repository-source-context.js";
import type { GitHubCiSourceContextInput } from "./github-ci-source-context.js";
import { readExecutionProofObject } from "./delivery-proof-storage-reader.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");
function unavailable(): never { throw conflict("Repository recovery context unavailable or changed"); }
export const repositoryRecoverySelectionSchema = repositoryExecutionIdentitySchema.pick({ workspaceId: true, targetId: true,
  targetRevisionId: true, graphRevisionId: true, runId: true, runAttemptId: true }).strict();
type Selection = z.infer<typeof repositoryRecoverySelectionSchema>;
type Reader = Pick<Db, "select" | "execute">;
const eventProjection = z.object({ id: z.string().uuid(), cursor: z.number().int().positive(), eventType: z.string(), sha256: hash }).strict();
const durableSchema = z.object({ identity: repositoryExecutionIdentitySchema,
  controllerId: z.string().uuid(), requestSha256: hash, dispatchSha256: hash, outputReceiptSha256: hash,
  attemptInventorySha256: hash, dispatchInventorySha256: hash, sourceBindingSha256: hash,
  executionObservationSha256: hash, executionLogSha256: hash, executionSessionId: z.string().min(1),
  candidateSessionId: z.string().uuid(), runtimeManifestSha256: hash,
  runtimeBinding: z.object({
    runtimeWindow: z.object({ startedAt: z.iso.datetime(), finishedAt: z.iso.datetime() }).strict(),
    httpSession: opencodeCandidateRuntimeBindingSchema.shape.httpSession.extend({ completedAt: z.iso.datetime() }).strict(),
    candidateRuntime: opencodeCandidateRuntimeBindingSchema,
  }).strict(),
  finishedAt: z.iso.datetime(), artifactCount: z.number().int().min(1).max(10),
}).strict();
export const repositoryRecoveryCheckpointSchema = z.object({ schemaVersion: z.literal(1),
  kind: z.literal("verrail.repository-recovery-checkpoint"), phase: z.literal("before_registration"),
  observedAt: z.iso.datetime(), durable: durableSchema,
  events: z.array(eventProjection).min(1).max(4096), contextSha256: hash,
}).strict();
export type RepositoryRecoveryCheckpoint = z.infer<typeof repositoryRecoveryCheckpointSchema>;

async function readDurable(db: Reader, input: Selection, options: RepositoryCiSourceOptions) {
  const dispatches = await db.select().from(verrailRepositoryDispatches).where(and(
    eq(verrailRepositoryDispatches.workspaceId, input.workspaceId), eq(verrailRepositoryDispatches.runId, input.runId)))
    .orderBy(asc(verrailRepositoryDispatches.runAttemptId)).limit(101);
  const dispatch = dispatches.find(value => value.runAttemptId === input.runAttemptId);
  if (dispatches.length > 100 || !dispatch || dispatch.status !== "succeeded" || !dispatch.finishedAt || dispatch.errorCode) unavailable();
  const request = repositoryExecutionRequestSchema.parse(dispatch.input), result = validateRepositoryResult(dispatch.result, request);
  const receipt = result.outputReceipt;
  if (!receipt?.executionObservation || Object.entries(input).some(([key, value]) => request[key as keyof typeof request] !== value)
    || request.leaseId !== dispatch.leaseId || request.fencingToken !== dispatch.fencingToken
    || repositoryRequestSha256(request) !== dispatch.requestHash || Date.parse(receipt.finalizedAt) > dispatch.finishedAt.getTime()) unavailable();
  const attempts = await db.select().from(verrailRunAttempts).where(and(eq(verrailRunAttempts.workspaceId, input.workspaceId),
    eq(verrailRunAttempts.runId, input.runId))).orderBy(asc(verrailRunAttempts.attemptNumber)).limit(101);
  const attempt = attempts.at(-1);
  if (!attempt || attempts.length > 100 || attempt.id !== input.runAttemptId || attempt.fencingToken !== request.fencingToken
    || attempt.agentVersionId !== request.agentVersionId || attempt.deploymentRevisionId !== request.deploymentRevisionId
    || attempt.executorPrincipalType !== "service" || attempt.executorPrincipalId !== "verrail-repository-runner"
    || attempt.runtimeProfile !== "repository_sandbox") unavailable();
  const [run] = await db.select().from(verrailRuns).where(and(eq(verrailRuns.workspaceId, input.workspaceId), eq(verrailRuns.id, input.runId))).limit(1);
  if (!run || run.attemptCount !== attempt.attemptNumber || run.kind !== "agent" || run.workNodeId !== request.workNodeId
    || run.targetId !== request.targetId || run.targetRevisionId !== request.targetRevisionId || run.graphRevisionId !== request.graphRevisionId
    || run.agentVersionId !== request.agentVersionId || run.deploymentRevisionId !== request.deploymentRevisionId || run.cancelRequestedAt) unavailable();
  const source = await loadBoundRepositorySourceWithBinding({ db, storage: options.storage, request, signal: AbortSignal.timeout(15_000) });
  if (canonicalJson(source.binding) !== canonicalJson(receipt.sourceBinding)
    || Object.entries(options.repository).some(([key, value]) => source.manifest[key as keyof typeof source.manifest] !== value)) unavailable();
  await verifyRepositoryProofArtifact(options.storage, input.workspaceId, request.source.contentHash);
  for (const artifact of receipt.artifacts) await verifyRepositoryProofArtifact(options.storage, input.workspaceId, artifact.contentHash, artifact.bytes);
  const encoded = await readExecutionProofObject(options.storage, input.workspaceId, receipt.executionObservation, "repository-execution-observations");
  const observed = opencodeExecutionObservationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)));
  const log = await readExecutionProofObject(options.storage, input.workspaceId, observed.log, "repository-execution-logs");
  const execution = receipt.executionFacts;
  const observation = validateRepositoryExecutionObservation(observed, log, request, { runtime: execution.runtime,
    runtimeVersion: execution.runtimeVersion, model: execution.model, startedAt: execution.startedAt, finishedAt: execution.finishedAt,
    cleanup: { runtime: execution.cleanup.runtime, home: execution.cleanup.home, commands: execution.cleanup.commands } });
  if (!observation.facts.candidateRuntime || observation.facts.usageStatus !== "complete"
    || Date.parse(observation.recordedAt) > Date.parse(receipt.finalizedAt)) unavailable();
  const events = await db.select().from(verrailRunEvents).where(and(eq(verrailRunEvents.workspaceId, input.workspaceId),
    eq(verrailRunEvents.runId, input.runId), eq(verrailRunEvents.runAttemptId, input.runAttemptId)))
    .orderBy(asc(verrailRunEvents.cursor)).limit(4097);
  if (!events.length || events.length > 4096 || events.at(-1)!.cursor !== attempt.lastEventCursor
    || events.some(event => event.fencingToken !== request.fencingToken)) unavailable();
  const durable = durableSchema.parse({ identity: receipt.identity, controllerId: dispatch.controllerId,
    requestSha256: dispatch.requestHash, dispatchSha256: digest({ request, result, controllerId: dispatch.controllerId,
      createdAt: dispatch.createdAt, finishedAt: dispatch.finishedAt }), outputReceiptSha256: receipt.sha256,
    attemptInventorySha256: digest(attempts.map(({ id, attemptNumber, fencingToken, agentVersionId, deploymentRevisionId,
      executorPrincipalId, executorPrincipalType, runtimeProfile }) => ({ id, attemptNumber, fencingToken, agentVersionId,
      deploymentRevisionId, executorPrincipalId, executorPrincipalType, runtimeProfile }))),
    dispatchInventorySha256: digest(dispatches.map(({ runAttemptId, requestHash, controllerId }) => ({ runAttemptId, requestHash, controllerId }))),
    sourceBindingSha256: digest(source), executionObservationSha256: receipt.executionObservation.contentHash,
    executionLogSha256: observation.log.contentHash, executionSessionId: observation.facts.sessionId,
    candidateSessionId: observation.facts.candidateRuntime.sessionId, runtimeManifestSha256: observation.facts.candidateRuntime.manifestSha256,
    runtimeBinding: { runtimeWindow: { startedAt: execution.startedAt, finishedAt: execution.finishedAt },
      httpSession: { ...observation.facts.candidateRuntime.httpSession,
        completedAt: observation.facts.messages.at(-1)!.completedAt }, candidateRuntime: observation.facts.candidateRuntime },
    finishedAt: dispatch.finishedAt.toISOString(), artifactCount: receipt.artifacts.length });
  return { request, result, receipt, attempt, run, events, durable };
}

/** Read-only data checkpoint. This is NOT an admitted recovery proof or a process-restart observation. */
export async function collectRepositoryRecoveryCheckpoint(db: Db, raw: Selection, options: RepositoryCiSourceOptions) {
  const input = repositoryRecoverySelectionSchema.parse(raw);
  return db.transaction(async tx => {
    try {
      // Use the database transaction boundary, not the end of potentially slow storage reads.
      const boundary = await tx.execute(sql`select transaction_timestamp() as observed_at`);
      const observedAt = z.coerce.date().parse(boundary[0]?.observed_at).toISOString();
      const state = await readDurable(tx, input, options);
      await createRepositoryLeaseValidator(tx)(state.request, AbortSignal.timeout(15_000));
      if (state.attempt.result !== null || state.attempt.finishedAt || state.run.finishedAt
        || state.events.some(event => ["succeeded", "failed", "terminated"].includes(event.eventType))) unavailable();
      const artifacts = await tx.select({ id: verrailArtifactRevisions.id }).from(verrailArtifactRevisions).where(and(
        eq(verrailArtifactRevisions.workspaceId, input.workspaceId), eq(verrailArtifactRevisions.sourceRunId, input.runId))).limit(1);
      if (artifacts.length) unavailable();
      const checkpoint = { schemaVersion: 1 as const, kind: "verrail.repository-recovery-checkpoint" as const,
        phase: "before_registration" as const, observedAt, durable: state.durable,
        events: state.events.map(event => ({ id: event.id, cursor: event.cursor, eventType: event.eventType, sha256: stateDigest(event) })) };
      if (Date.parse(checkpoint.observedAt) < Date.parse(state.durable.finishedAt)) unavailable();
      return repositoryRecoveryCheckpointSchema.parse({ ...checkpoint, contextSha256: digest(checkpoint) });
    } catch { return unavailable(); }
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** The private verifier must independently authenticate the checkpoint and process interruption before admitting any proof. */
export async function collectRepositoryRecoveryCompletion(db: Db, rawCheckpoint: RepositoryRecoveryCheckpoint,
  input: GitHubCiSourceContextInput, options: RepositoryCiSourceOptions) {
  const checkpoint = repositoryRecoveryCheckpointSchema.parse(rawCheckpoint);
  const { contextSha256, ...body } = checkpoint;
  if (digest(body) !== contextSha256 || Date.parse(checkpoint.observedAt) > Date.now()) unavailable();
  const identity = checkpoint.durable.identity;
  for (const key of ["workspaceId", "targetId", "targetRevisionId", "graphRevisionId"] as const) if (input[key] !== identity[key]) unavailable();
  return db.transaction(async tx => {
    try {
      const state = await readDurable(tx, repositoryRecoverySelectionSchema.strip().parse(identity), options);
      const source = await loadRepositoryCiSourceContext(tx, input, options);
      const active = await tx.execute(sql`select graph.id from verrail_graph_revisions graph
        join verrail_work_graphs work_graph on work_graph.id=graph.work_graph_id and work_graph.workspace_id=graph.workspace_id
          and work_graph.target_id=graph.target_id and work_graph.active_graph_revision_id=graph.id and work_graph.status='active'
        join verrail_targets target on target.id=graph.target_id and target.workspace_id=graph.workspace_id
          and target.active_target_revision_id=graph.target_revision_id and target.status not in ('canceled', 'accepted')
        where graph.id=${identity.graphRevisionId} and graph.workspace_id=${identity.workspaceId}
          and graph.target_id=${identity.targetId} and graph.target_revision_id=${identity.targetRevisionId} and graph.status='active'`);
      if (active.length !== 1) unavailable();
      if (canonicalJson(state.durable) !== canonicalJson(checkpoint.durable)
        || source.source.outputReceiptSha256 !== state.receipt.sha256 || source.source.runAttemptId !== identity.runAttemptId
        || state.attempt.status !== "succeeded" || state.run.status !== "succeeded" || !state.attempt.finishedAt || !state.run.finishedAt
        || canonicalJson(state.attempt.result?.repositoryOutput) !== canonicalJson(state.result)) unavailable();
      const prefix = state.events.slice(0, checkpoint.events.length).map(event => ({ id: event.id,
        cursor: event.cursor, eventType: event.eventType, sha256: stateDigest(event) }));
      const additions = state.events.slice(checkpoint.events.length);
      if (canonicalJson(prefix) !== canonicalJson(checkpoint.events) || !additions.length
        || additions.at(-1)!.id !== source.source.runEventId || additions.at(-1)!.eventType !== "succeeded"
        || additions.slice(0, -1).some(event => event.eventType !== "heartbeat")
        // A heartbeat transaction may start before this snapshot and commit after it.
        || additions.at(-1)!.receivedAt.getTime() < Date.parse(checkpoint.observedAt)) unavailable();
      const revisions = await tx.select({ revision: verrailArtifactRevisions, artifact: verrailArtifacts }).from(verrailArtifactRevisions)
        .leftJoin(verrailArtifacts, eq(verrailArtifacts.id, verrailArtifactRevisions.artifactId))
        .where(and(eq(verrailArtifactRevisions.workspaceId, input.workspaceId),
        eq(verrailArtifactRevisions.sourceRunId, identity.runId))).orderBy(asc(verrailArtifactRevisions.id)).limit(11);
      if (revisions.length !== state.receipt.artifacts.length || !revisions.some(value => value.revision.id === input.artifactRevisionId)) unavailable();
      const unmatched = [...revisions];
      for (const artifact of state.receipt.artifacts) {
        const index = unmatched.findIndex(value => value.revision.contentHash === artifact.contentHash && value.revision.contentRef === artifact.contentRef
          && value.artifact?.workspaceId === identity.workspaceId && value.artifact.targetId === identity.targetId
          && value.artifact.kind === artifact.kind && value.artifact.title === artifact.title
          && value.artifact.createdByPrincipalType === "service" && value.artifact.createdByPrincipalId === "verrail-repository-runner");
        if (index < 0) unavailable();
        const { revision } = unmatched.splice(index, 1)[0]!;
        if (revision.revisionNumber !== 1 || revision.sourceWorkNodeId !== identity.workNodeId
          || revision.createdByPrincipalType !== "service" || revision.createdByPrincipalId !== "verrail-repository-runner") unavailable();
        const audits = await tx.select().from(verrailAuditEvents).where(and(eq(verrailAuditEvents.workspaceId, input.workspaceId),
          eq(verrailAuditEvents.aggregateId, revision.id), eq(verrailAuditEvents.aggregateType, "artifact_revision"),
          eq(verrailAuditEvents.eventType, "assurance.artifact_revision_added.v1"))).limit(2);
        if (audits.length !== 1 || audits[0]!.principalType !== "service" || audits[0]!.principalId !== "verrail-repository-runner"
          || canonicalJson(audits[0]!.payload) !== canonicalJson({ schemaVersion: 1, resourceType: "artifact_revision", resourceId: revision.id,
            runId: identity.runId, runAttemptId: identity.runAttemptId, workNodeId: identity.workNodeId,
            fencingToken: identity.fencingToken, contentHash: artifact.contentHash })) unavailable();
      }
      const [lease] = await tx.select().from(verrailExecutionLeases).where(and(eq(verrailExecutionLeases.workspaceId, input.workspaceId),
        eq(verrailExecutionLeases.id, identity.leaseId))).limit(1);
      if (!lease || lease.status !== "released" || !lease.releasedAt || lease.releasedAt.getTime() < Date.parse(checkpoint.observedAt)) unavailable();
      const context = { schemaVersion: 1 as const, kind: "verrail.repository-recovery-completion" as const,
        checkpointSha256: contextSha256, durable: state.durable, source: source.source, sourceContextSha256: source.contextSha256,
        eventsSha256: stateDigest(state.events), artifactsSha256: stateDigest(revisions), authoritativeResultSha256: stateDigest(state.attempt.result) };
      return { ...context, contextSha256: digest(context) };
    } catch { return unavailable(); }
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
