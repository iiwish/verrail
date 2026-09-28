import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { z } from "zod";
import { canonicalJson } from "@paperclipai/shared/portability-hash";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relativePath = z.string().min(1).max(2048).refine(value => !path.isAbsolute(value)
  && value.split(/[\\/]/).every(part => part !== "" && part !== "." && part !== ".."));
const configurationSchema = z.object({
  schemaVersion: z.literal(1), root: z.string().min(1), entrypoint: relativePath,
  candidateCommit: z.string().regex(/^[a-f0-9]{40}$/), executable: z.string().min(1), executableSha256: hash,
  files: z.array(z.object({ path: relativePath, sha256: hash }).strict()).min(1).max(10000),
  generatedScriptSha256: z.array(hash).max(256).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32768)),
}).strict();
export type ObservedNodeRuntimeConfiguration = z.infer<typeof configurationSchema>;
type RuntimeTransport = { stdin?: Readable; stdout?: Writable; stderr?: Writable;
  onMessage?: (value: unknown) => void; onExit?: () => void };
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const failureCodes = ["unknown", "stdin", "ipc", "child_exit", "child_error", "command_timeout", "command_rejected",
  "protocol", "script_metadata", "generated_script", "script_url", "source_hash", "source_queue", "socket",
  "checkpoint_state", "pause_timeout", "entrypoint_missing", "executable_identity"] as const;
type RuntimeFailureCode = typeof failureCodes[number];
const unavailable = (cause: RuntimeFailureCode = "unknown") => new Error("RUNTIME_OBSERVATION_UNAVAILABLE", { cause });

export function runtimeObservationFailureCode(error: unknown): RuntimeFailureCode {
  const cause = error instanceof Error ? error.cause : undefined;
  return failureCodes.includes(cause as RuntimeFailureCode) ? cause as RuntimeFailureCode : "unknown";
}

async function stableHash(name: string, maxBytes: number) {
  const file = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw unavailable();
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw unavailable();
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs) throw unavailable();
    return { sha256: hash.digest("hex"), inode: before.ino, device: before.dev, ctimeMs: before.ctimeMs, mtimeMs: before.mtimeMs, bytes: before.size };
  } finally { await file.close(); }
}

/** Launch-owned inspector transport. No candidate response or on-disk build stamp
 * is accepted as loaded code. This observes one Node main thread, not a process tree.
 */
export async function launchObservedNodeRuntime(raw: ObservedNodeRuntimeConfiguration, transport: RuntimeTransport = {}) {
  let child: ChildProcess | undefined, socket: WebSocket | undefined;
  let stopped = false, failed = false;
  let firstFailure: RuntimeFailureCode | undefined;
  const fail = (code: RuntimeFailureCode) => { failed = true; firstFailure ??= code; };
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const messageWaiters = new Set<{ kind: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const messages: Array<{ kind: string; value: unknown }> = [];
  async function stop() {
    if (stopped) return;
    stopped = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(unavailable()); }
    pending.clear();
    for (const waiter of messageWaiters) { clearTimeout(waiter.timer); waiter.reject(unavailable()); }
    messageWaiters.clear(); messages.length = 0;
    socket?.terminate();
    if (child?.pid) {
      const group = -child.pid;
      // The group can outlive its leader; a parent close must not cancel cleanup.
      try { process.kill(group, "SIGTERM"); } catch { return; }
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
      try { process.kill(group, "SIGKILL"); } catch {}
    }
  }
  try {
    const config = configurationSchema.parse(raw);
    if (process.platform === "win32" || !path.isAbsolute(config.root) || !path.isAbsolute(config.executable)
      || new Set(config.files.map(file => file.path)).size !== config.files.length
      || !config.files.some(file => file.path === config.entrypoint)
      || Object.keys(config.env).some(key => /^(NODE_(?!ENV$)|LD_|DYLD_)/.test(key))) throw unavailable();
    const root = await realpath(config.root), executable = await realpath(config.executable);
    const executableIdentity = await stableHash(executable, 512 * 1024 * 1024);
    if (executableIdentity.sha256 !== config.executableSha256) throw unavailable();
    const expected = new Map<string, { path: string; sha256: string }>();
    for (const file of config.files) {
      const name = path.join(root, file.path);
      if (await realpath(name) !== name || (await stableHash(name, 16 * 1024 * 1024)).sha256 !== file.sha256) throw unavailable();
      expected.set(name, file);
    }
    const startedAt = new Date().toISOString(), observerSessionId = randomUUID();
    child = spawn(executable, ["--inspect-brk=127.0.0.1:0", path.join(root, config.entrypoint)], {
      cwd: root, env: config.env, detached: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    if (transport.stdin) transport.stdin.pipe(child.stdin!);
    child.stdin!.on("error", () => { fail("stdin"); });
    if (transport.stdout) child.stdout!.pipe(transport.stdout, { end: false }); else child.stdout!.resume();
    child.on("message", value => {
      if (transport.onMessage) { transport.onMessage(value); return; }
      if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string"
        || Buffer.byteLength(JSON.stringify(value)) > 8192) { fail("ipc"); return; }
      const kind = (value as { kind: string }).kind;
      const waiter = [...messageWaiters].find(item => item.kind === kind);
      if (waiter) { clearTimeout(waiter.timer); messageWaiters.delete(waiter); waiter.resolve(value); }
      else if (messages.length < 16) messages.push({ kind, value });
      else fail("ipc");
    });
    child.on("exit", () => { fail("child_exit"); transport.onExit?.(); });
    child.on("error", () => { fail("child_error"); });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => { cleanup(); reject(unavailable()); }, 10_000);
      const error = () => { cleanup(); reject(unavailable()); };
      const data = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = /^Debugger listening on (ws:\/\/127\.0\.0\.1:[1-9][0-9]*\/[a-f0-9-]{36})\r?\n/.exec(buffer);
        if (match) { cleanup(); resolve(match[1]!); }
        else if (buffer.length > 8192) error();
      };
      const cleanup = () => { clearTimeout(timer); child!.stderr!.off("data", data); child!.off("error", error); child!.off("exit", error);
        if (transport.stderr) child!.stderr!.pipe(transport.stderr, { end: false }); else child!.stderr!.resume(); };
      child!.stderr!.on("data", data); child!.once("error", error); child!.once("exit", error);
    });
    socket = new WebSocket(endpoint, { maxPayload: 20 * 1024 * 1024, followRedirects: false });
    let nextId = 0;
    function post(method: string, params: Record<string, unknown> = {}): Promise<any> {
      if (stopped || socket!.readyState !== WebSocket.OPEN || pending.size >= 256) return Promise.reject(unavailable());
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); fail("command_timeout"); reject(unavailable("command_timeout")); }, 10_000);
        pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
      });
    }
    const scripts = new Map<string, { path: string; sha256: string }>();
    const generatedScripts = new Set<string>();
    let scriptCount = 0, sourceQueue = Promise.resolve(), checkpointing = false;
    let pausedResolve: (() => void) | undefined;
    socket.on("message", data => {
      try {
        const message = JSON.parse(data.toString());
        if (typeof message.id === "number") {
          const request = pending.get(message.id);
          if (!request) { fail("protocol"); return; }
          pending.delete(message.id); clearTimeout(request.timer);
          if (message.error) request.reject(unavailable("command_rejected")); else request.resolve(message.result);
        } else if (message.method === "Debugger.scriptParsed") {
          const script = message.params;
          if (++scriptCount > 20000 || typeof script.url !== "string" || script.hasSourceURL) { fail("script_metadata"); return; }
          if (script.url.startsWith("node:")) return;
          sourceQueue = sourceQueue.then(async () => {
            if (script.url === "") {
              const result = await post("Debugger.getScriptSource", { scriptId: script.scriptId });
              if (typeof result.scriptSource !== "string" || Buffer.byteLength(result.scriptSource) > 1024 * 1024) throw unavailable("generated_script");
              const sha256 = createHash("sha256").update(result.scriptSource).digest("hex");
              if (!config.generatedScriptSha256?.includes(sha256)) throw unavailable("generated_script");
              generatedScripts.add(sha256);
              return;
            }
            if (!script.url.startsWith("file:")) throw unavailable("script_url");
            const entry = expected.get(fileURLToPath(script.url));
            if (!entry) throw unavailable("script_url");
            const result = await post("Debugger.getScriptSource", { scriptId: script.scriptId });
            if (typeof result.scriptSource !== "string" || Buffer.byteLength(result.scriptSource) > 16 * 1024 * 1024
              || createHash("sha256").update(result.scriptSource).digest("hex") !== entry.sha256) throw unavailable("source_hash");
            scripts.set(entry.path, entry);
          }).catch(error => { const code = runtimeObservationFailureCode(error); fail(code === "unknown" ? "source_queue" : code); });
        } else if (message.method === "Debugger.paused") {
          if (checkpointing) pausedResolve?.();
          else void sourceQueue.then(() => post("Debugger.resume")).catch(() => { fail("command_rejected"); });
        }
      } catch { fail("protocol"); }
    });
    socket.on("error", () => { fail("socket"); }); socket.on("close", () => { fail("socket"); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket!.terminate(); reject(unavailable()); }, 10_000);
      socket!.once("open", () => { clearTimeout(timer); resolve(); });
      socket!.once("error", () => { clearTimeout(timer); reject(unavailable()); });
    });
    await post("Debugger.enable", { maxScriptsCacheSize: 256 * 1024 * 1024 });
    await post("Runtime.runIfWaitingForDebugger");
    return {
      stop,
      send(value: unknown) {
        if (stopped || !child?.connected) throw unavailable();
        child.send(value as Parameters<ChildProcess["send"]>[0], error => { if (error) fail("ipc"); });
      },
      async waitForMessage(kind: string): Promise<unknown> {
        const index = messages.findIndex(message => message.kind === kind);
        if (index !== -1) return messages.splice(index, 1)[0]!.value;
        if (stopped) throw unavailable();
        return new Promise((resolve, reject) => {
          const waiter = { kind, resolve, reject, timer: setTimeout(() => { messageWaiters.delete(waiter); reject(unavailable()); }, 10_000) };
          messageWaiters.add(waiter);
        });
      },
      async checkpoint() {
        if (stopped || failed || checkpointing) throw unavailable(firstFailure ?? "checkpoint_state");
        checkpointing = true;
        let timer: NodeJS.Timeout | undefined;
        try {
          const paused = new Promise<void>((resolve, reject) => {
            pausedResolve = resolve; timer = setTimeout(() => reject(unavailable("pause_timeout")), 10_000);
          });
          // Observe at an actual V8 pause, not after an arbitrary sleep.
          await Promise.all([post("Debugger.pause"), paused]);
          await sourceQueue;
          if (failed || !scripts.has(config.entrypoint)) throw unavailable(firstFailure ?? "entrypoint_missing");
          if (canonicalJson(await stableHash(executable, 512 * 1024 * 1024)) !== canonicalJson(executableIdentity)) throw unavailable("executable_identity");
          const observation = { schemaVersion: 1, kind: "verrail.node-runtime-observation", assurance: "observed_main_thread_scripts",
            observerSessionId, pid: child!.pid!, candidateCommit: config.candidateCommit, executableSha256: config.executableSha256,
            manifestSha256: digest({ candidateCommit: config.candidateCommit, files: config.files }), startedAt, observedAt: new Date().toISOString(),
            scripts: [...scripts.values()].sort((a, b) => a.path.localeCompare(b.path)),
            generatedScriptSha256: [...generatedScripts].sort(),
            limitations: ["main_thread_only", "native_addons_and_child_processes_not_attested", "build_provenance_requires_pinned_manifest"] };
          return { ...observation, sha256: digest(observation) };
        } catch (error) { throw unavailable(firstFailure ?? runtimeObservationFailureCode(error)); }
        finally { clearTimeout(timer); pausedResolve = undefined; checkpointing = false; await post("Debugger.resume").catch(() => { fail("command_rejected"); }); }
      },
    };
  } catch { await stop(); throw unavailable(); }
}

const nativeConfigurationSchema = z.object({
  schemaVersion: z.literal(1), root: z.string().min(1), candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
  executable: z.string().min(1), executableSha256: hash,
  args: z.array(z.string().max(4096)).max(32), env: configurationSchema.shape.env,
}).strict();
export type ObservedNativeRuntimeConfiguration = z.infer<typeof nativeConfigurationSchema>;

/** A cold exec of a private, read-only copy binds the executable actually launched.
 * This is HostTrusted provenance, not shared-library or hostile same-UID isolation.
 */
export async function launchObservedNativeRuntime(raw: ObservedNativeRuntimeConfiguration, transport: RuntimeTransport = {}) {
  const config = nativeConfigurationSchema.parse(raw);
  if (!path.isAbsolute(config.root) || !path.isAbsolute(config.executable) || process.platform === "win32"
    || Object.keys(config.env).some(key => /^(NODE_(?!ENV$)|LD_|DYLD_)/.test(key))) throw unavailable();
  const root = await realpath(config.root), original = await realpath(config.executable);
  if ((await stableHash(original, 512 * 1024 * 1024)).sha256 !== config.executableSha256) throw unavailable();
  const directory = await mkdtemp(path.join(os.tmpdir(), "verrail-observed-exec-"));
  let child: ChildProcess | undefined, stopped = false, finishedAt: string | null = null;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
        await new Promise(resolve => setTimeout(resolve, 1000));
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await chmod(directory, 0o700);
    const executable = path.join(directory, "runtime");
    await copyFile(original, executable, constants.COPYFILE_EXCL);
    await chmod(executable, 0o500);
    const identity = await stableHash(executable, 512 * 1024 * 1024);
    if (identity.sha256 !== config.executableSha256) throw unavailable();
    const startedAt = new Date().toISOString(), observerSessionId = randomUUID();
    child = spawn(executable, config.args, { cwd: root, env: config.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.on("exit", () => { finishedAt = new Date().toISOString(); transport.onExit?.(); });
    child.on("error", () => {});
    child.stdin!.on("error", () => {});
    if (transport.stdin) transport.stdin.pipe(child.stdin!);
    if (transport.stdout) child.stdout!.pipe(transport.stdout, { end: false }); else child.stdout!.resume();
    if (transport.stderr) child.stderr!.pipe(transport.stderr, { end: false }); else child.stderr!.resume();
    await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    return { stop, async checkpoint() {
      if (stopped
        || canonicalJson(await stableHash(executable, 512 * 1024 * 1024)) !== canonicalJson(identity)) throw unavailable();
      const observation = { schemaVersion: 1, kind: "verrail.native-runtime-observation", assurance: "launch_owned_immutable_executable",
        observerSessionId, pid: child!.pid!, candidateCommit: config.candidateCommit, executableSha256: config.executableSha256,
        startedAt, observedAt: new Date().toISOString(), finishedAt, exitCode: child!.exitCode, signal: child!.signalCode,
        limitations: ["shared_libraries_not_attested", "host_trusted_not_same_uid_isolation"] };
      return { ...observation, sha256: digest(observation) };
    } };
  } catch { await stop(); throw unavailable(); }
}

export const deliveryRuntimeComponentSchema = z.enum(["server", "domain", "plugin", "harness"]);
export const deliveryRuntimeConfigurationSchema = z.object({
  schemaVersion: z.literal(1), component: deliveryRuntimeComponentSchema, sessionId: z.string().uuid(),
  manifestSha256: hash, verifierBuildSha256: hash, directory: z.string().min(1), privateKey: z.string().min(1).max(4096),
  node: configurationSchema.optional(), native: nativeConfigurationSchema.optional(),
}).strict().refine(value => value.component === "domain" ? !!value.native && !value.node
  : value.component === "harness" ? Boolean(value.node) !== Boolean(value.native) : !!value.node && !value.native);
