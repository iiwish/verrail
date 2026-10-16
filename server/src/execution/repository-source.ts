import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { verrailArtifacts, verrailArtifactRevisions, type Db } from "@paperclipai/db";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export function createRepositorySourceReader(db: Db, storage: Pick<StorageService, "getObject">) {
  // The attempt controller separately authorizes the lease and selected input.
  // This reader verifies registered source scope and bytes, not dispatch authority.
  return async (raw: RepositoryExecutionRequest, signal: AbortSignal): Promise<Buffer> => {
    const request = repositoryExecutionRequestSchema.parse(raw);
    signal.throwIfAborted();
    const [revision] = await db.select({ contentRef: verrailArtifactRevisions.contentRef })
      .from(verrailArtifactRevisions)
      .innerJoin(verrailArtifacts, and(
        eq(verrailArtifacts.id, verrailArtifactRevisions.artifactId),
        eq(verrailArtifacts.workspaceId, verrailArtifactRevisions.workspaceId),
      ))
      .where(and(
        eq(verrailArtifacts.workspaceId, request.workspaceId),
        eq(verrailArtifacts.targetId, request.targetId),
        eq(verrailArtifacts.kind, "code_change"),
        eq(verrailArtifactRevisions.artifactId, request.source.artifactId),
        eq(verrailArtifactRevisions.contentHash, request.source.contentHash),
      )).limit(1);
    signal.throwIfAborted();
    const key = `${request.workspaceId}/verrail/run-artifacts/sha256/${request.source.contentHash}`;
    if (revision?.contentRef !== `storage:${key}`) throw new Error("REPOSITORY_SOURCE_NOT_REGISTERED");
    const object = await storage.getObject(request.workspaceId, key);
    const abort = () => object.stream.destroy(new Error("REPOSITORY_SOURCE_CANCELED"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (object.contentLength !== undefined && (!Number.isSafeInteger(object.contentLength)
        || object.contentLength < 1 || object.contentLength > MAX_SOURCE_BYTES)) {
        throw new Error("REPOSITORY_SOURCE_INVALID");
      }
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of object.stream) {
        signal.throwIfAborted();
        const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += body.length;
        if (bytes > MAX_SOURCE_BYTES) throw new Error("REPOSITORY_SOURCE_INVALID");
        hash.update(body);
        chunks.push(body);
      }
      signal.throwIfAborted();
      if (bytes === 0 || (object.contentLength !== undefined && bytes !== object.contentLength)
        || hash.digest("hex") !== request.source.contentHash) throw new Error("REPOSITORY_SOURCE_INVALID");
      return Buffer.concat(chunks, bytes);
    } finally {
      signal.removeEventListener("abort", abort);
      object.stream.destroy();
    }
  };
}
