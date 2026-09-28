import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Db } from "@paperclipai/db";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { expect, it, vi } from "vitest";
import { validateBoundRepositorySource } from "./repository-bound-source.js";

function fixture() {
  const id = () => randomUUID();
  const request: RepositoryExecutionRequest = { schemaVersion: 1, kind: "target_repository_execution", workspaceId: id(), targetId: id(),
    targetRevisionId: id(), graphRevisionId: id(), workNodeId: id(), runId: id(), runAttemptId: id(), leaseId: id(), fencingToken: 1,
    agentVersionId: id(), deploymentRevisionId: id(), runtime: "opencode", model: "fixture/test", instructions: "Test", timeoutSeconds: 60,
    output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 }, source: { artifactId: id(), contentHash: "a".repeat(64), baseCommit: "b".repeat(40), format: "git_bundle" } };
  const manifest = { schemaVersion: 1, workspaceId: request.workspaceId, targetId: request.targetId, targetRevisionId: request.targetRevisionId,
    graphRevisionId: request.graphRevisionId, bindingId: id(), connectionId: id(), repository: "owner/repo", ref: "main",
    baseCommit: request.source.baseCommit, authorizationContextHash: "c".repeat(64),
    source: { artifactId: request.source.artifactId, artifactRevisionId: id(), contentHash: request.source.contentHash } };
  let body = Buffer.from(JSON.stringify(manifest));
  const query = { select: vi.fn(), from: vi.fn(), innerJoin: vi.fn(), where: vi.fn(), limit: vi.fn() };
  for (const method of [query.select, query.from, query.innerJoin, query.where]) method.mockReturnValue(query);
  const configure = (value = manifest) => {
    body = Buffer.from(JSON.stringify(value));
    const contentHash = createHash("sha256").update(body).digest("hex");
    query.limit.mockReset().mockResolvedValueOnce([{ contentHash, contentRef: `storage:${request.workspaceId}/verrail/run-artifacts/sha256/${contentHash}` }])
      .mockResolvedValueOnce([{ contentRef: `storage:${request.workspaceId}/verrail/run-artifacts/sha256/${request.source.contentHash}` }]);
  };
  configure();
  const getObject = vi.fn(async () => ({ stream: Readable.from([body]), contentLength: body.length }));
  const options = { db: query as unknown as Db, request, storage: { getObject }, signal: new AbortController().signal };
  return { options, manifest, configure, query, getObject };
}

it("resolves the Run-selected manifest and exact registered source revision", async () => {
  const f = fixture(); expect(await validateBoundRepositorySource(f.options)).toEqual(f.manifest);
  expect(f.query.limit).toHaveBeenCalledTimes(2); expect(f.getObject).toHaveBeenCalledTimes(1);
});

it("requires a persisted Run source before reading any object", async () => {
  const f = fixture(); f.query.limit.mockReset().mockResolvedValue([]);
  await expect(validateBoundRepositorySource(f.options)).rejects.toThrow("BINDING_REQUIRED");
  expect(f.getObject).not.toHaveBeenCalled();
});

it.each(["workspaceId", "targetId", "targetRevisionId", "graphRevisionId"] as const)("rejects manifest %s mismatch", async field => {
  const f = fixture(); f.configure({ ...f.manifest, [field]: randomUUID() });
  await expect(validateBoundRepositorySource(f.options)).rejects.toThrow("BINDING_INVALID");
  expect(f.query.limit).toHaveBeenCalledTimes(1);
});

it("rejects a substituted source commit or bundle", async () => {
  for (const field of ["baseCommit", "contentHash", "artifactId"] as const) {
    const f = fixture();
    f.options.request.source[field] = field === "artifactId" ? randomUUID() : "d".repeat(field === "baseCommit" ? 40 : 64);
    await expect(validateBoundRepositorySource(f.options)).rejects.toThrow("BINDING_INVALID");
  }
});

it("rejects tampering and oversized manifest streams", async () => {
  for (const body of [Buffer.from("tampered"), Buffer.alloc(65537)]) {
    const f = fixture(); f.getObject.mockResolvedValue({ stream: Readable.from([body]), contentLength: body.length });
    await expect(validateBoundRepositorySource(f.options)).rejects.toThrow("BINDING_INVALID");
  }
});

it("rejects a source revision absent from the selected workspace and Target", async () => {
  const f = fixture();
  const content = Buffer.from(JSON.stringify(f.manifest));
  const contentHash = createHash("sha256").update(content).digest("hex");
  f.query.limit.mockReset().mockResolvedValueOnce([{ contentHash,
    contentRef: `storage:${f.options.request.workspaceId}/verrail/run-artifacts/sha256/${contentHash}` }]).mockResolvedValueOnce([]);
  await expect(validateBoundRepositorySource(f.options)).rejects.toThrow("BINDING_INVALID");
});
