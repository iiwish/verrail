import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, heartbeatRunEvents, workspaceOperations,
  verrailAgentDefinitions, verrailAgentVersions, verrailEvaluationRuns, verrailDeployments, verrailDeploymentRevisions,
  verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions, verrailWorkNodes,
  verrailRuns, verrailRunAttempts, verrailExecutionLeases,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { NATIVE_SOURCE_CONTEXT_KEY } from "../services/verrail-native-source.js";
import { createDrizzleVerrailRunExecutorStore } from "../services/verrail-run-executor.js";
import { NATIVE_OUTPUT_CONTEXT_KEY } from "../services/verrail-native-output.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), workspace: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: mocks.execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: mocks.execute, supportsLocalAgentJwt: false }),
  listAdapterModelProfiles: async () => [], runningProcesses: new Map(),
}));
vi.mock("../services/verrail-native-workspace.js", () => ({ resolveNativeRunWorkspace: mocks.workspace }));
const support = await getEmbeddedPostgresTestSupport();
const exec = promisify(execFile);

(support.supported ? describe : describe.skip)("production heartbeat native source dispatch", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let cwd: string;
  let failPersistence = false;
  let terminalWrite: Record<string, any> | undefined;
  let failTerminalPersistence = false;
  let loseTerminalCas = false;
  let beforeFinalize: (() => void) | undefined;
  let storage: Parameters<typeof heartbeatService>[1];
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("heartbeat-native-source-");
    db = createDb(fixture.connectionString);
  }, 30_000);
  beforeEach(async () => {
    failPersistence = false;
    failTerminalPersistence = false;
    loseTerminalCas = false;
    terminalWrite = undefined;
    beforeFinalize = undefined;
    storage = {};
    mocks.execute.mockReset();
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "heartbeat-native-source-")));
    await exec("git", ["init", "-q"], { cwd });
    await writeFile(path.join(cwd, "source.txt"), "trusted dispatch source\n");
    await exec("git", ["add", "."], { cwd });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd });
    const actual = await vi.importActual<typeof import("../services/verrail-native-workspace.js")>("../services/verrail-native-workspace.js");
    mocks.workspace.mockReset().mockImplementation(actual.resolveNativeRunWorkspace);
    const originalUpdate = db.update.bind(db);
    vi.spyOn(db, "update").mockImplementation(((table: unknown) => {
      const update = originalUpdate(table as never);
      if (table !== heartbeatRuns) return update;
      const originalSet = update.set.bind(update);
      update.set = ((values: Record<string, any>) => {
        if (values.contextSnapshot?.[NATIVE_OUTPUT_CONTEXT_KEY]) {
          terminalWrite = values;
          if (failTerminalPersistence) throw new Error("test terminal persistence rejection");
        }
        if (failPersistence && values.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY]) throw new Error("test persistence rejection");
        const query = originalSet(values as never);
        if (loseTerminalCas && values.contextSnapshot?.[NATIVE_OUTPUT_CONTEXT_KEY]) {
          const originalReturning = query.returning.bind(query);
          query.returning = (async (...args: unknown[]) => {
            await originalUpdate(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, values.contextSnapshot[NATIVE_OUTPUT_CONTEXT_KEY].identity.heartbeatRunId));
            return originalReturning(...args as []);
          }) as typeof query.returning;
        }
        return query;
      }) as typeof update.set;
      return update;
    }) as typeof db.update);
    const originalInsert = db.insert.bind(db);
    vi.spyOn(db, "insert").mockImplementation(((table: unknown) => {
      const insert = originalInsert(table as never);
      if (table === workspaceOperations) {
        const values = insert.values.bind(insert);
        insert.values = ((row: any) => { if (row.phase === "workspace_finalize") beforeFinalize?.(); return values(row); }) as typeof insert.values;
      }
      return insert;
    }) as typeof db.insert);
  });
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  }, 30_000);
  afterAll(async () => { await fixture?.cleanup(); }, 30_000);

  async function run(native = true, adapterType = "codex_local") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native source fixture", issuePrefix: `NS${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Source observer", role: "engineer", status: "idle", adapterType, adapterConfig: { cwd, model: "test-model" }, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } });
    const runId = randomUUID();
    const attemptId = randomUUID();
    if (native) {
      const workspaceId = companyId;
      const created = { workspaceId, createdByPrincipalType: "user", createdByPrincipalId: "fixture-user" };
      const targetId = randomUUID();
      const targetRevisionId = randomUUID();
      const graphId = randomUUID();
      const graphRevisionId = randomUUID();
      const nodeId = randomUUID();
      const definitionId = randomUUID();
      const versionId = randomUUID();
      const evaluationId = randomUUID();
      const deploymentId = randomUUID();
      const deploymentRevisionId = randomUUID();
      await db.insert(verrailTargets).values({ ...created, id: targetId, activeTargetRevisionId: targetRevisionId });
      await db.insert(verrailTargetRevisions).values({ ...created, id: targetRevisionId, targetId, revisionNumber: 1, title: "Fixture", goal: "Fixture", outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "fixture-user", constraints: [], acceptanceCriteria: [], riskLevel: "low", contentHash: "a".repeat(64) });
      await db.insert(verrailWorkGraphs).values({ id: graphId, workspaceId, targetId });
      await db.insert(verrailGraphRevisions).values({ ...created, id: graphRevisionId, targetId, targetRevisionId, workGraphId: graphId, revisionNumber: 1, contentHash: "b".repeat(64) });
      await db.insert(verrailWorkNodes).values({ id: nodeId, workspaceId, targetId, graphRevisionId, nodeKey: "fixture", kind: "agent_task", title: "Fixture", stageKey: "execute", completionDefinition: "Fixture" });
      await db.insert(verrailAgentDefinitions).values({ ...created, id: definitionId, compatibilityAgentId: agentId, name: "Fixture" });
      await db.insert(verrailAgentVersions).values({ ...created, id: versionId, agentDefinitionId: definitionId, versionNumber: 1, runtime: "codex_local", model: "test-model", prompt: "Fixture", contentHash: "c".repeat(64) });
      await db.insert(verrailEvaluationRuns).values({ ...created, id: evaluationId, candidateAgentVersionId: versionId, status: "passed", safetyStatus: "passed" });
      await db.insert(verrailDeployments).values({ ...created, id: deploymentId, agentDefinitionId: definitionId, name: "Fixture" });
      await db.insert(verrailDeploymentRevisions).values({ ...created, id: deploymentRevisionId, deploymentId, revisionNumber: 1, agentVersionId: versionId, evaluationRunId: evaluationId, state: "active", runtimeConfig: { cwd }, contentHash: "d".repeat(64) });
      await db.insert(verrailRuns).values({ id: runId, workspaceId, targetId, targetRevisionId, graphRevisionId, workNodeId: nodeId, kind: "agent", actorPrincipalType: "service", actorPrincipalId: "verrail-host-runner", deploymentRevisionId, agentVersionId: versionId, idempotencyKey: runId });
      await db.insert(verrailRunAttempts).values({ id: attemptId, workspaceId, runId, attemptNumber: 1, deploymentRevisionId, agentVersionId: versionId, runtimeProfile: "host_trusted", executorPrincipalType: "service", executorPrincipalId: "verrail-host-runner", fencingToken: 1, idempotencyKey: attemptId });
      await db.insert(verrailExecutionLeases).values({ id: randomUUID(), workspaceId, runId, runAttemptId: attemptId, executorPrincipalId: "verrail-host-runner", runtimeProfile: "host_trusted", fencingToken: 1, status: "active", expiresAt: new Date(Date.now() + 600_000), graceExpiresAt: new Date(Date.now() + 600_000) });
    }
    const heartbeat = heartbeatService(db, { ...storage, runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" } });
    const result = await heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "verrail_native_run",
      requestedByActorType: "system", requestedByActorId: "verrail-host-runner",
      idempotencyKey: `verrail-run-attempt:${attemptId}`,
      contextSnapshot: { ...(native ? { verrailRunAttemptId: attemptId, verrailRunId: runId } : {}), [NATIVE_SOURCE_CONTEXT_KEY]: { status: "captured", forged: true }, [NATIVE_OUTPUT_CONTEXT_KEY]: { forged: true } },
    });
    expect(result).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, result!.id)).then((rows) => rows[0]!);
  }

  it("persists server source before real adapter dispatch and never passes reserved data to model/meta", async () => {
    let persistedAtDispatch: unknown;
    mocks.execute.mockImplementation(async (ctx) => {
      persistedAtDispatch = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ctx.runId)))[0]?.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY];
      expect(ctx.context[NATIVE_SOURCE_CONTEXT_KEY]).toBeUndefined();
      await ctx.onMeta({ [NATIVE_SOURCE_CONTEXT_KEY]: { status: "captured", forged: true } });
      return { exitCode: 0, signal: null, timedOut: false, summary: "fixture", provider: "test", model: "test-model" };
    });
    const result = await run();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(result.status).toBe("succeeded");
    expect(persistedAtDispatch).toMatchObject({ status: "captured", identity: { heartbeatRunId: result.id }, repository: { root: cwd }, manifest: { files: 1 } });
    expect(result.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY]).toEqual(persistedAtDispatch);
    expect(JSON.stringify(persistedAtDispatch)).not.toContain("forged");
    const logged = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, result.id));
    expect(logged.find((event) => event.eventType === "adapter.invoke")?.payload).not.toHaveProperty(NATIVE_SOURCE_CONTEXT_KEY);
    expect(mocks.workspace.mock.calls.length).toBeGreaterThanOrEqual(3);
    const attemptId = result.contextSnapshot!.verrailRunAttemptId as string;
    const store = createDrizzleVerrailRunExecutorStore(db);
    expect((await store.findHeartbeatRun(attemptId))?.nativeSourceObservation).toEqual(persistedAtDispatch);
    await db.update(agentWakeupRequests).set({ requestedByActorType: "user" }).where(eq(agentWakeupRequests.id, result.wakeupRequestId!));
    expect(await store.findHeartbeatRun(attemptId)).toBeNull();
    await db.update(agentWakeupRequests).set({ requestedByActorType: "system", idempotencyKey: "foreign-attempt" }).where(eq(agentWakeupRequests.id, result.wakeupRequestId!));
    expect(await store.findHeartbeatRun(attemptId)).toBeNull();
    await db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, result.id));
    expect(await store.findHeartbeatRun(attemptId)).toBeNull();
  }, 30_000);
  it("prevents dispatch on source receipt persistence failure", async () => {
    failPersistence = true;
    const result = await run();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);
  it("captures changed terminal source at adapter return and atomically stores server output receipt", async () => {
    let uploaded = false;
    let heartbeatId = "";
    storage = { nativeOutputStorage: { putFile: async (input) => {
      const row = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, heartbeatId)))[0]!;
      expect(row.status).toBe("running");
      expect(row.contextSnapshot).not.toHaveProperty(NATIVE_OUTPUT_CONTEXT_KEY);
      uploaded = true;
      const sha256 = createHash("sha256").update(input.body).digest("hex");
      return { sha256, byteSize: input.body.length, objectKey: `${input.companyId}/verrail/run-artifacts/sha256/${sha256}` } as any;
    } } };
    beforeFinalize = () => { expect(uploaded).toBe(true); expect(terminalWrite).toBeUndefined(); };
    mocks.execute.mockImplementation(async (ctx) => {
      heartbeatId = ctx.runId;
      expect(ctx.context.verrailNativeOutputReceipt).toBeUndefined();
      await writeFile(path.join(cwd, "source.txt"), "actual delivered source\n");
      const output = path.join(cwd, ".verrail/run-artifacts", ctx.context.verrailRunAttemptId);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, "report.txt"), "actual artifact bytes");
      await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1, artifacts: [{ path: "report.txt", title: "Report", kind: "report" }] }));
      await ctx.onMeta({ verrailNativeOutputReceipt: { forged: true } });
      return { exitCode: 0, signal: null, timedOut: false, resultJson: { verrailNativeOutputReceipt: { forged: true } } };
    });
    const result = await run();
    expect(result.status).toBe("succeeded");
    const receipt = result.contextSnapshot?.verrailNativeOutputReceipt as any;
    expect(receipt).toMatchObject({ phase: "after_adapter_return", collectionStatus: "collected", sourceStatus: "stable", artifacts: [{ path: "report.txt" }] });
    expect(receipt.sourceAfter.manifest.contentSha256).not.toBe((result.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY] as any).manifest.contentSha256);
    expect(JSON.stringify(receipt)).not.toContain("forged");
    expect(result.resultJson).not.toHaveProperty("verrailNativeOutputReceipt");
    expect(terminalWrite).toMatchObject({ status: "succeeded", contextSnapshot: { [NATIVE_OUTPUT_CONTEXT_KEY]: receipt } });
    expect(result.finishedAt!.toISOString()).toBe(receipt.finalizedAt);
    const store = createDrizzleVerrailRunExecutorStore(db);
    const attemptId = result.contextSnapshot!.verrailRunAttemptId as string;
    expect((await store.findHeartbeatRun(attemptId))?.nativeOutputReceipt).toEqual(receipt);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...result.contextSnapshot, [NATIVE_OUTPUT_CONTEXT_KEY]: { ...receipt, identity: { ...receipt.identity, agentVersionId: randomUUID() } } } }).where(eq(heartbeatRuns.id, result.id));
    expect(await store.findHeartbeatRun(attemptId)).toMatchObject({ nativeOutputReceipt: null, nativeOutputReceiptInvalid: true });
    await db.update(agentWakeupRequests).set({ requestedByActorType: "user" }).where(eq(agentWakeupRequests.id, result.wakeupRequestId!));
    expect(await store.findHeartbeatRun(attemptId)).toBeNull();
  }, 30_000);
  it.each(["nonzero", "timeout", "throw", "cancel", "lease", "finalize", "persist", "cas"])("never publishes successful output on %s failure", async (failure) => {
    mocks.execute.mockImplementation(async (ctx) => {
      if (failure === "throw") throw new Error("fixture adapter failed");
      if (failure === "cancel") await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, ctx.runId));
      if (failure === "lease") await db.update(verrailExecutionLeases).set({ status: "revoked" }).where(eq(verrailExecutionLeases.runAttemptId, ctx.context.verrailRunAttemptId));
      if (failure === "persist") failTerminalPersistence = true;
      if (failure === "cas") loseTerminalCas = true;
      if (failure === "finalize") beforeFinalize = () => { throw new Error("fixture finalize failed"); };
      return { exitCode: failure === "nonzero" ? 1 : 0, signal: null, timedOut: failure === "timeout" };
    });
    const result = await run();
    expect(result.status).not.toBe("succeeded");
    expect(result.contextSnapshot).not.toHaveProperty(NATIVE_OUTPUT_CONTEXT_KEY);
    expect((await createDrizzleVerrailRunExecutorStore(db).findHeartbeatRun(result.contextSnapshot!.verrailRunAttemptId as string))?.nativeOutputReceipt).toBeNull();
  }, 30_000);
  it("does not persist raw storage failure text from the output boundary", async () => {
    storage = { nativeOutputStorage: { putFile: vi.fn().mockRejectedValue(new Error("SYNTHETIC_PRIVATE_OUTPUT_SENTINEL")) } };
    mocks.execute.mockImplementation(async (ctx) => {
      const output = path.join(cwd, ".verrail/run-artifacts", ctx.context.verrailRunAttemptId);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, "report.txt"), "fixture output");
      await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1, artifacts: [{ path: "report.txt", title: "Report", kind: "report" }] }));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    const result = await run();
    expect(result.status).toBe("failed");
    expect(result.contextSnapshot).not.toHaveProperty(NATIVE_OUTPUT_CONTEXT_KEY);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_OUTPUT_SENTINEL");
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, result.id));
    expect(JSON.stringify(events)).not.toContain("SYNTHETIC_PRIVATE_OUTPUT_SENTINEL");
  }, 30_000);
  it("keeps unavailable Git observable without failing compatible execution", async () => {
    await rm(path.join(cwd, ".git"), { recursive: true });
    mocks.execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, summary: "fixture" });
    const result = await run();
    expect(result.status).toBe("succeeded");
    expect(result.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY]).toMatchObject({ status: "unavailable", reasonCode: "not_git" });
  }, 30_000);
  it("keeps legacy execution source-free and strips incoming provenance", async () => {
    mocks.execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, summary: "fixture" });
    const result = await run(false);
    expect(result.status).toBe("succeeded");
    expect(result.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);
  it("keeps unsupported adapters explicit rather than hashing the server checkout", async () => {
    mocks.execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, summary: "fixture" });
    const result = await run(true, "process");
    expect(result.status).toBe("succeeded");
    expect(result.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY]).toMatchObject({ status: "unavailable", reasonCode: "unsupported_execution" });
  }, 30_000);
  it("rechecks the real lease after capture and stops stale dispatch", async () => {
    const actual = await vi.importActual<typeof import("../services/verrail-native-workspace.js")>("../services/verrail-native-workspace.js");
    let calls = 0;
    mocks.workspace.mockImplementation(async (connection, input) => {
      if (++calls === 3) await db.update(verrailExecutionLeases).set({ status: "revoked" });
      return actual.resolveNativeRunWorkspace(connection, input);
    });
    const result = await run();
    expect(result.status).toBe("failed");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(result.contextSnapshot?.[NATIVE_SOURCE_CONTEXT_KEY]).toBeUndefined();
  }, 30_000);
});
