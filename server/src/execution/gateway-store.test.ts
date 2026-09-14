import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionGatewayStore, GatewayRuntimeCleanupError, type GatewayRuntime } from "./gateway-store.js";

const dirs: string[] = [];
const request = () => ({ invocationId: randomUUID(), workspaceId: randomUUID(), conversationId: randomUUID(), principalId: "owner", agentVersionId: randomUUID(), deploymentRevisionId: randomUUID(), fencingToken: 1, runtime: "opencode" as const, model: "fixture/test", systemPrompt: "rules", prompt: "hello", directorToken: "private-token-not-to-be-stored-0123456789" });
async function directory() { const dir = await mkdtemp(join(tmpdir(), "verrail-gateway-store-")); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("execution gateway durable store", () => {
  it("fails interrupted work on restart without executing its effects again", async () => {
    const root = await directory();
    const input = request();
    const runtime = vi.fn<GatewayRuntime>(async () => {});
    const store = await createExecutionGatewayStore({ root, runtime });
    await store.submit(input);
    await store.drain();
    await store.close();
    const path = join(root, `${input.invocationId}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.events = record.events.slice(0, 1);
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    const reopened = await createExecutionGatewayStore({ root, runtime });
    try {
      expect(await reopened.submit(input)).toMatchObject({ replayed: true });
      const replay = await reopened.read(input.workspaceId, input.invocationId);
      expect(replay.status).toBe("failed");
      expect(replay.events.at(-1)?.event).toEqual({ type: "error", data: { errorCode: "GATEWAY_RESTARTED" } });
      expect(runtime).toHaveBeenCalledTimes(1);
    } finally { await reopened.close(); }
  });

  it("rejects additional work at capacity and fails closed when cleanup fails", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const runtime: GatewayRuntime = async (_input, { signal }) => {
      started();
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new GatewayRuntimeCleanupError("private diagnostic");
    };
    const store = await createExecutionGatewayStore({ root: await directory(), runtime, maxConcurrent: 1 });
    const input = request();
    try {
      await store.submit(input);
      await ready;
      await expect(store.submit(request())).rejects.toMatchObject({ status: 429 });
      await store.cancel(input.workspaceId, input.invocationId);
      await store.drain();
      const replay = await store.read(input.workspaceId, input.invocationId);
      expect(replay.status).toBe("failed");
      expect(replay.events.at(-1)?.event).toEqual({ type: "error", data: { errorCode: "RUNTIME_CLEANUP_FAILED" } });
      expect(store.healthy()).toBe(false);
      await expect(store.submit(request())).rejects.toMatchObject({ status: 503 });
    } finally { await store.close(); }
  });

  it("executes once, persists replay and does not store the Director token", async () => {
    const runtime = vi.fn<GatewayRuntime>(async (_request, { emit }) => { await emit("hello"); });
    const root = await directory();
    const store = await createExecutionGatewayStore({ root, runtime });
    const input = request();
    try {
      await Promise.all([store.submit(input), store.submit(input)]);
      await store.drain();
      expect(runtime).toHaveBeenCalledTimes(1);
      expect((await store.read(input.workspaceId, input.invocationId)).events.map(row => row.event.type)).toEqual(["start", "chunk", "done"]);
      const raw = await readFile(join(root, `${input.invocationId}.json`), "utf8");
      expect(raw).not.toContain(input.directorToken);
      await expect(store.submit({ ...input, prompt: "different" })).rejects.toMatchObject({ status: 409 });
      await expect(store.read(randomUUID(), input.invocationId)).rejects.toMatchObject({ status: 404 });
    } finally { await store.close(); }
    const reopened = await createExecutionGatewayStore({ root, runtime });
    try {
      await reopened.submit(input);
      await reopened.drain();
      expect(runtime).toHaveBeenCalledTimes(1);
      expect((await reopened.read(input.workspaceId, input.invocationId, 1)).events.map(row => row.cursor)).toEqual([2, 3]);
    } finally { await reopened.close(); }
  });

  it("waits for runtime cleanup before acknowledging cancellation", async () => {
    let cleanup: (() => void) | undefined;
    const runtime: GatewayRuntime = async (_request, { signal }) => {
      await new Promise<void>(resolve => {
        cleanup = resolve;
        if (signal.aborted) resolve();
      });
    };
    const store = await createExecutionGatewayStore({ root: await directory(), runtime });
    const input = request();
    try {
      await store.submit(input);
      while (!cleanup) await new Promise(resolve => setTimeout(resolve, 1));
      await store.cancel(input.workspaceId, input.invocationId);
      expect((await store.read(input.workspaceId, input.invocationId)).status).toBe("cancel_requested");
      cleanup();
      await store.drain();
      expect((await store.read(input.workspaceId, input.invocationId)).status).toBe("canceled");
    } finally { cleanup?.(); await store.close(); }
  });
});
