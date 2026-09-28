import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, verrailTargets, verrailTargetRevisions, verrailArtifacts, verrailArtifactRevisions } from "@paperclipai/db";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createRepositorySourceReader } from "./repository-source.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("repository source registration in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("verrail-repository-source-");
    db = createDb(database.connectionString);
    directory = await mkdtemp(join(tmpdir(), "verrail-repository-objects-"));
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("rejects foreign targets, workspaces, kinds and unregistered hashes before reading storage", async () => {
    const author = { createdByPrincipalType: "user", createdByPrincipalId: "fixture" };
    const [workspace] = await db.insert(companies).values({ name: "Source fixture", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const workspaceId = workspace.id;
    const targetId = randomUUID();
    const targetRevisionId = randomUUID();
    await db.insert(verrailTargets).values({ id: targetId, workspaceId, activeTargetRevisionId: targetRevisionId, ...author });
    await db.insert(verrailTargetRevisions).values({ id: targetRevisionId, workspaceId, targetId,
      revisionNumber: 1, title: "Source fixture", goal: "Verify input scope", constraints: [], acceptanceCriteria: [],
      outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "fixture", riskLevel: "low", contentHash: "a".repeat(64), ...author });
    const storage = createStorageService(createLocalDiskStorageProvider(directory));
    const body = Buffer.from("registered bundle bytes; Git format is validated by checkout");
    const stored = await storage.putFile({ companyId: workspaceId, namespace: "verrail/run-artifacts",
      originalFilename: "source.bundle", contentType: "application/octet-stream", body, contentAddressed: true });
    const artifactId = randomUUID();
    await db.insert(verrailArtifacts).values({ id: artifactId, workspaceId, targetId, kind: "code_change", title: "Source", ...author });
    await db.insert(verrailArtifactRevisions).values({ id: randomUUID(), workspaceId, artifactId, revisionNumber: 1,
      contentHash: stored.sha256, contentRef: `storage:${stored.objectKey}`, ...author });
    const request: RepositoryExecutionRequest = {
      schemaVersion: 1, kind: "target_repository_execution", workspaceId, targetId,
      targetRevisionId, graphRevisionId: randomUUID(), workNodeId: randomUUID(),
      runId: randomUUID(), runAttemptId: randomUUID(), leaseId: randomUUID(), fencingToken: 1,
      agentVersionId: randomUUID(), deploymentRevisionId: randomUUID(),
      source: { artifactId, contentHash: stored.sha256, baseCommit: "a".repeat(40), format: "git_bundle" },
      runtime: "opencode", model: "fixture/test", instructions: "Test", timeoutSeconds: 60,
      output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 },
    };
    const getObject = vi.fn(storage.getObject.bind(storage));
    const read = createRepositorySourceReader(db, { getObject });
    const signal = new AbortController().signal;
    expect(await read(request, signal)).toEqual(body);
    getObject.mockClear();
    for (const foreign of [
      { ...request, targetId: randomUUID() },
      { ...request, workspaceId: randomUUID() },
      { ...request, source: { ...request.source, contentHash: createHash("sha256").update("different").digest("hex") } },
    ]) await expect(read(foreign, signal)).rejects.toThrow("REPOSITORY_SOURCE_NOT_REGISTERED");
    const reportId = randomUUID();
    await db.insert(verrailArtifacts).values({ id: reportId, workspaceId, targetId, kind: "report", title: "Not source", ...author });
    await db.insert(verrailArtifactRevisions).values({ id: randomUUID(), workspaceId, artifactId: reportId,
      revisionNumber: 1, contentHash: stored.sha256, contentRef: `storage:${stored.objectKey}`, ...author });
    await expect(read({ ...request, source: { ...request.source, artifactId: reportId } }, signal))
      .rejects.toThrow("REPOSITORY_SOURCE_NOT_REGISTERED");
    expect(getObject).not.toHaveBeenCalled();
  });
});
