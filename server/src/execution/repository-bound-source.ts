import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, verrailRuns, verrailRunSources, verrailArtifacts, verrailArtifactRevisions } from "@paperclipai/db";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { repositorySourceProvenanceSchema } from "./repository-source-registration.js";

const manifestSchema = repositorySourceProvenanceSchema.extend({ source: z.object({
  artifactId: z.string().uuid(), artifactRevisionId: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict() }).strict();

const identitySchema = repositoryExecutionRequestSchema.pick({ workspaceId: true, runId: true,
  targetId: true, targetRevisionId: true, graphRevisionId: true, workNodeId: true }).strip();

export async function loadBoundRepositorySource(options: {
  db: Db; storage: Pick<StorageService, "getObject">; request: z.infer<typeof identitySchema>; signal: AbortSignal;
}) {
  const request = identitySchema.parse(options.request);
  const { db, signal } = options;
  signal.throwIfAborted();
  const [revision] = await db.select({ contentHash: verrailArtifactRevisions.contentHash, contentRef: verrailArtifactRevisions.contentRef })
    .from(verrailRunSources)
    .innerJoin(verrailRuns, and(eq(verrailRuns.id, verrailRunSources.runId), eq(verrailRuns.workspaceId, verrailRunSources.workspaceId)))
    .innerJoin(verrailArtifactRevisions, and(eq(verrailArtifactRevisions.id, verrailRunSources.repositorySourceRevisionId), eq(verrailArtifactRevisions.workspaceId, verrailRunSources.workspaceId)))
    .innerJoin(verrailArtifacts, and(eq(verrailArtifacts.id, verrailArtifactRevisions.artifactId), eq(verrailArtifacts.workspaceId, verrailArtifactRevisions.workspaceId)))
    .where(and(eq(verrailRunSources.workspaceId, request.workspaceId), eq(verrailRunSources.runId, request.runId),
      eq(verrailRuns.targetId, request.targetId), eq(verrailRuns.targetRevisionId, request.targetRevisionId),
      eq(verrailRuns.graphRevisionId, request.graphRevisionId), eq(verrailRuns.workNodeId, request.workNodeId),
      eq(verrailArtifacts.targetId, request.targetId), eq(verrailArtifacts.kind, "report"))).limit(1);
  signal.throwIfAborted();
  if (!revision || !/^[a-f0-9]{64}$/.test(revision.contentHash)) throw new Error("REPOSITORY_SOURCE_BINDING_REQUIRED");
  const key = `${request.workspaceId}/verrail/run-artifacts/sha256/${revision.contentHash}`;
  if (revision.contentRef !== `storage:${key}`) throw new Error("REPOSITORY_SOURCE_BINDING_INVALID");
  const object = await options.storage.getObject(request.workspaceId, key);
  const abort = () => object.stream.destroy(new Error("REPOSITORY_SOURCE_CANCELED"));
  signal.addEventListener("abort", abort, { once: true });
  let manifest: z.infer<typeof manifestSchema>;
  try {
    signal.throwIfAborted();
    if (object.contentLength !== undefined && (!Number.isSafeInteger(object.contentLength) || object.contentLength < 1 || object.contentLength > 65536)) {
      throw new Error("REPOSITORY_SOURCE_BINDING_INVALID");
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of object.stream) {
      signal.throwIfAborted();
      const value = Buffer.from(chunk); length += value.length;
      if (length > 65536) throw new Error("REPOSITORY_SOURCE_BINDING_INVALID");
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    if (!length || (object.contentLength !== undefined && object.contentLength !== length)
      || createHash("sha256").update(body).digest("hex") !== revision.contentHash) throw new Error("REPOSITORY_SOURCE_BINDING_INVALID");
    manifest = manifestSchema.parse(JSON.parse(body.toString("utf8")));
  } finally {
    signal.removeEventListener("abort", abort); object.stream.destroy();
  }
  signal.throwIfAborted();
  for (const field of ["workspaceId", "targetId", "targetRevisionId", "graphRevisionId"] as const) {
    if (manifest[field] !== request[field]) throw new Error("REPOSITORY_SOURCE_BINDING_INVALID");
  }
  const [source] = await db.select({ contentRef: verrailArtifactRevisions.contentRef }).from(verrailArtifactRevisions)
    .innerJoin(verrailArtifacts, and(eq(verrailArtifacts.id, verrailArtifactRevisions.artifactId), eq(verrailArtifacts.workspaceId, verrailArtifactRevisions.workspaceId)))
    .where(and(eq(verrailArtifactRevisions.id, manifest.source.artifactRevisionId), eq(verrailArtifactRevisions.workspaceId, request.workspaceId),
      eq(verrailArtifactRevisions.artifactId, manifest.source.artifactId), eq(verrailArtifactRevisions.contentHash, manifest.source.contentHash),
      eq(verrailArtifacts.targetId, request.targetId), eq(verrailArtifacts.kind, "code_change"))).limit(1);
  signal.throwIfAborted();
  if (source?.contentRef !== `storage:${request.workspaceId}/verrail/run-artifacts/sha256/${manifest.source.contentHash}`) {
    throw new Error("REPOSITORY_SOURCE_BINDING_INVALID");
  }
  return manifest;
}

export async function validateBoundRepositorySource(options: {
  db: Db; storage: Pick<StorageService, "getObject">; request: RepositoryExecutionRequest; signal: AbortSignal;
}) {
  const request = repositoryExecutionRequestSchema.parse(options.request);
  const manifest = await loadBoundRepositorySource({ ...options, request });
  if (manifest.baseCommit !== request.source.baseCommit || manifest.source.artifactId !== request.source.artifactId
    || manifest.source.contentHash !== request.source.contentHash) throw new Error("REPOSITORY_SOURCE_BINDING_INVALID");
  return manifest;
}
