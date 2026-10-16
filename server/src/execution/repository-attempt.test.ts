import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { executeRepositoryAttempt } from "./repository-attempt.js";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import * as sourceTree from "../services/verrail-native-source.js";
import { validateRepositoryOutputReceipt } from "./repository-output-receipt.js";
import { validateRepositoryResult } from "./repository-result.js";
import { repositoryObservationFixture } from "../__tests__/helpers/repository-execution-observation.js";

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
  expect(deps.revalidate).toHaveBeenCalledTimes(8);
  expect(dispose).toHaveBeenCalledOnce();
  expect(result).not.toHaveProperty("outputReceipt");
  expect(result.artifacts[0]).not.toHaveProperty("type");
  expect(validateRepositoryResult(result, request)).toEqual(result);
});

const exec = promisify(execFile);
async function snapshotDependencies() {
  const git = (args: string[]) => exec("git", args, { cwd: root });
  await git(["init", "-q"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(root, "source.txt"), "original");
  await git(["add", "source.txt"]);
  await git(["commit", "-qm", "fixture"]);
  const deps = dependencies();
  const startedAt = new Date().toISOString();
  const run = vi.fn(async () => {
    await writeFile(join(root, "source.txt"), "actual runtime output");
    const output = join(root, ".verrail/run-artifacts", id);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "manifest.json"), JSON.stringify({ schemaVersion: 2,
      artifacts: [{ type: "source_snapshot", title: "Source <&\u2028中文", format: "git_bundle", scopeVersion: 2 }] }));
    return { exitCode: 0, executionFacts: { runtime: "opencode" as const, runtimeVersion: "1.17.13", model: request.model,
      startedAt, finishedAt: new Date().toISOString(), cleanup: { runtime: true as const, commands: true as const, home: true as const } } };
  });
  const readSourceBinding = vi.fn(async () => ({ repositorySourceRevisionId: id, provenanceContentHash: "c".repeat(64) }));
  const input = { ...request, output: { maxFiles: 2, maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 } };
  return { ...deps, run, readSourceBinding, input };
}

it("freezes an explicitly requested source bundle and finalizes only after checkout deletion", async () => {
  const deps = await snapshotDependencies();
  let release!: () => void;
  let disposing!: () => void;
  const entered = new Promise<void>(resolve => { disposing = resolve; });
  dispose.mockImplementation(async () => { disposing(); await new Promise<void>(resolve => { release = resolve; }); });
  let settled = false;
  const resultPromise = executeRepositoryAttempt(deps.input, deps, new AbortController().signal).finally(() => { settled = true; });
  await entered;
  expect(settled).toBe(false);
  release();
  const result = await resultPromise;
  expect(result.outputReceipt).toMatchObject({ kind: "verrail.repository-output-receipt", sourceStatus: "stable",
    sourceBinding: { repositorySourceRevisionId: id }, executionFacts: { cleanup: { runtime: true, commands: true, home: true, checkout: true } } });
  expect(validateRepositoryOutputReceipt(result.outputReceipt, deps.input)).toEqual(result.outputReceipt);
  expect(validateRepositoryResult(result, deps.input)).toEqual(result);
  if (process.env.VERRAIL_REPOSITORY_RECEIPT_INTEROP === "1") {
    process.stdout.write(`REPOSITORY_RECEIPT_INTEROP ${JSON.stringify({ request: deps.input, result })}\n`);
  }
  expect(result.outputReceipt!.identity).not.toHaveProperty("agentId");
  expect(result.outputReceipt!.identity).not.toHaveProperty("heartbeatRunId");
  expect(result.outputReceipt!.sourceBefore.repository).not.toHaveProperty("root");
  const bundle = deps.storage.putFile.mock.calls[0]![0].body as Buffer;
  const bundlePath = join(root, "snapshot.bundle");
  await writeFile(bundlePath, bundle);
  const restored = join(root, "restored");
  await exec("git", ["clone", "-q", bundlePath, restored]);
  expect(await readFile(join(restored, "source.txt"), "utf8")).toBe("actual runtime output");
  await expect(readFile(join(restored, ".verrail/run-artifacts", id, "manifest.json"))).rejects.toThrow();
  expect(bundle.length).toBe(result.artifacts[0]!.bytes);

  const sign = (value: Record<string, unknown>) => {
    const { sha256: _, ...body } = value;
    return { ...body, sha256: createHash("sha256").update(canonicalJson(body)).digest("hex") };
  };
  for (const mutate of [
    (value: any) => { value.identity.fencingToken++; },
    (value: any) => { value.executionFacts.cleanup.checkout = false; },
    (value: any) => { value.executionFacts.finishedAt = "2099-01-01T00:00:00.000Z"; },
    (value: any) => { value.sourceAfter.manifest.contentSha256 = "f".repeat(64); },
    (value: any) => { value.artifacts[0].sourceSnapshot.sourceContentSha256 = "f".repeat(64); },
    (value: any) => { value.requestSha256 = "f".repeat(64); },
    (value: any) => { value.inputSource.contentHash = "f".repeat(64); },
    (value: any) => { value.artifacts[0].bytes = deps.input.output.maxFileBytes + 1; },
    (value: any) => { value.identity.heartbeatRunId = id; },
  ]) {
    const tampered = structuredClone(result.outputReceipt!);
    mutate(tampered);
    expect(validateRepositoryOutputReceipt(sign(tampered), deps.input)).toBeNull();
  }
  expect(() => validateRepositoryResult({ ...result, outputReceipt: undefined }, deps.input)).toThrow();
  expect(() => validateRepositoryResult({ ...result, artifacts: result.artifacts.map(item => ({ ...item, title: "substituted" })) }, deps.input)).toThrow();
});

it.each(["binding", "missing binding", "facts", "dispose", "lease after cleanup", "budget", "source mutation"])("does not mint a trusted receipt after %s failure", async failure => {
  const deps = await snapshotDependencies();
  if (failure === "binding") deps.readSourceBinding.mockRejectedValue(new Error("BINDING_INVALID"));
  if (failure === "facts") deps.run.mockImplementationOnce(async () => {
    const result = await deps.run();
    return { ...result, executionFacts: undefined as never };
  });
  if (failure === "dispose") dispose.mockRejectedValue(new Error("cleanup uncertain"));
  if (failure === "lease after cleanup") dispose.mockImplementation(async () => { deps.revalidate.mockRejectedValue(new Error("LEASE_LOST_AFTER_CLEANUP")); });
  if (failure === "budget") deps.input.output = { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1 };
  const original = sourceTree.captureSourceTree;
  const spy = failure === "source mutation" ? vi.spyOn(sourceTree, "captureSourceTree").mockImplementationOnce(original)
    .mockImplementationOnce(async options => { await writeFile(join(root, "source.txt"), "raced after collection"); return original(options); }) : null;
  try { await expect(executeRepositoryAttempt(deps.input,
    failure === "missing binding" ? { ...deps, readSourceBinding: undefined } : deps, new AbortController().signal)).rejects.toThrow(); }
  finally { spy?.mockRestore(); }
  expect(dispose).toHaveBeenCalledOnce();
  if (failure !== "dispose" && failure !== "lease after cleanup") expect(deps.storage.putFile).not.toHaveBeenCalled();
});

it.each([false, true])("persists trusted execution bytes before checkout disposal, with disposal failure=%s", async cleanupFails => {
  const deps = await snapshotDependencies();
  const observed = repositoryObservationFixture(deps.input);
  deps.run.mockImplementationOnce(async () => ({ ...await deps.run(),
    executionFacts: observed.expected, executionObservation: observed.execution }));
  dispose.mockImplementation(async () => {
    expect(deps.storage.putFile).toHaveBeenCalledTimes(3);
    if (cleanupFails) throw new Error("checkout still present");
  });
  const pending = executeRepositoryAttempt(deps.input, deps, new AbortController().signal);
  if (cleanupFails) {
    await expect(pending).rejects.toThrow();
  } else {
    const result = await pending;
    expect(validateRepositoryResult(result, deps.input)).toEqual(result);
    expect(result.artifacts).toHaveLength(1);
    expect(result.outputReceipt?.executionObservation?.contentRef)
      .toMatch(/\/repository-execution-observations\/sha256\/[a-f0-9]{64}$/);
    const writes = deps.storage.putFile.mock.calls.map(([value]) => value);
    expect(Buffer.from(writes[1]!.body as Uint8Array)).toEqual(Buffer.from(observed.execution.fullHistoryBody));
    expect(writes[1]!.namespace).toBe("verrail/repository-execution-logs");
    expect(writes[2]!.namespace).toBe("verrail/repository-execution-observations");
    expect(result.outputReceipt?.executionFacts.cleanup.checkout).toBe(true);
  }
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
