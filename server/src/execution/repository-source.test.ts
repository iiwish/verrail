import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { createRepositorySourceReader } from "./repository-source.js";

const id = "11111111-1111-4111-8111-111111111111";
const body = Buffer.from("bundle transport fixture");
const hash = createHash("sha256").update(body).digest("hex");
const request: RepositoryExecutionRequest = {
  schemaVersion: 1, kind: "target_repository_execution", workspaceId: id, targetId: id,
  targetRevisionId: id, graphRevisionId: id, workNodeId: id, runId: id, runAttemptId: id,
  leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id,
  source: { artifactId: id, contentHash: hash, baseCommit: "b".repeat(40), format: "git_bundle" },
  runtime: "opencode", model: "fixture/test", instructions: "Test", timeoutSeconds: 60,
  output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 },
};
const key = `${id}/verrail/run-artifacts/sha256/${hash}`;
function fixture(contentRef: string | null = `storage:${key}`, stream = Readable.from([body]), contentLength?: number) {
  const query = { select: vi.fn(), from: vi.fn(), innerJoin: vi.fn(), where: vi.fn(),
    limit: vi.fn(async () => contentRef === null ? [] : [{ contentRef }]) };
  for (const method of [query.select, query.from, query.innerJoin, query.where]) method.mockReturnValue(query);
  const storage = { getObject: vi.fn(async () => ({ stream, contentLength })) };
  return { read: createRepositorySourceReader(query as unknown as Db, storage), query, storage, stream };
}

it("reads only a registered scoped content-addressed input and checks byte identity", async () => {
  const test = fixture(undefined, undefined, body.length);
  expect(await test.read(request, new AbortController().signal)).toEqual(body);
  expect(test.storage.getObject).toHaveBeenCalledWith(id, key);
  const where = new PgDialect().sqlToQuery(test.query.where.mock.calls[0][0] as SQL);
  expect(where.params).toEqual([id, id, "code_change", id, hash]);
  expect(where.sql).toContain('"verrail_artifacts"."workspace_id"');
  expect(where.sql).toContain('"verrail_artifacts"."target_id"');
  expect(where.sql).toContain('"verrail_artifact_revisions"."content_hash"');
  expect(test.stream.destroyed).toBe(true);
});

it.each([null, "file:/etc/passwd", "https://example.test/source", `storage:foreign/${hash}`])(
  "refuses unregistered or noncanonical reference %s before storage access", async ref => {
    const test = fixture(ref);
    await expect(test.read(request, new AbortController().signal)).rejects.toThrow("REPOSITORY_SOURCE_NOT_REGISTERED");
    expect(test.storage.getObject).not.toHaveBeenCalled();
  });

it("rejects mismatched hashes, truncated objects and oversized streams", async () => {
  for (const [stream, length] of [
    [Readable.from([Buffer.from("different")]), undefined],
    [Readable.from([body]), body.length + 1],
    [Readable.from([Buffer.alloc(32 * 1024 * 1024), Buffer.from("x")]), undefined],
    [Readable.from([body]), 32 * 1024 * 1024 + 1],
  ] as const) {
    const test = fixture(undefined, stream, length);
    await expect(test.read(request, new AbortController().signal)).rejects.toThrow("REPOSITORY_SOURCE_INVALID");
    expect(stream.destroyed).toBe(true);
  }
});

it("cancels a stalled read and destroys its stream", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const stream = new Readable({ read() { started(); } });
  const test = fixture(undefined, stream);
  const execution = test.read(request, controller.signal);
  const rejected = expect(execution).rejects.toThrow("REPOSITORY_SOURCE_CANCELED");
  await ready;
  controller.abort();
  await rejected;
  expect(stream.destroyed).toBe(true);
});
