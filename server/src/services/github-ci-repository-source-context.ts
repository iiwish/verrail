import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { repositoryExecutionRequestSchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import {
  type Db, verrailArtifacts, verrailArtifactRevisions, verrailRuns, verrailRunAttempts, verrailRunEvents,
  verrailAuditEvents, verrailWorkNodes, verrailAgentVersions, verrailDeploymentRevisions,
  verrailExecutionLeases, verrailRepositoryDispatches,
} from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { conflict } from "../errors.js";
import { loadBoundRepositorySourceWithBinding } from "../execution/repository-bound-source.js";
import { validateRepositoryResult } from "../execution/repository-result.js";
import { repositoryRequestSha256 } from "../execution/repository-output-receipt.js";
import type { GitHubCiSourceContext, GitHubCiSourceContextInput } from "./github-ci-source-context.js";

export interface RepositoryCiSourceOptions {
  storage: Pick<StorageService, "getObject">;
  repository: { repository: string; connectionId: string; bindingId: string };
}
const executor = "verrail-repository-runner";
function unavailable(): never { throw conflict("GitHub CI repository source context unavailable or changed"); }
const registeredArtifact = z.object({ title: z.string(), kind: z.string(), contentHash: z.string(), contentRef: z.string() }).strict();

export async function verifyRepositoryProofArtifact(storage: RepositoryCiSourceOptions["storage"], workspaceId: string, hash: string, bytes?: number) {
  const signal = AbortSignal.timeout(15_000);
  const pending = storage.getObject(workspaceId, `${workspaceId}/verrail/run-artifacts/sha256/${hash}`);
  const object = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
    const abort = () => reject(new Error("REPOSITORY_SOURCE_READ_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { value.stream.destroy(); return; }
      resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
  const abort = () => object.stream.destroy(new Error("REPOSITORY_SOURCE_READ_TIMEOUT"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    if (object.contentLength !== undefined && (!Number.isSafeInteger(object.contentLength) || object.contentLength < 1
      || object.contentLength > 32 * 1024 * 1024 || (bytes !== undefined && object.contentLength !== bytes))) unavailable();
    const digest = createHash("sha256"); let size = 0;
    for await (const chunk of object.stream) {
      signal.throwIfAborted(); const value = Buffer.from(chunk); size += value.length;
      if ((bytes !== undefined && size > bytes) || size > 32 * 1024 * 1024) unavailable();
      digest.update(value);
    }
    if (!size || (bytes !== undefined && size !== bytes) || (object.contentLength !== undefined && size !== object.contentLength)
      || digest.digest("hex") !== hash) unavailable();
  } finally { signal.removeEventListener("abort", abort); object.stream.destroy(); }
}

/** Runs inside the caller's active-target/requirement repeatable-read snapshot. */
export async function loadRepositoryCiSourceContext(db: Pick<Db, "select">, selection: GitHubCiSourceContextInput,
  options: RepositoryCiSourceOptions): Promise<Omit<GitHubCiSourceContext, "criterionKey">> {
  // Callers may carry execution fields; only the source selection belongs in this digest.
  const input: GitHubCiSourceContextInput = {
    workspaceId: selection.workspaceId, targetId: selection.targetId, targetRevisionId: selection.targetRevisionId,
    graphRevisionId: selection.graphRevisionId, claimId: selection.claimId, workNodeId: selection.workNodeId,
    artifactRevisionId: selection.artifactRevisionId, requirementId: selection.requirementId,
  };
  const { workspaceId, targetId, targetRevisionId, graphRevisionId } = input;
  const [artifact] = await db.select({
    id: verrailArtifactRevisions.id, artifactId: verrailArtifacts.id, title: verrailArtifacts.title,
    kind: verrailArtifacts.kind, contentHash: verrailArtifactRevisions.contentHash, contentRef: verrailArtifactRevisions.contentRef,
    revisionCreatedAt: verrailArtifactRevisions.createdAt, runId: verrailRuns.id, nodeId: verrailRuns.workNodeId,
    runUpdatedAt: verrailRuns.updatedAt, deploymentRevisionId: verrailRuns.deploymentRevisionId, agentVersionId: verrailRuns.agentVersionId,
    attemptId: verrailRunAttempts.id, attemptNumber: verrailRunAttempts.attemptNumber, fencingToken: verrailRunAttempts.fencingToken,
    cursor: verrailRunAttempts.lastEventCursor, attemptUpdatedAt: verrailRunAttempts.updatedAt,
    model: verrailAgentVersions.model, versionHash: verrailAgentVersions.contentHash, deploymentHash: verrailDeploymentRevisions.contentHash,
  }).from(verrailArtifactRevisions)
    .innerJoin(verrailArtifacts, and(eq(verrailArtifacts.id, verrailArtifactRevisions.artifactId), eq(verrailArtifacts.workspaceId, workspaceId),
      eq(verrailArtifacts.targetId, targetId), eq(verrailArtifacts.kind, "code_change"), eq(verrailArtifacts.createdByPrincipalType, "service"), eq(verrailArtifacts.createdByPrincipalId, executor)))
    .innerJoin(verrailRuns, and(eq(verrailRuns.id, verrailArtifactRevisions.sourceRunId), eq(verrailRuns.workNodeId, verrailArtifactRevisions.sourceWorkNodeId),
      eq(verrailRuns.workspaceId, workspaceId), eq(verrailRuns.targetId, targetId), eq(verrailRuns.targetRevisionId, targetRevisionId),
      eq(verrailRuns.graphRevisionId, graphRevisionId), eq(verrailRuns.kind, "agent"), eq(verrailRuns.status, "succeeded")))
    .innerJoin(verrailRunAttempts, and(eq(verrailRunAttempts.runId, verrailRuns.id), eq(verrailRunAttempts.workspaceId, workspaceId),
      eq(verrailRunAttempts.attemptNumber, verrailRuns.attemptCount), eq(verrailRunAttempts.deploymentRevisionId, verrailRuns.deploymentRevisionId),
      eq(verrailRunAttempts.agentVersionId, verrailRuns.agentVersionId), eq(verrailRunAttempts.status, "succeeded"),
      eq(verrailRunAttempts.runtimeProfile, "repository_sandbox"), eq(verrailRunAttempts.executorPrincipalType, "service"), eq(verrailRunAttempts.executorPrincipalId, executor)))
    .innerJoin(verrailAgentVersions, and(eq(verrailAgentVersions.id, verrailRuns.agentVersionId), eq(verrailAgentVersions.workspaceId, workspaceId), eq(verrailAgentVersions.runtime, "opencode")))
    .innerJoin(verrailDeploymentRevisions, and(eq(verrailDeploymentRevisions.id, verrailRuns.deploymentRevisionId), eq(verrailDeploymentRevisions.workspaceId, workspaceId), eq(verrailDeploymentRevisions.agentVersionId, verrailRuns.agentVersionId)))
    .where(and(eq(verrailArtifactRevisions.id, input.artifactRevisionId), eq(verrailArtifactRevisions.workspaceId, workspaceId),
      eq(verrailArtifactRevisions.revisionNumber, 1), eq(verrailArtifactRevisions.createdByPrincipalType, "service"), eq(verrailArtifactRevisions.createdByPrincipalId, executor))).limit(1);
  if (!artifact || !artifact.agentVersionId || !artifact.deploymentRevisionId) unavailable();
  const newer = await db.select({ id: verrailRunAttempts.id }).from(verrailRunAttempts).where(and(eq(verrailRunAttempts.workspaceId, workspaceId),
    eq(verrailRunAttempts.runId, artifact.runId), gt(verrailRunAttempts.attemptNumber, artifact.attemptNumber))).limit(1);
  if (newer.length) unavailable();
  const [sourceNode] = await db.select().from(verrailWorkNodes).where(and(eq(verrailWorkNodes.id, artifact.nodeId), eq(verrailWorkNodes.workspaceId, workspaceId),
    eq(verrailWorkNodes.targetId, targetId), eq(verrailWorkNodes.graphRevisionId, graphRevisionId), eq(verrailWorkNodes.kind, "agent_task"), eq(verrailWorkNodes.status, "completed"))).limit(1);
  const [lease] = await db.select().from(verrailExecutionLeases).where(and(eq(verrailExecutionLeases.workspaceId, workspaceId), eq(verrailExecutionLeases.runId, artifact.runId),
    eq(verrailExecutionLeases.runAttemptId, artifact.attemptId), eq(verrailExecutionLeases.fencingToken, artifact.fencingToken),
    eq(verrailExecutionLeases.runtimeProfile, "repository_sandbox"), eq(verrailExecutionLeases.executorPrincipalId, executor), eq(verrailExecutionLeases.status, "released"))).limit(1);
  if (!sourceNode || !lease?.releasedAt) unavailable();
  const [dispatch] = await db.select().from(verrailRepositoryDispatches).where(and(eq(verrailRepositoryDispatches.workspaceId, workspaceId), eq(verrailRepositoryDispatches.runId, artifact.runId),
    eq(verrailRepositoryDispatches.runAttemptId, artifact.attemptId), eq(verrailRepositoryDispatches.leaseId, lease.id),
    eq(verrailRepositoryDispatches.fencingToken, artifact.fencingToken), eq(verrailRepositoryDispatches.status, "succeeded"))).limit(1);
  if (!dispatch?.finishedAt || dispatch.errorCode || !dispatch.result) unavailable();
  const parsed = repositoryExecutionRequestSchema.safeParse(dispatch.input);
  if (!parsed.success) unavailable();
  const request = parsed.data;
  const identity = { workspaceId, targetId, targetRevisionId, graphRevisionId, workNodeId: artifact.nodeId, runId: artifact.runId,
    runAttemptId: artifact.attemptId, leaseId: lease.id, fencingToken: artifact.fencingToken,
    deploymentRevisionId: artifact.deploymentRevisionId, agentVersionId: artifact.agentVersionId, model: artifact.model };
  if (Object.entries(identity).some(([key, value]) => request[key as keyof typeof request] !== value)
    || repositoryRequestSha256(request) !== dispatch.requestHash) unavailable();
  const events = await db.select().from(verrailRunEvents).where(and(eq(verrailRunEvents.workspaceId, workspaceId), eq(verrailRunEvents.runId, artifact.runId),
    eq(verrailRunEvents.runAttemptId, artifact.attemptId), eq(verrailRunEvents.eventType, "succeeded"))).limit(2);
  const event = events[0];
  if (events.length !== 1 || !event || event.fencingToken !== artifact.fencingToken || event.cursor !== artifact.cursor
    || !/^[a-f0-9]{64}$/.test(event.contentHash) || canonicalJson(event.payload).length > 2_000_000
    || canonicalJson(event.payload.repositoryOutput) !== canonicalJson(dispatch.result)) unavailable();
  let result;
  try { result = validateRepositoryResult(event.payload.repositoryOutput, request); } catch { unavailable(); }
  const receipt = result.outputReceipt;
  if (!receipt || Date.parse(receipt.finalizedAt) > event.emittedAt.getTime() || Date.parse(receipt.finalizedAt) > dispatch.finishedAt.getTime()) unavailable();
  const registered = z.array(registeredArtifact).min(1).max(10).safeParse(event.payload.artifacts);
  if (!registered.success || canonicalJson(registered.data) !== canonicalJson(receipt.artifacts.map(({ title, kind, contentHash, contentRef }) => ({ title, kind, contentHash, contentRef })))) unavailable();
  const matches = receipt.artifacts.filter(entry => entry.type === "source_snapshot" && entry.title === artifact.title && entry.kind === artifact.kind
    && entry.contentHash === artifact.contentHash && entry.contentRef === artifact.contentRef);
  const mapping = matches[0];
  if (matches.length !== 1 || !mapping || mapping.type !== "source_snapshot") unavailable();
  let provenance: Awaited<ReturnType<typeof loadBoundRepositorySourceWithBinding>>;
  try {
    provenance = await loadBoundRepositorySourceWithBinding({ db, storage: options.storage, request, signal: AbortSignal.timeout(15_000) });
    if (canonicalJson(provenance.binding) !== canonicalJson(receipt.sourceBinding)
      || provenance.manifest.baseCommit !== request.source.baseCommit || provenance.manifest.source.artifactId !== request.source.artifactId
      || provenance.manifest.source.contentHash !== request.source.contentHash
      || Object.entries(options.repository).some(([key, value]) => provenance.manifest[key as keyof typeof provenance.manifest] !== value)) unavailable();
    await verifyRepositoryProofArtifact(options.storage, workspaceId, request.source.contentHash);
    await verifyRepositoryProofArtifact(options.storage, workspaceId, mapping.contentHash, mapping.bytes);
  } catch { unavailable(); }
  const audits = await db.select().from(verrailAuditEvents).where(and(eq(verrailAuditEvents.workspaceId, workspaceId), eq(verrailAuditEvents.aggregateId, input.artifactRevisionId),
    eq(verrailAuditEvents.aggregateType, "artifact_revision"), eq(verrailAuditEvents.eventType, "assurance.artifact_revision_added.v1"), eq(verrailAuditEvents.principalType, "service"), eq(verrailAuditEvents.principalId, executor))).limit(2);
  const audit = audits[0];
  if (audits.length !== 1 || !audit || canonicalJson(audit.payload) !== canonicalJson({ schemaVersion: 1, resourceType: "artifact_revision", resourceId: artifact.id,
    runId: artifact.runId, runAttemptId: artifact.attemptId, workNodeId: artifact.nodeId, fencingToken: artifact.fencingToken, contentHash: artifact.contentHash })) unavailable();
  return {
    source: { runId: artifact.runId, runAttemptId: artifact.attemptId, runEventId: event.id, runEventContentHash: event.contentHash, outputReceiptSha256: receipt.sha256, artifactOrdinal: mapping.ordinal },
    snapshot: { sourceSnapshotTreeSha: mapping.sourceSnapshot.snapshotTree, sourceContentSha256: mapping.sourceSnapshot.sourceContentSha256 },
    contextSha256: createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify({ input, artifact, sourceNode, lease,
      dispatch, event, audit, provenance, repository: options.repository })))).digest("hex"),
  };
}
