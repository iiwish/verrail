import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenCodeGatewayRuntime, createOpenCodeToolRuntime } from "./opencode-runtime.js";
import { openCodeRuntimeDigest } from "../services/opencode-runtime-observation.js";

const f = vi.hoisted(() => ({ spawn: vi.fn(), mkdtemp: vi.fn(), realpath: vi.fn(), rm: vi.fn(), client: vi.fn(),
  session: vi.fn(), prompt: vi.fn(), subscribe: vi.fn(), facts: vi.fn(), witness: vi.fn(),
  reservation: { once: vi.fn(), listen: vi.fn(), address: vi.fn(), close: vi.fn() } }));
vi.mock("node:child_process", () => ({ spawn: f.spawn }));
vi.mock("node:fs/promises", () => ({ mkdtemp: f.mkdtemp, realpath: f.realpath, rm: f.rm }));
vi.mock("node:net", () => ({ createServer: () => f.reservation }));
vi.mock("@paperclipai/adapter-opencode-local/http-client", () => ({ createOpenCodeHttpClient: f.client }));

const observed = { runtimeVersion: "1.17.13", healthVerifiedAt: "2026-01-01T00:00:00.000Z",
  model: "fixture/test", providerId: "fixture", modelId: "test", sessionId: "ses_test", messageId: "msg_final",
  sessionCreatedAt: "2026-01-01T00:00:00.000Z", messages: [], usageStatus: "unavailable",
  usageScope: "session-step-finish", usage: null, reportedCostUsd: null, costStatus: "unavailable", costBasis: "opencode-estimate",
  fullHistory: { sha256: "a".repeat(64), bytes: 2, messageCount: 0, partCount: 0 }, fullHistoryBody: new Uint8Array([91, 93]) };
const witness = { checkedAt: "2026-01-01T00:00:00.000Z", permissions: { default: "deny", allowedTools: ["repository_read"],
  sessionRulesSha256: "b".repeat(64), configRulesSha256: "c".repeat(64) },
  configuration: { model: "fixture/test", smallModel: "fixture/test", share: "disabled", enabledProviders: ["fixture"] },
  environment: { homeSha256: "d".repeat(64), directory: ".", state: "state/opencode", config: "config/opencode", worktree: "global" } };
const input = { model: "fixture/test", systemPrompt: "Rules", prompt: "Test" };
const options = { version: "1.17.13", providers: { fixture: {} }, tools: ["repository_read"], mcp: () => ({}) };
beforeEach(() => {
  vi.resetAllMocks();
  const child = Object.assign(new EventEmitter(), { pid: 43210, exitCode: null as number | null, signalCode: null, send: vi.fn() });
  f.spawn.mockReturnValue(child);
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (signal === "SIGTERM") queueMicrotask(() => { child.exitCode = 0; child.emit("close", 0); });
    return true;
  });
  f.mkdtemp.mockResolvedValue("/tmp/verrail-opencode-test-only"); f.rm.mockResolvedValue(undefined);
  f.realpath.mockResolvedValue("/tmp");
  f.reservation.listen.mockImplementation((_port, _host, ready) => ready());
  f.reservation.address.mockReturnValue({ port: 12345 }); f.reservation.close.mockImplementation(done => done());
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  f.session.mockResolvedValue("ses_test"); f.prompt.mockResolvedValue({ messageId: "msg_final", text: "Done" });
  f.subscribe.mockImplementation(async () => {
    let close!: () => void; const done = new Promise<void>(resolve => { close = resolve; }); return { done, close };
  });
  f.facts.mockResolvedValue(observed);
  f.witness.mockResolvedValue(witness);
  f.client.mockReturnValue({ createSession: f.session, promptMessage: f.prompt, subscribeText: f.subscribe,
    collectExecutionFacts: f.facts, collectRuntimeWitness: f.witness });
});

const id = "11111111-1111-4111-8111-111111111111";
const identity = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id,
  runId: id, runAttemptId: id, leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id };
const trustedObserver = { command: "/trusted/observer", entrypoint: "/trusted/observer.mjs", configurationFile: "/private/observer.json",
  sessionId: id, manifestSha256: "e".repeat(64), identity: () => identity };
function observedChild(child: ReturnType<typeof f.spawn>, wrongIdentity = false) {
  const started = { kind: "verrail.opencode-runtime-started", nativePid: 43211, observerPid: 43210,
    sessionId: id, manifestSha256: trustedObserver.manifestSha256 };
  const bound = { ...started, kind: "verrail.opencode-session-bound", executionIdentitySha256: wrongIdentity ? "f".repeat(64) : openCodeRuntimeDigest(identity),
    httpSession: { sessionId: "ses_test", runtimeVersion: "1.17.13", createdAt: observed.sessionCreatedAt,
      homeSha256: createHash("sha256").update("/tmp/verrail-opencode-test-only").digest("hex") } };
  queueMicrotask(() => child.emit("message", started));
  child.send.mockImplementation((_message: unknown, callback: (error?: Error) => void) => {
    queueMicrotask(() => child.emit("message", bound)); callback();
  });
  return bound;
}

it("binds the launch-owning observer to the actual session and cleans its separate native group", async () => {
  const child = f.spawn.getMockImplementation()!();
  let bound: ReturnType<typeof observedChild> | undefined;
  f.spawn.mockImplementation(() => { queueMicrotask(() => { bound = observedChild(child); }); return child; });
  const facts = await createOpenCodeToolRuntime({ ...options, trustedObserver, requireExecutionFacts: true })(input,
    { signal: new AbortController().signal, emit: vi.fn(async () => {}) });
  expect(facts?.candidateRuntime).toEqual(bound);
  expect(process.kill).toHaveBeenCalledWith(-43211, "SIGKILL");
  expect(process.kill).toHaveBeenCalledWith(-43211, 0);
  expect(f.spawn.mock.calls[0]?.[0]).toBe("/trusted/observer");
});

it("rejects an observer session bound to another Run identity", async () => {
  const child = f.spawn.getMockImplementation()!();
  f.spawn.mockImplementation(() => { queueMicrotask(() => observedChild(child, true)); return child; });
  await expect(createOpenCodeToolRuntime({ ...options, trustedObserver, requireExecutionFacts: true })(input,
    { signal: new AbortController().signal, emit: vi.fn(async () => {}) })).rejects.toThrow("mismatch");
  expect(f.prompt).not.toHaveBeenCalled(); expect(process.kill).toHaveBeenCalledWith(-43211, 0);
});

it("still cleans the owned native group when observer-group verification fails", async () => {
  const child = f.spawn.getMockImplementation()!();
  f.spawn.mockImplementation(() => { queueMicrotask(() => observedChild(child)); return child; });
  vi.mocked(process.kill).mockImplementation((pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("group"), { code: pid === -43210 ? "EPERM" : "ESRCH" });
    if (signal === "SIGTERM") queueMicrotask(() => { child.exitCode = 0; child.emit("close", 0); }); return true;
  });
  await expect(createOpenCodeToolRuntime({ ...options, trustedObserver, requireExecutionFacts: true })(input,
    { signal: new AbortController().signal, emit: vi.fn(async () => {}) })).rejects.toThrow("cleanup");
  expect(process.kill).toHaveBeenCalledWith(-43211, "SIGKILL"); expect(process.kill).toHaveBeenCalledWith(-43211, 0);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("publishes observed execution facts only after process and private-home cleanup", async () => {
  let release!: () => void; let cleaning!: () => void;
  const cleanupStarted = new Promise<void>(resolve => { cleaning = resolve; });
  f.rm.mockImplementation(() => { cleaning(); return new Promise<void>(resolve => { release = resolve; }); });
  let settled = false; const emit = vi.fn(async () => {});
  const started = Date.now();
  const result = createOpenCodeToolRuntime({ ...options, requireExecutionFacts: true })(input,
    { signal: new AbortController().signal, emit }).finally(() => { settled = true; });
  await cleanupStarted; expect(settled).toBe(false);
  expect(f.facts).toHaveBeenCalledWith("ses_test", { model: "fixture/test", finalMessageId: "msg_final" }, expect.any(AbortSignal));
  release(); const facts = await result;
  expect(facts).toMatchObject({ ...observed, runtime: "opencode", cleanup: { runtime: true, home: true } });
  expect(facts).toMatchObject({ runtimeWitness: { before: witness, after: witness }, fullHistory: { projectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(f.witness).toHaveBeenCalledTimes(2);
  expect(f.witness.mock.invocationCallOrder[0]).toBeLessThan(f.prompt.mock.invocationCallOrder[0]!);
  expect(f.witness.mock.invocationCallOrder[1]).toBeGreaterThan(f.prompt.mock.invocationCallOrder[0]!);
  expect(Date.parse(facts!.startedAt)).toBeGreaterThanOrEqual(started);
  expect(Date.parse(facts!.finishedAt)).toBeGreaterThanOrEqual(Date.parse(facts!.startedAt));
  expect(emit).toHaveBeenCalledWith("Done");
});

it("rejects permission drift between actual pre- and post-execution readbacks", async () => {
  f.witness.mockResolvedValueOnce(witness).mockResolvedValueOnce({ ...witness, permissions: { ...witness.permissions, allowedTools: ["bash"] } });
  await expect(createOpenCodeToolRuntime({ ...options, requireExecutionFacts: true })(input,
    { signal: new AbortController().signal, emit: vi.fn(async () => {}) })).rejects.toThrow("changed");
  expect(f.rm).toHaveBeenCalledOnce();
});

it("does not prompt when the initial actual runtime witness fails", async () => {
  f.witness.mockRejectedValue(new Error("permission mismatch"));
  await expect(createOpenCodeToolRuntime({ ...options, requireExecutionFacts: true })(input,
    { signal: new AbortController().signal, emit: vi.fn(async () => {}) })).rejects.toThrow("permission mismatch");
  expect(f.prompt).not.toHaveBeenCalled(); expect(f.rm).toHaveBeenCalledOnce();
});

it("keeps conversation output compatible without requiring execution accounting", async () => {
  const runtime = createOpenCodeGatewayRuntime({ ...options, controlPlaneUrl: "http://control-plane" });
  const result = await runtime({ ...input, directorToken: "test-only" } as Parameters<typeof runtime>[0],
    { signal: new AbortController().signal, emit: vi.fn(async () => {}) });
  expect(result).toBeUndefined(); expect(f.facts).not.toHaveBeenCalled();
});

it.each(["facts", "home", "process-group", "cancel"])("does not return facts after %s failure", async phase => {
  const controller = new AbortController();
  if (phase === "facts") f.facts.mockRejectedValue(new Error("invalid facts"));
  if (phase === "home") f.rm.mockRejectedValue(new Error("home cleanup failed"));
  if (phase === "process-group") vi.mocked(process.kill).mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
    if (signal === "SIGTERM") queueMicrotask(() => f.spawn.mock.results[0]!.value.emit("close", 0)); return true;
  });
  if (phase === "cancel") f.rm.mockImplementation(async () => { controller.abort(new Error("canceled during cleanup")); });
  await expect(createOpenCodeToolRuntime({ ...options, requireExecutionFacts: true })(input,
    { signal: controller.signal, emit: vi.fn(async () => {}) })).rejects.toThrow();
});
