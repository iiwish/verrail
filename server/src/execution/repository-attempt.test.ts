import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { executeRepositoryAttempt } from "./repository-attempt.js";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";

const prepare = vi.hoisted(() => vi.fn());
vi.mock("./repository-checkout.js", () => ({ prepareRepositoryCheckout: prepare }));
const id = "11111111-1111-4111-8111-111111111111";
const request: RepositoryExecutionRequest = {
  schemaVersion: 1, kind: "target_repository_execution", workspaceId: id, targetId: id,
  targetRevisionId: id, graphRevisionId: id, workNodeId: id, runId: id,
  runAttemptId: id, leaseId: id, fencingToken: 2, agentVersionId: id,
  deploymentRevisionId: id, source: { artifactId: id, contentHash: "a".repeat(64),
    baseCommit: "b".repeat(40), format: "git_bundle" },
  runtime: "opencode", model: "fixture/test", instructions: "Write a report",
  timeoutSeconds: 120, output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 },
};
let root: string;
let dispose: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "verrail-attempt-test-"));
  dispose = vi.fn(async () => {});
  prepare.mockResolvedValue({ cwd: root, dispose, baseCommit: request.source.baseCommit });
});
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); await rm(root, { recursive: true, force: true }); });
function dependencies() {
  const storage = createStorageService(createLocalDiskStorageProvider(join(root, "storage")));
  return {
    readSource: vi.fn(async () => Buffer.from("fixture")),
    revalidate: vi.fn(async () => {}),
    run: vi.fn(async () => {
      const output = join(root, ".verrail/run-artifacts", id);
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "report.txt"), "verified bytes");
      await writeFile(join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1,
        artifacts: [{ title: "Report", kind: "report", path: "report.txt" }] }));
      return { exitCode: 0 };
    }),
    storage: { putFile: vi.fn(storage.putFile.bind(storage)) },
  };
}
it("collects immutable bytes after runtime completion and returns fenced identity", async () => {
  const deps = dependencies();
  const result = await executeRepositoryAttempt(request, deps, new AbortController().signal);
  expect(result).toMatchObject({ runId: id, runAttemptId: id, fencingToken: 2,
    artifacts: [{ bytes: 14, kind: "report" }] });
  expect(deps.revalidate).toHaveBeenCalledTimes(7);
  expect(dispose).toHaveBeenCalledOnce();
});
it("rejects a revoked lease after execution without uploading", async () => {
  const deps = dependencies();
  deps.revalidate.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error("STALE_LEASE"));
  await expect(executeRepositoryAttempt(request, deps, new AbortController().signal)).rejects.toThrow("STALE_LEASE");
  expect(deps.storage.putFile).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
});
it("does not acknowledge cancellation until runtime cleanup completes", async () => {
  const deps = dependencies();
  const abort = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  deps.run.mockImplementation(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { exitCode: 0 }; });
  const result = executeRepositoryAttempt(request, deps, abort.signal);
  const rejected = expect(result).rejects.toThrow();
  await ready;
  abort.abort();
  expect(dispose).not.toHaveBeenCalled();
  release();
  await rejected;
  expect(dispose).toHaveBeenCalledOnce();
  expect(deps.storage.putFile).not.toHaveBeenCalled();
});
it("requires artifacts and refuses failed execution", async () => {
  const deps = dependencies();
  deps.run.mockResolvedValue({ exitCode: 0 });
  await expect(executeRepositoryAttempt(request, deps, new AbortController().signal)).rejects.toThrow("REPOSITORY_ARTIFACTS_REQUIRED");
  deps.run.mockResolvedValue({ exitCode: 1 });
  await expect(executeRepositoryAttempt(request, deps, new AbortController().signal)).rejects.toThrow("REPOSITORY_EXECUTION_FAILED");
  expect(deps.storage.putFile).not.toHaveBeenCalled();
});
it("preserves cleanup uncertainty when checkout disposal also fails", async () => {
  const deps = dependencies();
  deps.run.mockRejectedValue(new GatewayRuntimeCleanupError("Process group cleanup is unconfirmed"));
  dispose.mockRejectedValue(new Error("FILESYSTEM_BUSY"));
  await expect(executeRepositoryAttempt(request, deps, new AbortController().signal))
    .rejects.toBeInstanceOf(GatewayRuntimeCleanupError);
  expect(deps.storage.putFile).not.toHaveBeenCalled();
});
it("interrupts a running sandbox when its periodic lease check fails", async () => {
  vi.useFakeTimers();
  const deps = dependencies();
  deps.revalidate.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error("revoked"));
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let stopped = false;
  deps.run.mockImplementation(async (...args: unknown[]) => {
    const signal = args[2] as AbortSignal;
    started();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    stopped = true;
    return { exitCode: 0 };
  });
  const execution = executeRepositoryAttempt(request, deps, new AbortController().signal);
  const rejected = expect(execution).rejects.toThrow("REPOSITORY_LEASE_LOST");
  await ready;
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(stopped).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
  expect(deps.storage.putFile).not.toHaveBeenCalled();
});
