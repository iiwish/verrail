import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { executionGatewayRequestSchema, conversationInvocationEventSchema, type ExecutionGatewayRequest, type ConversationInvocationEvent } from "@paperclipai/shared";
import { conflict, notFound, HttpError } from "../errors.js";
import { reduceConversationInvocation, type ConversationInvocationState } from "../services/conversation-invocation-state.js";

export type GatewayRuntime = (request: ExecutionGatewayRequest, control: { signal: AbortSignal; emit: (text: string) => Promise<void> }) => Promise<void>;
export class GatewayRuntimeCleanupError extends Error {}
const recordSchema = z.object({
  invocationId: z.string().uuid(), workspaceId: z.string().uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  events: z.array(z.object({ cursor: z.number().int().positive(), at: z.string().datetime(), event: conversationInvocationEventSchema }).strict()).max(10002),
}).strict();
type Record = z.infer<typeof recordSchema>;
const initialState = (): ConversationInvocationState => ({ status: "queued", output: "", errorCode: null, startedAt: null, finishedAt: null });

/** The caller must hold an exclusive process lock on root for the store's lifetime. */
export async function createExecutionGatewayStore(options: { root: string; runtime: GatewayRuntime; maxConcurrent?: number; timeoutMs?: number }) {
  if (!isAbsolute(options.root)) throw new Error("Gateway storage requires an absolute path");
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(options.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077)) throw new Error("Gateway storage must be private");
  const records = new Map<string, Record>();
  const states = new Map<string, ConversationInvocationState>();
  const active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let tail: Promise<unknown> = Promise.resolve();
  let healthy = true;
  let closing = false;
  const maxConcurrent = options.maxConcurrent ?? 3;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 20) throw new Error("Invalid gateway concurrency");
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("Invalid gateway timeout");

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }

  async function persist(record: Record) {
    const temporary = join(options.root, `${record.invocationId}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(options.root, `${record.invocationId}.json`));
      const directory = await open(options.root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      records.set(record.invocationId, record);
    } catch (error) {
      healthy = false;
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async function appendLocked(id: string, event: ConversationInvocationEvent) {
      const record = records.get(id)!;
      if (record.events.length >= 10000 && !["done", "error"].includes(event.type)) throw new Error("Gateway event limit");
      const at = new Date();
      const state = reduceConversationInvocation(states.get(id)!, event, at);
      const updated = { ...record, events: [...record.events, { cursor: record.events.length + 1, at: at.toISOString(), event }] };
      await persist(updated);
      states.set(id, state);
  }

  function append(id: string, event: ConversationInvocationEvent) {
    return serial(() => appendLocked(id, event));
  }

  for (const filename of await readdir(options.root)) {
    if (!filename.endsWith(".json")) continue;
    const path = join(options.root, filename);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 || (stat.mode & 0o077)) throw new Error("Invalid gateway record file");
    const record = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (filename !== `${record.invocationId}.json`) throw new Error("Gateway record identity mismatch");
    let state = initialState();
    for (const [index, row] of record.events.entries()) {
      if (row.cursor !== index + 1) throw new Error("Gateway record cursor gap");
      state = reduceConversationInvocation(state, row.event, new Date(row.at));
    }
    records.set(record.invocationId, record);
    states.set(record.invocationId, state);
    // Container restart kills child processes. Never replay an unacknowledged effect.
    if (!state.finishedAt) await append(record.invocationId, { type: "error", data: { errorCode: "GATEWAY_RESTARTED" } });
  }

  function find(workspaceId: string, id: string) {
    const record = records.get(id);
    if (!record || record.workspaceId !== workspaceId) throw notFound("Gateway invocation not found");
    return record;
  }

  async function run(input: ExecutionGatewayRequest, abort: AbortController) {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
    try {
      if (!abort.signal.aborted) {
        await append(input.invocationId, { type: "start", data: {} });
        await options.runtime(input, {
          signal: abort.signal,
          emit: async text => { await append(input.invocationId, conversationInvocationEventSchema.parse({ type: "chunk", data: { text } })); },
        });
      }
      await append(input.invocationId, timedOut
        ? { type: "error", data: { errorCode: "RUNTIME_TIMEOUT" } }
        : { type: "done", data: { status: abort.signal.aborted ? "canceled" : "succeeded" } });
    } catch (error) {
      const cleanupFailed = error instanceof GatewayRuntimeCleanupError;
      if (cleanupFailed) healthy = false;
      try {
        await append(input.invocationId, abort.signal.aborted && !timedOut && !cleanupFailed
          ? { type: "done", data: { status: "canceled" } }
          : { type: "error", data: { errorCode: cleanupFailed ? "RUNTIME_CLEANUP_FAILED" : timedOut ? "RUNTIME_TIMEOUT" : "RUNTIME_FAILED" } });
      } catch { healthy = false; }
    } finally {
      clearTimeout(timeout);
      active.delete(input.invocationId);
    }
  }

  return {
    async submit(raw: ExecutionGatewayRequest) {
      const input = executionGatewayRequestSchema.parse(raw);
      const { directorToken: _secret, ...identity } = input;
      const requestHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
      return serial(async () => {
        if (!healthy || closing) throw new HttpError(503, "Gateway unavailable");
        const existing = records.get(input.invocationId);
        if (existing) {
          if (existing.workspaceId !== input.workspaceId || existing.requestHash !== requestHash) throw conflict("Gateway invocation identity conflict");
          return { invocationId: input.invocationId, replayed: true };
        }
        if (active.size >= maxConcurrent) throw new HttpError(429, "Gateway capacity exhausted");
        await persist({ invocationId: input.invocationId, workspaceId: input.workspaceId, requestHash, events: [] });
        states.set(input.invocationId, initialState());
        const abort = new AbortController();
        const done = Promise.resolve().then(() => run(input, abort));
        active.set(input.invocationId, { abort, done });
        return { invocationId: input.invocationId, replayed: false };
      });
    },
    async read(workspaceId: string, id: string, after = 0) {
      if (!Number.isSafeInteger(after) || after < 0) throw conflict("Invalid gateway cursor");
      return serial(async () => {
        const record = find(workspaceId, id);
        return { invocationId: id, status: states.get(id)!.status, lastEventCursor: record.events.length, events: record.events.filter(row => row.cursor > after).slice(0, 200) };
      });
    },
    async cancel(workspaceId: string, id: string) {
      await serial(async () => {
        find(workspaceId, id);
        const runtime = active.get(id);
        if (runtime && !runtime.abort.signal.aborted && !states.get(id)!.finishedAt) {
          await appendLocked(id, { type: "cancel_requested", data: {} });
          runtime.abort.abort();
        }
      });
    },
    async drain() { await Promise.all([...active.values()].map(runtime => runtime.done)); await tail; },
    async close() {
      closing = true;
      await tail;
      for (const runtime of active.values()) runtime.abort.abort();
      await Promise.all([...active.values()].map(runtime => runtime.done));
      await tail;
    },
    healthy: () => healthy && !closing,
  };
}
