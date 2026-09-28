import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Db } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { buildOfferedRepositoryRequest } from "./repository-request-builder.js";

function fixture() {
  const id = () => randomUUID();
  const identity = { workspaceId: id(), targetId: id(), targetRevisionId: id(), graphRevisionId: id(), workNodeId: id(),
    runId: id(), runAttemptId: id(), agentVersionId: id(), deploymentRevisionId: id(), leaseId: id(), fencingToken: 2 };
  const manifest = { schemaVersion: 1, workspaceId: identity.workspaceId, targetId: identity.targetId,
    targetRevisionId: identity.targetRevisionId, graphRevisionId: identity.graphRevisionId, repository: "owner/repo",
    ref: "main", bindingId: id(), connectionId: id(), baseCommit: "a".repeat(40), authorizationContextHash: "b".repeat(64),
    source: { artifactId: id(), artifactRevisionId: id(), contentHash: "c".repeat(64) } };
  const body = Buffer.from(JSON.stringify(manifest));
  const contentHash = createHash("sha256").update(body).digest("hex");
  const context = { runtime: "opencode", model: "fixture/pinned", prompt: "Published instruction", title: "Pinned target",
    goal: "Update code", constraints: ["No push"], acceptanceCriteria: [], nodeTitle: "Implement task", completionDefinition: "Patch reviewed" };
  const query = { select: vi.fn(), from: vi.fn(), innerJoin: vi.fn(), where: vi.fn(), limit: vi.fn(), execute: vi.fn().mockResolvedValue([{ id: identity.leaseId }]) };
  for (const fn of [query.select, query.from, query.innerJoin, query.where]) fn.mockReturnValue(query);
  const configure = () => query.limit.mockReset().mockResolvedValueOnce([context])
    .mockResolvedValueOnce([{ contentHash, contentRef: `storage:${identity.workspaceId}/verrail/run-artifacts/sha256/${contentHash}` }])
    .mockResolvedValueOnce([{ contentRef: `storage:${identity.workspaceId}/verrail/run-artifacts/sha256/${manifest.source.contentHash}` }]);
  configure();
  const storage = { getObject: vi.fn(async () => ({ stream: Readable.from([body]), contentLength: body.length })) };
  return { identity, manifest, context, query, configure, storage,
    options: { identity, db: query as unknown as Db, storage, signal: new AbortController().signal,
      timeoutSeconds: 300, output: { maxFiles: 4, maxFileBytes: 1048576, maxTotalBytes: 4194304 } } };
}

it("builds from pinned domain context and registered source, then checks offered authority", async () => {
  const f = fixture(); const request = await buildOfferedRepositoryRequest(f.options);
  expect(request).toMatchObject({ ...f.identity, model: "fixture/pinned", runtime: "opencode",
    source: { artifactId: f.manifest.source.artifactId, contentHash: f.manifest.source.contentHash, baseCommit: f.manifest.baseCommit } });
  expect(request.instructions).toContain("Published instruction");
  expect(request.instructions).toContain("No push");
  expect(request.instructions).toContain("Patch reviewed");
  expect(request.instructions).not.toContain("authorizationContextHash");
  expect(f.query.execute).toHaveBeenCalledTimes(1);
});

it("rejects absent or mismatched Run context before source access", async () => {
  const f = fixture(); f.query.limit.mockReset().mockResolvedValueOnce([]);
  await expect(buildOfferedRepositoryRequest(f.options)).rejects.toThrow("RUN_INPUT_UNAVAILABLE");
  expect(f.storage.getObject).not.toHaveBeenCalled();
});

it("refuses an expired or already claimed offer", async () => {
  const f = fixture(); f.query.execute.mockResolvedValue([]);
  await expect(buildOfferedRepositoryRequest(f.options)).rejects.toThrow("LEASE_LOST");
});

it("rejects non-OpenCode runtime and oversized execution limits", async () => {
  const f = fixture(); f.context.runtime = "host_trusted"; f.configure();
  await expect(buildOfferedRepositoryRequest(f.options)).rejects.toThrow();
  const limit = fixture(); limit.options.timeoutSeconds = 3601;
  await expect(buildOfferedRepositoryRequest(limit.options)).rejects.toThrow();
});

it("honors cancellation before querying domain state", async () => {
  const f = fixture();
  await expect(buildOfferedRepositoryRequest({ ...f.options, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(f.query.select).not.toHaveBeenCalled();
});
