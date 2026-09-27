import { beforeEach, expect, it, vi } from "vitest";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { createRepositoryExecutionController } from "./repository-controller.js";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";

const f = vi.hoisted(() => ({ claim: vi.fn(), authorize: vi.fn(), renew: vi.fn(), consumeToolCall: vi.fn(),
  finishSucceeded: vi.fn(), finishFailure: vi.fn(), finishCancellation: vi.fn(), attempt: vi.fn(), source: vi.fn(), runtime: vi.fn(), run: vi.fn() }));
vi.mock("./repository-dispatch.js", () => ({ createRepositoryDispatchStore: () => f }));
vi.mock("./repository-source.js", () => ({ createRepositorySourceReader: () => f.source }));
vi.mock("./repository-attempt.js", () => ({ executeRepositoryAttempt: f.attempt }));
vi.mock("./opencode-repository-runtime.js", () => ({ createOpenCodeRepositoryRuntime: f.runtime }));
const id = "11111111-1111-4111-8111-111111111111";
const request: RepositoryExecutionRequest = { schemaVersion: 1, kind: "target_repository_execution", workspaceId: id,
  targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id, runId: id, runAttemptId: id,
  leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id,
  source: { artifactId: id, contentHash: "a".repeat(64), baseCommit: "b".repeat(40), format: "git_bundle" },
  runtime: "opencode", model: "fixture/test", instructions: "Test", timeoutSeconds: 60,
  output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 } };
const result = { result: "fixture-only" };
beforeEach(() => {
  vi.resetAllMocks();
  f.claim.mockResolvedValue(true);
  f.finishCancellation.mockResolvedValue(false);
  for (const fn of [f.authorize, f.renew, f.consumeToolCall, f.finishSucceeded, f.finishFailure]) fn.mockResolvedValue(undefined);
  f.runtime.mockReturnValue(f.run);
  f.attempt.mockResolvedValue(result);
});
it("records cancellation only after the attempt has settled and ownership is verified", async () => {
  f.attempt.mockRejectedValue(new Error("REPOSITORY_LEASE_LOST"));
  f.finishCancellation.mockResolvedValue(true);
  const signal = AbortSignal.abort();
  // The run begins with a live caller signal; cleanup reporting owns its deadline.
  const { execute } = controller();
  expect(await execute(request, new AbortController().signal)).toEqual({ status: "canceled" });
  expect(f.finishCancellation.mock.invocationCallOrder[0]).toBeGreaterThan(f.attempt.mock.invocationCallOrder[0]);
  expect(f.finishCancellation.mock.calls[0][1].aborted).toBe(false);
  expect(f.finishFailure).not.toHaveBeenCalled();
  expect(f.finishSucceeded).not.toHaveBeenCalled();
  await expect(execute(request, signal)).rejects.toThrow();
});
it("does not mint a cleanup receipt when process cleanup is uncertain", async () => {
  f.attempt.mockRejectedValue(new GatewayRuntimeCleanupError("Unconfirmed child cleanup"));
  await expect(controller().execute(request, new AbortController().signal)).rejects.toThrow("Unconfirmed child cleanup");
  expect(f.finishCancellation).not.toHaveBeenCalled();
  expect(f.finishFailure).not.toHaveBeenCalled();
});
it("does not acknowledge a cancellation after losing dispatch ownership", async () => {
  f.attempt.mockRejectedValue(new Error("REPOSITORY_LEASE_LOST"));
  f.finishCancellation.mockRejectedValue(new Error("REPOSITORY_DISPATCH_NOT_ACTIVE"));
  await expect(controller().execute(request, new AbortController().signal)).rejects.toThrow("REPOSITORY_DISPATCH_NOT_ACTIVE");
  expect(f.finishFailure).not.toHaveBeenCalled();
});
function controller() {
  const renewRun = vi.fn(async () => {}), emit = vi.fn(async () => {});
  const onAuthority = vi.fn();
  const execute = createRepositoryExecutionController({ db: {} as never, storage: {} as never, controllerId: id,
    version: "1.17.13", launcher: "/fixture/sandbox", providers: {}, renewRun, emit, onAuthority });
  return { execute, renewRun, emit, onAuthority };
}
it("connects the source, authorization, runtime and durable completion after claiming", async () => {
  const { execute, emit } = controller();
  expect(await execute(request, new AbortController().signal)).toEqual({ status: "succeeded", result });
  expect(f.claim.mock.invocationCallOrder[0]).toBeLessThan(f.attempt.mock.invocationCallOrder[0]);
  expect(f.attempt.mock.calls[0][1]).toMatchObject({ readSource: f.source, revalidate: f.authorize, run: f.run });
  expect(f.finishSucceeded).toHaveBeenCalledWith(request, result, expect.any(AbortSignal));
  const callbacks = f.runtime.mock.calls[0][0];
  expect(callbacks.authorize).toBeTypeOf("function");
  expect(callbacks.consumeToolCall).toBeTypeOf("function");
  expect(emit).not.toHaveBeenCalled();
});
it("does not replay a previously dispatched attempt", async () => {
  f.claim.mockResolvedValue(false);
  const { execute, onAuthority } = controller();
  expect(await execute(request, new AbortController().signal)).toEqual({ status: "already_dispatched" });
  expect(onAuthority).not.toHaveBeenCalled();
  expect(f.runtime).not.toHaveBeenCalled();
  expect(f.attempt).not.toHaveBeenCalled();
});
it("persists failure only after attempt cleanup and exposes persistence failure", async () => {
  f.attempt.mockRejectedValue(new Error("CLEANUP_SETTLED_FAILURE"));
  f.finishFailure.mockRejectedValue(new Error("DATABASE_UNAVAILABLE"));
  await expect(controller().execute(request, new AbortController().signal)).rejects.toThrow("REPOSITORY_FAILURE_PERSISTENCE_FAILED");
  expect(f.finishFailure).toHaveBeenCalledWith(request, "failed", expect.any(AbortSignal));
  expect(f.finishSucceeded).not.toHaveBeenCalled();
});
it("stops execution when Go lease renewal fails", async () => {
  const { execute, renewRun, onAuthority } = controller();
  renewRun.mockRejectedValue(new Error("LEASE_LOST"));
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.attempt.mockImplementation(async (_request, _deps, signal: AbortSignal) => {
    started();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  });
  const execution = execute(request, new AbortController().signal);
  const rejection = expect(execution).rejects.toThrow("REPOSITORY_RENEWAL_FAILED");
  await ready;
  await rejection;
  expect(f.renew).not.toHaveBeenCalled();
  expect(onAuthority).toHaveBeenCalledTimes(1);
  expect(f.finishSucceeded).not.toHaveBeenCalled();
}, 30_000);
