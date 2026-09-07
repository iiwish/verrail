import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureNativeSource } from "./verrail-native-source.js";
import * as source from "./verrail-native-source.js";
import { captureNativeOutput, finalizeNativeOutputReceipt, validateNativeOutputReceipt } from "./verrail-native-output.js";

const exec = promisify(execFile);
const identity = { workspaceId: "86679997-3f3a-4477-a2fa-d4da812140ae", attemptId: "1e82be4a-a466-4c28-bee6-eb9609b68401", heartbeatRunId: "heartbeat-1", agentId: "agent-1", runId: "run-1", deploymentRevisionId: "deployment-1", agentVersionId: "version-1" };
describe("native terminal output receipt", () => {
  let cwd: string;
  let output: string;
  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-output-")));
    await exec("git", ["init", "-q"], { cwd });
    await writeFile(path.join(cwd, "source.txt"), "input");
    await exec("git", ["add", "."], { cwd });
    await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd });
    output = path.join(cwd, ".verrail/run-artifacts", identity.attemptId);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(cwd, { recursive: true, force: true }); });
  async function inputs() {
    return { cwd, identity, beforeSource: await captureNativeSource({ cwd, identity }), revalidate: vi.fn().mockResolvedValue(undefined) };
  }
  async function files() {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "a.txt"), "actual bytes");
    await writeFile(path.join(output, "b.txt"), "actual bytes");
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1, artifacts: ["a.txt", "b.txt"].map((p) => ({ title: "Candidate", kind: "code_change", path: p })) }));
  }
  const stored = (input: any) => {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    return { sha256, byteSize: input.body.length, objectKey: `${identity.workspaceId}/verrail/run-artifacts/sha256/${sha256}` };
  };
  it("binds changed terminal source to frozen ordered duplicate-content outputs without later reads", async () => {
    const input = await inputs();
    await writeFile(path.join(cwd, "source.txt"), "delivered");
    await files();
    const putFile = vi.fn(async (value) => {
      await rm(output, { recursive: true, force: true });
      expect(value.body.toString()).toBe("actual bytes");
      return stored(value);
    });
    const receipt = await captureNativeOutput({ ...input, storage: { putFile } as any });
    expect(receipt).toMatchObject({ phase: "after_adapter_return", sourceStatus: "stable", collectionStatus: "collected" });
    expect(receipt.sourceAfter.manifest?.contentSha256).not.toBe(input.beforeSource.manifest?.contentSha256);
    expect(receipt.artifacts.map(({ ordinal, path }) => ({ ordinal, path }))).toEqual([{ ordinal: 0, path: "a.txt" }, { ordinal: 1, path: "b.txt" }]);
    expect(validateNativeOutputReceipt(receipt, identity)).toEqual(receipt);
    expect(validateNativeOutputReceipt({ ...receipt, sha256: "a".repeat(64) }, identity)).toBeNull();
    expect(validateNativeOutputReceipt(receipt, { ...identity, runId: "foreign" })).toBeNull();
  });
  it("keeps absent manifest distinct and never needs storage", async () => {
    expect(await captureNativeOutput(await inputs())).toMatchObject({ collectionStatus: "no_manifest", artifacts: [], sourceStatus: "stable" });
  });
  it("freezes terminal execution facts and survives JSON database key reordering", async () => {
    const receipt = await captureNativeOutput(await inputs());
    const facts = { heartbeatRunId: identity.heartbeatRunId, heartbeatStatus: "succeeded", agentId: identity.agentId, logStore: "local_file", logRef: "run.log", logSha256: "a".repeat(64), logBytes: 12, usage: { inputTokens: 4, costUsd: 0.1 }, exitCode: 0, errorCode: null, environmentManifest: null };
    const final = finalizeNativeOutputReceipt(receipt, facts);
    expect(final.finalizedAt).toMatch(/^\d{4}-/);
    expect(Date.parse(final.finalizedAt!)).toBeGreaterThanOrEqual(Date.parse(receipt.uploadFinishedAt));
    facts.usage.inputTokens = 99;
    expect(final.executionFacts?.usage).toEqual({ inputTokens: 4, costUsd: 0.1 });
    const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorder(value[key])])) : value;
    expect(validateNativeOutputReceipt(reorder(final), identity)).toEqual(final);
  });
  it("bounds delayed uploads and never accepts late completion", async () => {
    await rm(path.join(cwd, ".git"), { recursive: true });
    const input = await inputs();
    await files();
    const putFile = vi.fn(async (value) => { await new Promise((resolve) => setTimeout(resolve, 600)); return stored(value); });
    await expect(captureNativeOutput({ ...input, storage: { putFile } as any, timeoutMs: 500 })).rejects.toThrow(/NATIVE_OUTPUT_DEADLINE_EXCEEDED/);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(putFile).toHaveBeenCalledOnce();
  });
  it("latches timer expiry before the monotonic deadline and prevents later upload effects", async () => {
    await rm(path.join(cwd, ".git"), { recursive: true });
    const input = await inputs();
    await files();
    let release!: () => void;
    let started!: () => void;
    const firstUpload = new Promise<void>((resolve) => { release = resolve; });
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const putFile = vi.fn(async (value) => { started(); await firstUpload; return stored(value); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = captureNativeOutput({ ...input, storage: { putFile } as any });
      const rejected = expect(pending).rejects.toThrow("NATIVE_OUTPUT_DEADLINE_EXCEEDED");
      await didStart;
      // Timer delivery can precede the fractional performance.now deadline.
      await vi.advanceTimersByTimeAsync(60_001);
      await rejected;
      release();
      await vi.runAllTimersAsync();
      expect(putFile).toHaveBeenCalledOnce();
    } finally { release(); vi.useRealTimers(); }
  });
  it("rejects source changes between scans before any upload", async () => {
    const input = await inputs();
    await files();
    const original = source.captureNativeSource;
    let calls = 0;
    vi.spyOn(source, "captureNativeSource").mockImplementation(async (value) => {
      const result = await original(value);
      if (++calls === 1) await writeFile(path.join(cwd, "source.txt"), "changed during read interval");
      return result;
    });
    const putFile = vi.fn();
    await expect(captureNativeOutput({ ...input, storage: { putFile } })).rejects.toThrow("NATIVE_OUTPUT_SOURCE_CHANGED");
    expect(putFile).not.toHaveBeenCalled();
  });
  it("does not publish a receipt after partial upload or lease loss", async () => {
    const input = await inputs();
    await files();
    const putFile = vi.fn(async (value) => stored(value)).mockImplementationOnce(async (value) => stored(value)).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(captureNativeOutput({ ...input, storage: { putFile } as any })).rejects.toThrow("NATIVE_OUTPUT_UPLOAD_FAILED");
    expect(putFile).toHaveBeenCalledTimes(2);
    putFile.mockReset().mockImplementation(async (value) => stored(value));
    input.revalidate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lease lost"));
    await expect(captureNativeOutput({ ...input, storage: { putFile } as any })).rejects.toThrow("NATIVE_OUTPUT_BINDING_INVALID");
    expect(putFile).toHaveBeenCalledTimes(2);
  });
  it.each(["manifest", "storage"])("does not expose raw %s failures through error serialization", async (failure) => {
    const input = await inputs();
    await files();
    if (failure === "manifest") await writeFile(path.join(output, "manifest.json"), "SYNTHETIC_PRIVATE_OUTPUT_SENTINEL");
    const putFile = vi.fn().mockRejectedValue(new Error("SYNTHETIC_PRIVATE_OUTPUT_SENTINEL"));
    const error = await captureNativeOutput({ ...input, storage: { putFile } }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error, { depth: 10 })).not.toContain("SYNTHETIC_PRIVATE_OUTPUT_SENTINEL");
    expect(error.cause).toBeUndefined();
  });
});
