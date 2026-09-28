import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureNativeSource } from "./verrail-native-source.js";
import * as source from "./verrail-native-source.js";
import { captureNativeOutput, finalizeNativeOutputReceipt, validateNativeOutputReceipt } from "./verrail-native-output.js";
import { bindNativeDispatchConfiguration } from "./verrail-native-dispatch.js";
import { canonicalJson } from "@paperclipai/shared/portability-hash";

const exec = promisify(execFile);
const identity = { workspaceId: "86679997-3f3a-4477-a2fa-d4da812140ae", attemptId: "1e82be4a-a466-4c28-bee6-eb9609b68401", heartbeatRunId: randomUUID(), agentId: randomUUID(), runId: randomUUID(), deploymentRevisionId: randomUUID(), agentVersionId: randomUUID() };
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
  async function snapshotManifest() {
    await files();
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 2, artifacts: [
      { type: "source_snapshot", title: "Fixed source", format: "git_bundle", scopeVersion: 2 },
    ] }));
  }
  const sign = (value: any) => {
    const { sha256: _, ...canonical } = value;
    return { ...canonical, sha256: createHash("sha256").update(JSON.stringify(canonical, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)).digest("hex") };
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
  it("exports a trusted opt-in source bundle and never treats ordinary code files as snapshots", async () => {
    const input = await inputs();
    await files();
    await writeFile(path.join(cwd, "source.txt"), "fixed dirty source");
    await writeFile(path.join(cwd, "untracked.txt"), "new source");
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 2, artifacts: [
      { type: "source_snapshot", title: "Fixed code", format: "git_bundle", scopeVersion: 2 },
      { type: "file", path: "a.txt", title: "Ordinary code file", kind: "code_change" },
    ] }));
    const uploaded: any[] = [];
    const receipt = await captureNativeOutput({ ...input, storage: { putFile: async (value: any) => { uploaded.push(value); return stored(value); } } as any });
    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.artifacts[0]).toMatchObject({ path: "source-0.bundle", kind: "code_change", sourceSnapshot: {
      schemaVersion: 1, format: "git_bundle", scopeVersion: 2, sourceContentSha256: receipt.sourceAfter.manifest?.contentSha256,
    } });
    expect(receipt.artifacts[1]).not.toHaveProperty("sourceSnapshot");
    expect(uploaded[0].body.subarray(0, 16).toString()).toContain("git bundle");
    expect(validateNativeOutputReceipt(receipt, identity)).toEqual(receipt);
  });
  it("keeps a v1 dispatch on its original scope and refuses v2 snapshot requests", async () => {
    const input = { ...await inputs(), beforeSource: await captureNativeSource({ cwd, identity, scopeVersion: 1 }) };
    const ordinary = await captureNativeOutput(input);
    expect(ordinary.schemaVersion).toBe(1);
    expect(ordinary.sourceBefore.scope.version).toBe(1);
    expect(ordinary.sourceAfter.scope.version).toBe(1);
    await files();
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 2, artifacts: [
      { type: "source_snapshot", title: "Not supported for v1", format: "git_bundle", scopeVersion: 2 },
    ] }));
    const putFile = vi.fn();
    await expect(captureNativeOutput({ ...input, storage: { putFile } })).rejects.toThrow("NATIVE_ARTIFACT_INVALID");
    expect(putFile).not.toHaveBeenCalled();
  });
  it("rejects snapshot metadata on ordinary files, mismatched scopes and caller-added fields even with recomputed digests", async () => {
    await snapshotManifest();
    const receipt = await captureNativeOutput({ ...await inputs(), storage: { putFile: async (value: any) => stored(value) } as any });
    const mutations = [
      (value: any) => { value.artifacts[0].type = "file"; },
      (value: any) => { value.artifacts[0].sourceSnapshot.sourceContentSha256 = "a".repeat(64); },
      (value: any) => { value.artifacts[0].sourceSnapshot.scopeVersion = 1; },
      (value: any) => { value.artifacts[0].sourceSnapshot.testedCommit = "a".repeat(40); },
      (value: any) => { value.artifacts[0].kind = "report"; },
      (value: any) => { value.artifacts[0].path = "caller.bundle"; },
      (value: any) => { value.schemaVersion = 1; },
      (value: any) => { value.sourceAfter.schemaVersion = 1; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(receipt);
      mutate(value);
      expect(validateNativeOutputReceipt(sign(value), identity)).toBeNull();
    }
    const reversed = JSON.parse(JSON.stringify(receipt), (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value);
    expect(validateNativeOutputReceipt(reversed, identity)).toEqual(receipt);
  });
  it.each(["changed", "unavailable"])("does not upload a source snapshot when the final source is %s", async (state) => {
    const input = await inputs();
    await snapshotManifest();
    const original = source.captureNativeSource;
    let scans = 0;
    vi.spyOn(source, "captureNativeSource").mockImplementation(async (value) => {
      if (++scans === 2) {
        if (state === "unavailable") return source.unavailableNativeSource(identity, "source_changed", "after_adapter_return");
        await writeFile(path.join(cwd, "source.txt"), "changed after export");
      }
      return original(value);
    });
    const putFile = vi.fn();
    await expect(captureNativeOutput({ ...input, storage: { putFile } })).rejects.toThrow(/NATIVE_OUTPUT_SOURCE_/);
    expect(putFile).not.toHaveBeenCalled();
  });
  it("allows delivery record churn during v2 snapshot collection but freezes bundle bytes before upload", async () => {
    const input = await inputs();
    await snapshotManifest();
    const original = source.freezeNativeSource;
    vi.spyOn(source, "freezeNativeSource").mockImplementation(async (value) => {
      const frozen = await original(value);
      await writeFile(path.join(cwd, ".verrail/growing.log"), "delivery bookkeeping");
      return frozen;
    });
    const putFile = vi.fn(async (value: any) => {
      await rm(output, { recursive: true, force: true });
      await writeFile(path.join(cwd, "source.txt"), "changed after collection");
      return stored(value);
    });
    const receipt = await captureNativeOutput({ ...input, storage: { putFile } as any });
    expect(receipt.sourceStatus).toBe("stable");
    expect(receipt.artifacts[0]).toHaveProperty("sourceSnapshot");
    expect(receipt.artifacts[0]!.contentHash).toBe(stored(putFile.mock.calls[0]![0]).sha256);
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

  it("binds optional permission observations to the same run and dispatch without trusting a recomputed outer receipt", async () => {
    const dispatch = bindNativeDispatchConfiguration({ identity, runtime: "codex_local", model: "fixture", config: { model: "fixture" },
      permissionConfig: {}, agentVersionContentHash: "a".repeat(64), deploymentRevisionContentHash: "a".repeat(64) });
    const base = { schemaVersion: 1, kind: "verrail.native-permission-observation", scope: "control_plane_api", identity, dispatchSha256: dispatch.sha256,
      tokenSha256: "b".repeat(64), apiOriginSha256: "c".repeat(64),
      probes: [{ name: "agent_self", status: 200 }, { name: "board_context_denied", status: 403 }, { name: "invalid_credential_denied", status: 401 }, { name: "run_header_mismatch_denied", status: 422 }],
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), limitations: ["not_filesystem_or_network_isolation", "not_independent_runtime_attestation"] };
    const observation = { ...base, sha256: createHash("sha256").update(canonicalJson(base)).digest("hex") };
    const receipt = await captureNativeOutput(await inputs());
    const facts = { heartbeatRunId: identity.heartbeatRunId, heartbeatStatus: "succeeded", agentId: identity.agentId,
      logStore: null, logRef: null, logSha256: null, logBytes: null, usage: null, exitCode: 0, errorCode: null, environmentManifest: null,
      dispatchConfiguration: dispatch, permissionObservation: observation };
    const final = finalizeNativeOutputReceipt(receipt, facts);
    expect(validateNativeOutputReceipt(final, identity)?.executionFacts?.permissionObservation).toEqual(observation);
    expect(() => finalizeNativeOutputReceipt(receipt, { ...facts, permissionObservation: { ...observation, tokenSha256: "d".repeat(64) } })).toThrow();
    expect(() => finalizeNativeOutputReceipt(receipt, { ...facts, dispatchConfiguration: undefined })).toThrow();
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
