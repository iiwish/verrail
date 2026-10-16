import { beforeEach, expect, it, vi } from "vitest";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { createOpenCodeRepositoryRuntime } from "./opencode-repository-runtime.js";

const f = vi.hoisted(() => ({ runtime: vi.fn(), run: vi.fn(), server: {
  listening: false, headersTimeout: 0, maxConnections: 0,
  once: vi.fn(), listen: vi.fn(), address: vi.fn(), closeAllConnections: vi.fn(), close: vi.fn(),
} }));
vi.mock("node:http", () => ({ createServer: () => f.server }));
vi.mock("./opencode-runtime.js", () => ({ createOpenCodeToolRuntime: f.runtime }));
const id = "11111111-1111-4111-8111-111111111111";
const request: RepositoryExecutionRequest = { schemaVersion: 1, kind: "target_repository_execution", workspaceId: id,
  targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id, runId: id, runAttemptId: id,
  leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id,
  source: { artifactId: id, contentHash: "a".repeat(64), baseCommit: "b".repeat(40), format: "git_bundle" },
  runtime: "opencode", model: "fixture/test", instructions: "Test", timeoutSeconds: 60,
  output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 } };
const observed = { runtime: "opencode", runtimeVersion: "1.17.13", model: request.model,
  startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
  cleanup: { runtime: true, home: true }, usageStatus: "unavailable", usage: null, costStatus: "unavailable" };
beforeEach(() => {
  vi.resetAllMocks();
  f.server.listening = false;
  f.server.listen.mockImplementation((_port, _host, ready) => { f.server.listening = true; ready(); });
  f.server.address.mockReturnValue({ port: 12345 });
  f.server.close.mockImplementation(done => { f.server.listening = false; done(); });
  f.runtime.mockReturnValue(f.run);
  f.run.mockResolvedValue(observed);
});
function runtime(trustedObserver?: Parameters<typeof createOpenCodeRepositoryRuntime>[0]["trustedObserver"]) {
  return createOpenCodeRepositoryRuntime({ version: "1.17.13", providers: {},
    trustedObserver,
    authorize: vi.fn(async () => {}), consumeToolCall: vi.fn(async () => {}), emit: vi.fn(async () => {}) });
}

it("requests actual runtime facts and publishes only the receipt projection after MCP close", async () => {
  let release!: () => void;
  let closing!: () => void;
  const ready = new Promise<void>(resolve => { closing = resolve; });
  f.server.close.mockImplementation(done => { closing(); release = done; });
  let settled = false;
  const result = runtime()(request, "/not-read", new AbortController().signal).finally(() => { settled = true; });
  await ready;
  expect(settled).toBe(false);
  expect(f.runtime.mock.calls[0]![0].requireExecutionFacts).toBe(true);
  release();
  expect(await result).toEqual({ exitCode: 0, executionFacts: { runtime: observed.runtime,
    runtimeVersion: observed.runtimeVersion, model: observed.model, startedAt: observed.startedAt,
    finishedAt: expect.any(String), cleanup: { runtime: true, commands: true, home: true } } });
  expect(f.server.closeAllConnections).toHaveBeenCalledOnce();
});

it("forwards only trusted launch configuration with the real complete request identity", async () => {
  const observer = { command: "/trusted/node", entrypoint: "/trusted/observer.mjs", configurationFile: "/trusted/observer.json",
    sessionId: id, manifestSha256: "e".repeat(64) };
  f.run.mockResolvedValue({ ...observed, candidateRuntime: { kind: "verrail.opencode-session-bound" } });
  await runtime(observer)(request, "/not-read", new AbortController().signal);
  const passed = f.runtime.mock.calls[0]![0].trustedObserver;
  expect(passed).toMatchObject(observer);
  expect(passed.identity({})).toEqual({ workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id,
    workNodeId: id, runId: id, runAttemptId: id, leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id });
  f.run.mockResolvedValue(observed);
  await expect(runtime(observer)(request, "/not-read", new AbortController().signal)).rejects.toThrow("REPOSITORY_RUNTIME_FACTS_REQUIRED");
});

it.each([undefined, { ...observed, model: "foreign/model" }, { ...observed, cleanup: { runtime: true, home: false } }])(
  "rejects missing, mismatched or unclean runtime facts", async facts => {
    f.run.mockResolvedValue(facts);
    await expect(runtime()(request, "/not-read", new AbortController().signal)).rejects.toThrow();
    expect(f.server.closeAllConnections).toHaveBeenCalledOnce();
    expect(f.server.close).toHaveBeenCalledOnce();
  },
);

it("does not turn cancellation during final MCP cleanup into success", async () => {
  const cancellation = new AbortController();
  f.server.close.mockImplementation(done => { cancellation.abort(new Error("canceled during close")); done(); });
  await expect(runtime()(request, "/not-read", cancellation.signal)).rejects.toThrow("canceled during close");
});
