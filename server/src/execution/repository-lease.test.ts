import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, companies, verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions,
  verrailWorkNodes, verrailAgentDefinitions, verrailAgentVersions, verrailEvaluationRuns, verrailDeployments,
  verrailDeploymentRevisions, verrailRuns, verrailRunAttempts, verrailExecutionLeases, verrailRepositoryDispatches } from "@paperclipai/db";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createRepositoryClaimedLeaseValidator, createRepositoryLeaseValidator, createRepositoryOfferedLeaseValidator } from "./repository-lease.js";
import { createRepositoryDispatchStore } from "./repository-dispatch.js";
import { listPendingRepositorySuccesses, reconcileSucceededRepositoryRun, listPendingRepositoryCompletions,
  reconcileRepositoryCompletion } from "./repository-reconciliation.js";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { listOfferedRepositoryAttempts } from "./repository-offers.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("repository lease authority in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("verrail-repository-lease-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const author = { createdByPrincipalType: "user", createdByPrincipalId: "fixture" };
    const [workspace] = await db.insert(companies).values({ name: "Lease fixture", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const workspaceId = workspace.id;
    const targetId = randomUUID(), targetRevisionId = randomUUID(), graphId = randomUUID(), graphRevisionId = randomUUID(), workNodeId = randomUUID();
    const definitionId = randomUUID(), agentVersionId = randomUUID(), evaluationId = randomUUID(), deploymentId = randomUUID(), deploymentRevisionId = randomUUID();
    const runId = randomUUID(), runAttemptId = randomUUID(), leaseId = randomUUID();
    const contentHash = "a".repeat(64);
    await db.insert(verrailTargets).values({ id: targetId, workspaceId, activeTargetRevisionId: targetRevisionId, status: "active", ...author });
    await db.insert(verrailTargetRevisions).values({ id: targetRevisionId, workspaceId, targetId, revisionNumber: 1, title: "Test", goal: "Test",
      constraints: [], acceptanceCriteria: [], outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "fixture", riskLevel: "low", contentHash, ...author });
    await db.insert(verrailWorkGraphs).values({ id: graphId, workspaceId, targetId, activeGraphRevisionId: graphRevisionId, status: "active" });
    await db.insert(verrailGraphRevisions).values({ id: graphRevisionId, workspaceId, targetId, targetRevisionId, workGraphId: graphId, revisionNumber: 1, status: "active", contentHash, ...author });
    await db.insert(verrailWorkNodes).values({ id: workNodeId, workspaceId, targetId, graphRevisionId, nodeKey: "code", kind: "agent_task", title: "Code", stageKey: "execute", status: "running", completionDefinition: "Submit code" });
    await db.insert(verrailAgentDefinitions).values({ id: definitionId, workspaceId, name: "Coder", ...author });
    await db.insert(verrailAgentVersions).values({ id: agentVersionId, workspaceId, agentDefinitionId: definitionId, versionNumber: 1, runtime: "opencode", model: "fixture/test", prompt: "Test", contentHash, ...author });
    await db.insert(verrailEvaluationRuns).values({ id: evaluationId, workspaceId, candidateAgentVersionId: agentVersionId, status: "passed", safetyStatus: "passed", ...author });
    await db.insert(verrailDeployments).values({ id: deploymentId, workspaceId, agentDefinitionId: definitionId, name: "Coder", ...author });
    await db.insert(verrailDeploymentRevisions).values({ id: deploymentRevisionId, workspaceId, deploymentId, revisionNumber: 1, agentVersionId, evaluationRunId: evaluationId, state: "active", contentHash, ...author });
    await db.insert(verrailRuns).values({ id: runId, workspaceId, targetId, targetRevisionId, graphRevisionId, workNodeId, kind: "agent", status: "running", actorPrincipalType: "agent", actorPrincipalId: deploymentRevisionId, deploymentRevisionId, agentVersionId, attemptCount: 1, idempotencyKey: randomUUID() });
    await db.insert(verrailRunAttempts).values({ id: runAttemptId, workspaceId, runId, attemptNumber: 1, deploymentRevisionId, agentVersionId,
      runtimeProfile: "repository_sandbox", executorPrincipalType: "service", executorPrincipalId: "verrail-repository-runner", fencingToken: 1, status: "running", idempotencyKey: randomUUID() });
    await db.insert(verrailExecutionLeases).values({ id: leaseId, workspaceId, runId, runAttemptId, executorPrincipalId: "verrail-repository-runner",
      runtimeProfile: "repository_sandbox", fencingToken: 1, status: "active", expiresAt: new Date(Date.now() + 60_000), graceExpiresAt: new Date(Date.now() + 90_000) });
    const request: RepositoryExecutionRequest = { schemaVersion: 1, kind: "target_repository_execution", workspaceId, targetId, targetRevisionId,
      graphRevisionId, workNodeId, runId, runAttemptId, leaseId, fencingToken: 1, agentVersionId, deploymentRevisionId,
      source: { artifactId: randomUUID(), contentHash, baseCommit: "b".repeat(40), format: "git_bundle" },
      runtime: "opencode", model: "fixture/test", instructions: "Test", timeoutSeconds: 60,
      output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 } };
    const validate = () => createRepositoryLeaseValidator(db)(request, new AbortController().signal);
    return { request, validate, deploymentId };
  }

  it("requires every bound identity and the current fence", async () => {
    const { request, validate } = await seed();
    await expect(validate()).resolves.toBeUndefined();
    for (const field of ["workspaceId", "targetId", "targetRevisionId", "graphRevisionId", "workNodeId", "runId", "runAttemptId", "leaseId", "agentVersionId", "deploymentRevisionId"] as const) {
      await expect(createRepositoryLeaseValidator(db)({ ...request, [field]: randomUUID() }, new AbortController().signal)).rejects.toThrow("REPOSITORY_LEASE_LOST");
    }
    await expect(createRepositoryLeaseValidator(db)({ ...request, fencingToken: 2 }, new AbortController().signal)).rejects.toThrow("REPOSITORY_LEASE_LOST");
    await expect(createRepositoryLeaseValidator(db)({ ...request, model: "fixture/other" }, new AbortController().signal)).rejects.toThrow("REPOSITORY_LEASE_LOST");
  });

  it.each(["cancel", "expire", "suspect", "archive", "pause", "graph", "attempt"])("revokes execution for %s", async change => {
    const { request: r, validate, deploymentId } = await seed();
    if (change === "cancel") await db.update(verrailRuns).set({ cancelRequestedAt: new Date() }).where(eq(verrailRuns.id, r.runId));
    if (change === "expire") await db.update(verrailExecutionLeases).set({ expiresAt: new Date(0) }).where(eq(verrailExecutionLeases.id, r.leaseId));
    if (change === "suspect") await db.update(verrailExecutionLeases).set({ status: "suspect" }).where(eq(verrailExecutionLeases.id, r.leaseId));
    if (change === "archive") await db.update(verrailTargets).set({ archivedAt: new Date() }).where(eq(verrailTargets.id, r.targetId));
    if (change === "pause") await db.update(verrailDeployments).set({ status: "paused" }).where(eq(verrailDeployments.id, deploymentId));
    if (change === "graph") await db.update(verrailGraphRevisions).set({ status: "superseded" }).where(eq(verrailGraphRevisions.id, r.graphRevisionId));
    if (change === "attempt") await db.update(verrailRuns).set({ attemptCount: 2 }).where(eq(verrailRuns.id, r.runId));
    await expect(validate()).rejects.toThrow("REPOSITORY_LEASE_LOST");
  });

  it("keeps an already-running version pinned after a newer publication", async () => {
    const { request, validate } = await seed();
    await db.update(verrailDeploymentRevisions).set({ state: "superseded" }).where(eq(verrailDeploymentRevisions.id, request.deploymentRevisionId));
    await expect(validate()).resolves.toBeUndefined();
  });

  it("keeps offered, claimed and running admission gates distinct", async () => {
    const { request: r, validate } = await seed();
    const signal = new AbortController().signal;
    const offered = () => createRepositoryOfferedLeaseValidator(db)(r, signal);
    const claimed = () => createRepositoryClaimedLeaseValidator(db)(r, signal);
    const offers = (overrides = {}) => listOfferedRepositoryAttempts({ db, workspaceId: r.workspaceId, signal, ...overrides });
    expect(await offers()).toEqual([]);
    await expect(offered()).rejects.toThrow("LEASE_LOST");
    await expect(claimed()).rejects.toThrow("LEASE_LOST");
    await db.update(verrailRunAttempts).set({ status: "pending" }).where(eq(verrailRunAttempts.id, r.runAttemptId));
    await db.update(verrailRuns).set({ status: "queued" }).where(eq(verrailRuns.id, r.runId));
    await db.update(verrailExecutionLeases).set({ status: "offered" }).where(eq(verrailExecutionLeases.id, r.leaseId));
    await expect(offered()).resolves.toBeUndefined();
    expect(await offers()).toEqual([{ runAttemptId: r.runAttemptId, runId: r.runId, targetId: r.targetId,
      targetRevisionId: r.targetRevisionId, graphRevisionId: r.graphRevisionId, workNodeId: r.workNodeId,
      leaseId: r.leaseId, fencingToken: r.fencingToken, agentVersionId: r.agentVersionId, deploymentRevisionId: r.deploymentRevisionId }]);
    expect(await offers({ workspaceId: randomUUID() })).toEqual([]);
    expect(await offers({ after: r.runAttemptId })).toEqual([]);
    await expect(offers({ limit: 101 })).rejects.toThrow();
    await expect(claimed()).rejects.toThrow("LEASE_LOST");
    await expect(validate()).rejects.toThrow("LEASE_LOST");
    await db.update(verrailExecutionLeases).set({ status: "active" }).where(eq(verrailExecutionLeases.id, r.leaseId));
    await expect(claimed()).resolves.toBeUndefined();
    expect(await offers()).toEqual([]);
    await expect(offered()).rejects.toThrow("LEASE_LOST");
    await expect(validate()).rejects.toThrow("LEASE_LOST");
    await db.update(verrailRuns).set({ cancelRequestedAt: new Date() }).where(eq(verrailRuns.id, r.runId));
    await expect(claimed()).rejects.toThrow("LEASE_LOST");
  });

  it("follows Go graph activation authority even when the Target summary is draft", async () => {
    const { request, validate } = await seed();
    await db.update(verrailTargets).set({ status: "draft" }).where(eq(verrailTargets.id, request.targetId));
    await expect(validate()).resolves.toBeUndefined();
    await db.update(verrailGraphRevisions).set({ status: "draft" }).where(eq(verrailGraphRevisions.id, request.graphRevisionId));
    await expect(validate()).rejects.toThrow("REPOSITORY_LEASE_LOST");
  });

  it("claims once across controllers and binds the entire immutable request", async () => {
    const { request } = await seed();
    const first = createRepositoryDispatchStore(db, randomUUID());
    const second = createRepositoryDispatchStore(db, randomUUID());
    const signal = new AbortController().signal;
    expect(await first.claim(request, signal)).toBe(true);
    expect(await second.claim(request, signal)).toBe(false);
    expect(await first.claim(request, signal)).toBe(false);
    await expect(first.authorize(request, signal)).resolves.toBeUndefined();
    await expect(second.authorize(request, signal)).rejects.toThrow("REPOSITORY_DISPATCH_NOT_ACTIVE");
    await expect(first.authorize({ ...request, instructions: "Changed" }, signal)).rejects.toThrow("REPOSITORY_DISPATCH_NOT_ACTIVE");
    await expect(first.authorize({ ...request, source: { ...request.source, baseCommit: "c".repeat(40) } }, signal)).rejects.toThrow("REPOSITORY_DISPATCH_NOT_ACTIVE");
  });

  it("enforces the durable tool budget under concurrent calls", async () => {
    const { request } = await seed();
    const store = createRepositoryDispatchStore(db, randomUUID());
    const signal = new AbortController().signal;
    expect(await store.claim(request, signal)).toBe(true);
    const outcomes = await Promise.allSettled(Array.from({ length: 25 }, () => store.consumeToolCall(request, signal)));
    expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(20);
    expect(outcomes.filter(item => item.status === "rejected")).toHaveLength(5);
    const [record] = await db.select().from(verrailRepositoryDispatches).where(eq(verrailRepositoryDispatches.runAttemptId, request.runAttemptId));
    expect(record.toolCalls).toBe(20);
    await expect(store.renew(request, signal)).resolves.toBeUndefined();
    await expect(store.consumeToolCall(request, signal)).rejects.toThrow("REPOSITORY_DISPATCH_OR_BUDGET_REJECTED");
  });

  it("never revives an expired controller or admits calls after cancellation", async () => {
    const { request } = await seed();
    const store = createRepositoryDispatchStore(db, randomUUID());
    const signal = new AbortController().signal;
    expect(await store.claim(request, signal)).toBe(true);
    await db.update(verrailRepositoryDispatches).set({ controllerExpiresAt: new Date(0) })
      .where(eq(verrailRepositoryDispatches.runAttemptId, request.runAttemptId));
    await expect(store.renew(request, signal)).rejects.toThrow("REPOSITORY_DISPATCH_NOT_ACTIVE");
    await expect(store.consumeToolCall(request, signal)).rejects.toThrow("REPOSITORY_DISPATCH_OR_BUDGET_REJECTED");
    const other = await seed();
    expect(await store.claim(other.request, signal)).toBe(true);
    await db.update(verrailRuns).set({ status: "cancel_requested" }).where(eq(verrailRuns.id, other.request.runId));
    await expect(store.consumeToolCall(other.request, signal)).rejects.toThrow("REPOSITORY_LEASE_LOST");
  });

  it("records cancellation cleanup only for the owning live fenced dispatch", async () => {
    const { request: r } = await seed();
    const signal = new AbortController().signal;
    const owner = createRepositoryDispatchStore(db, randomUUID());
    const other = createRepositoryDispatchStore(db, randomUUID());
    await owner.claim(r, signal);
    expect(await owner.finishCancellation(r, signal)).toBe(false);
    await db.update(verrailRuns).set({ status: "cancel_requested", cancelRequestedAt: new Date() }).where(eq(verrailRuns.id, r.runId));
    await db.update(verrailRunAttempts).set({ status: "cancel_requested" }).where(eq(verrailRunAttempts.id, r.runAttemptId));
    for (const field of ["workspaceId", "runId", "runAttemptId", "leaseId", "targetId", "graphRevisionId", "agentVersionId"] as const) {
      expect(await owner.finishCancellation({ ...r, [field]: randomUUID() }, signal)).toBe(false);
    }
    expect(await owner.finishCancellation({ ...r, fencingToken: 2 }, signal)).toBe(false);
    await expect(other.finishCancellation(r, signal)).rejects.toThrow("DISPATCH_NOT_ACTIVE");
    await expect(owner.finishCancellation({ ...r, instructions: "substituted" }, signal)).rejects.toThrow("DISPATCH_NOT_ACTIVE");
    expect(await owner.finishCancellation(r, signal)).toBe(true);
    expect(await listPendingRepositoryCompletions({ db, workspaceId: r.workspaceId, signal }))
      .toEqual([{ runAttemptId: r.runAttemptId }]);
    expect(await listPendingRepositorySuccesses({ db, workspaceId: r.workspaceId, signal })).toEqual([]);
    const [run] = await db.select().from(verrailRuns).where(eq(verrailRuns.id, r.runId));
    expect(run.status).toBe("cancel_requested");
    const reportRunEvent = vi.fn<VerrailDomainApiClient["reportRunEvent"]>(async command => ({ schemaVersion: 1,
      runId: r.runId, runAttemptId: r.runAttemptId, cursor: command.input.cursor, eventType: "terminated",
      authoritative: true, rejectionCode: null, runStatus: "canceled", attemptStatus: "canceled", leaseStatus: "released", replayed: false }));
    expect(await reconcileRepositoryCompletion({ db, domainApi: { reportRunEvent }, workspaceId: r.workspaceId,
      runAttemptId: r.runAttemptId, signal })).toEqual({ status: "registered" });
    expect(reportRunEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: expect.objectContaining({
      eventType: "terminated", leaseId: r.leaseId, fencingToken: 1, payload: { cleanupConfirmed: true },
    }) }));
    await db.update(verrailRuns).set({ status: "canceled" }).where(eq(verrailRuns.id, r.runId));
    await db.update(verrailRunAttempts).set({ status: "canceled" }).where(eq(verrailRunAttempts.id, r.runAttemptId));
    reportRunEvent.mockClear();
    expect(await reconcileRepositoryCompletion({ db, domainApi: { reportRunEvent }, workspaceId: r.workspaceId,
      runAttemptId: r.runAttemptId, signal })).toEqual({ status: "registered" });
    expect(reportRunEvent).not.toHaveBeenCalled();
    expect(await listPendingRepositoryCompletions({ db, workspaceId: r.workspaceId, signal })).toEqual([]);
  });

  it.each(["lease", "controller", "attempt", "request"])("refuses cancellation cleanup after losing %s authority", async change => {
    const { request: r } = await seed();
    const signal = new AbortController().signal;
    const store = createRepositoryDispatchStore(db, randomUUID());
    await store.claim(r, signal);
    await db.update(verrailRuns).set({ status: "cancel_requested", cancelRequestedAt: new Date() }).where(eq(verrailRuns.id, r.runId));
    await db.update(verrailRunAttempts).set({ status: "cancel_requested" }).where(eq(verrailRunAttempts.id, r.runAttemptId));
    if (change === "lease") await db.update(verrailExecutionLeases).set({ expiresAt: new Date(0) }).where(eq(verrailExecutionLeases.id, r.leaseId));
    if (change === "controller") await db.update(verrailRepositoryDispatches).set({ controllerExpiresAt: new Date(0) }).where(eq(verrailRepositoryDispatches.runAttemptId, r.runAttemptId));
    if (change === "attempt") await db.update(verrailRuns).set({ attemptCount: 2 }).where(eq(verrailRuns.id, r.runId));
    if (change === "request") await db.update(verrailRuns).set({ cancelRequestedAt: null }).where(eq(verrailRuns.id, r.runId));
    if (change === "controller") await expect(store.finishCancellation(r, signal)).rejects.toThrow("DISPATCH_NOT_ACTIVE");
    else expect(await store.finishCancellation(r, signal)).toBe(false);
    expect(await listPendingRepositoryCompletions({ db, workspaceId: r.workspaceId, signal })).toEqual([]);
  });

  it("cannot mint a cancellation receipt through the generic failure path", async () => {
    const { request: r } = await seed();
    const signal = new AbortController().signal;
    const store = createRepositoryDispatchStore(db, randomUUID());
    await store.claim(r, signal);
    // @ts-expect-error Exercise a caller bypassing the compile-time status gate.
    await expect(store.finishFailure(r, "canceled", signal)).rejects.toThrow();
    const [record] = await db.select().from(verrailRepositoryDispatches)
      .where(eq(verrailRepositoryDispatches.runAttemptId, r.runAttemptId));
    expect(record.status).toBe("dispatched");
  });

  it("persists a bounded result once without changing the Go Run", async () => {
    const { request: r } = await seed();
    const store = createRepositoryDispatchStore(db, randomUUID());
    const signal = new AbortController().signal;
    await store.claim(r, signal);
    const artifact = { ordinal: 0, path: "changes.patch", title: "Changes", kind: "code_change", bytes: 10,
      contentHash: "d".repeat(64), contentRef: `storage:${r.workspaceId}/verrail/run-artifacts/sha256/${"d".repeat(64)}` };
    const result = { runId: r.runId, runAttemptId: r.runAttemptId, leaseId: r.leaseId,
      fencingToken: r.fencingToken, source: r.source, artifacts: [artifact] };
    for (const invalid of [{ ...result, fencingToken: 2 }, { ...result, source: { ...r.source, baseCommit: "e".repeat(40) } },
      { ...result, artifacts: [{ ...artifact, bytes: 1025 }] }, { ...result, artifacts: [{ ...artifact, contentRef: "file:/tmp/output" }] }]) {
      await expect(store.finishSucceeded(r, invalid, signal)).rejects.toThrow("REPOSITORY_RESULT_INVALID");
    }
    await store.finishSucceeded(r, result, signal);
    const [record] = await db.select().from(verrailRepositoryDispatches).where(eq(verrailRepositoryDispatches.runAttemptId, r.runAttemptId));
    expect(record.status).toBe("succeeded");
    expect(record.result).toEqual(result);
    expect(record.finishedAt).not.toBeNull();
    const [run] = await db.select().from(verrailRuns).where(eq(verrailRuns.id, r.runId));
    expect(run.status).toBe("running");
    const pending = (overrides = {}) => listPendingRepositorySuccesses({ db, workspaceId: r.workspaceId, signal, ...overrides });
    expect(await pending()).toEqual([{ runAttemptId: r.runAttemptId }]);
    expect(await pending({ workspaceId: randomUUID() })).toEqual([]);
    expect(await pending({ after: r.runAttemptId })).toEqual([]);
    await expect(pending({ limit: 101 })).rejects.toThrow();
    await expect(pending({ signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(store.finishFailure(r, "failed", signal)).rejects.toThrow("REPOSITORY_DISPATCH_NOT_ACTIVE");
    await expect(store.consumeToolCall(r, signal)).rejects.toThrow("REPOSITORY_DISPATCH_OR_BUDGET_REJECTED");
    // The database is real; the Go transaction is simulated at this boundary.
    const reportRunEvent = vi.fn<VerrailDomainApiClient["reportRunEvent"]>(async command => {
      await db.update(verrailRunAttempts).set({ status: "succeeded", result: command.input.payload })
        .where(eq(verrailRunAttempts.id, r.runAttemptId));
      await db.update(verrailRuns).set({ status: "succeeded" }).where(eq(verrailRuns.id, r.runId));
      return { schemaVersion: 1, authoritative: true, rejectionCode: null, runId: r.runId, runAttemptId: r.runAttemptId,
        cursor: command.input.cursor, eventType: "succeeded", runStatus: "succeeded", attemptStatus: "succeeded", leaseStatus: "released", replayed: false };
    });
    const reconcile = () => reconcileSucceededRepositoryRun({ db, domainApi: { reportRunEvent },
      workspaceId: r.workspaceId, runAttemptId: r.runAttemptId, signal });
    expect(await reconcile()).toEqual({ status: "registered" });
    expect(reportRunEvent).toHaveBeenCalledTimes(1);
    expect(await pending()).toEqual([]);
    expect(await reconcile()).toEqual({ status: "registered" });
    expect(reportRunEvent).toHaveBeenCalledTimes(1);
    await db.update(verrailRunAttempts).set({ result: { repositoryOutput: { ...result, artifacts: [{ ...artifact, title: "Different" }] } } })
      .where(eq(verrailRunAttempts.id, r.runAttemptId));
    await expect(reconcile()).rejects.toThrow("REPOSITORY_RESULT_CONFLICT");
  });

  it("restarts the actual recovery process after an interrupted registration", async () => {
    const { request: r } = await seed();
    const store = createRepositoryDispatchStore(db, randomUUID());
    const signal = new AbortController().signal;
    await store.claim(r, signal);
    const result = { runId: r.runId, runAttemptId: r.runAttemptId, leaseId: r.leaseId,
      fencingToken: r.fencingToken, source: r.source, artifacts: [{ ordinal: 0, path: "changes.patch",
        title: "Changes", kind: "code_change", bytes: 10, contentHash: "d".repeat(64),
        contentRef: `storage:${r.workspaceId}/verrail/run-artifacts/sha256/${"d".repeat(64)}` }] };
    await store.finishSucceeded(r, result, signal);
    let requests = 0;
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        received.push(body);
        requests++;
        if (requests === 1) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write('{"pending":');
          return;
        }
        // Local domain transport fixture, not a replacement for Go acceptance.
        await db.update(verrailRunAttempts).set({ status: "succeeded", result: body.payload })
          .where(eq(verrailRunAttempts.id, r.runAttemptId));
        await db.update(verrailRuns).set({ status: "succeeded" }).where(eq(verrailRuns.id, r.runId));
        response.end(JSON.stringify({ schemaVersion: 1, authoritative: true, rejectionCode: null,
          runId: r.runId, runAttemptId: r.runAttemptId, cursor: body.cursor, eventType: "succeeded",
          runStatus: "succeeded", attemptStatus: "succeeded", leaseStatus: "released", replayed: false }));
      })().catch(() => response.destroy());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const children: ReturnType<typeof spawn>[] = [];
    const start = () => {
      const child = spawn(process.execPath, ["--import", "./server/node_modules/tsx/dist/loader.mjs",
        "server/src/execution/repository-recovery-main.ts"], { cwd: root, stdio: "ignore", env: {
        PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: database.connectionString,
        VERRAIL_DOMAIN_API_URL: `http://127.0.0.1:${address.port}`, VERRAIL_DOMAIN_API_TOKEN: "fixture-token-123456",
        VERRAIL_REPOSITORY_WORKSPACE_IDS: JSON.stringify([r.workspaceId]),
        VERRAIL_REPOSITORY_RECOVERY_HEALTH_PORT: "0",
      } });
      children.push(child);
      return child;
    };
    try {
      const first = start();
      await vi.waitFor(() => expect(requests).toBe(1), { timeout: 10_000 });
      const killed = once(first, "exit");
      first.kill("SIGKILL");
      await killed;
      const second = start();
      await vi.waitFor(async () => {
        const [attempt] = await db.select().from(verrailRunAttempts).where(eq(verrailRunAttempts.id, r.runAttemptId));
        expect(attempt.status).toBe("succeeded");
      }, { timeout: 10_000 });
      const stopped = once(second, "exit");
      second.kill("SIGTERM");
      expect(await stopped).toEqual([0, null]);
      expect(requests).toBe(2);
      expect(received).toEqual([expect.objectContaining({ payload: { repositoryOutput: result } }),
        expect.objectContaining({ payload: { repositoryOutput: result } })]);
      const [dispatch] = await db.select().from(verrailRepositoryDispatches).where(eq(verrailRepositoryDispatches.runAttemptId, r.runAttemptId));
      expect(dispatch.toolCalls).toBe(0);
      expect(dispatch.result).toEqual(result);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  }, 30_000);
});
