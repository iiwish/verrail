import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeHttpClient, type OpenCodeRuntimeWitness } from "@paperclipai/adapter-opencode-local/http-client";
import { DIRECTOR_GATEWAY_TOOL_NAMES } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { GatewayRuntimeCleanupError, type GatewayRuntime } from "./gateway-store.js";
import { openCodeCandidateIdentitySchema, openCodeObserverBoundSchema, openCodeObserverStartedSchema, openCodeRuntimeDigest,
  type OpenCodeCandidateIdentity, type OpenCodeCandidateRuntimeBinding } from "../services/opencode-runtime-observation.js";

export function createOpenCodeGatewayRuntime(options: {
  command?: string;
  version: string;
  controlPlaneUrl: string;
  providers: Record<string, unknown>;
}): GatewayRuntime {
  const callback = new URL("/api/director/mcp", options.controlPlaneUrl);
  if (!["http:", "https:"].includes(callback.protocol) || callback.username || callback.password) throw new Error("Invalid control plane URL");
  const runtime = createOpenCodeToolRuntime({ ...options, tools: DIRECTOR_GATEWAY_TOOL_NAMES.map(name => `director_${name}`),
    mcp: (input: Parameters<GatewayRuntime>[0]) => ({ director: { type: "remote", url: callback.href,
      oauth: false, headers: { "X-Verrail-Chat-Token": input.directorToken } } }),
  });
  return async (input, control) => { await runtime(input, control); };
}

type OpenCodePrompt = { model: string; systemPrompt: string; prompt: string };
type RuntimeControl = { signal: AbortSignal; emit: (text: string) => Promise<void> };
type CollectedFacts = Awaited<ReturnType<ReturnType<typeof createOpenCodeHttpClient>["collectExecutionFacts"]>>;
export type OpenCodeRuntimeFacts = CollectedFacts & {
  runtime: "opencode";
  startedAt: string;
  finishedAt: string;
  cleanup: { runtime: true; home: true };
  runtimeWitness: { before: OpenCodeRuntimeWitness; after: OpenCodeRuntimeWitness };
  fullHistory: CollectedFacts["fullHistory"] & { projectionSha256: string };
  candidateRuntime?: OpenCodeCandidateRuntimeBinding;
};
export type OpenCodeTrustedObserver = { command: string; entrypoint: string; configurationFile: string; sessionId: string; manifestSha256: string };

// Tool configuration is provided by trusted runtime wiring, never model input.
export function createOpenCodeToolRuntime<T extends OpenCodePrompt>(options: {
  command?: string;
  version: string;
  providers: Record<string, unknown>;
  tools: readonly string[];
  executionTimeoutMs?: number;
  requireExecutionFacts?: boolean;
  trustedObserver?: OpenCodeTrustedObserver & { identity(input: T): OpenCodeCandidateIdentity };
  mcp: (input: T) => Record<string, unknown>;
}): (input: T, control: RuntimeControl) => Promise<OpenCodeRuntimeFacts | void> {
  if (!options.tools.length || options.tools.some(name => !/^[a-z][a-z0-9_]+$/.test(name))) throw new Error("Invalid runtime tool allowlist");
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error("Pin an exact OpenCode version");
  if (options.trustedObserver && (!options.requireExecutionFacts || !options.trustedObserver.command.startsWith("/")
    || !options.trustedObserver.entrypoint.startsWith("/") || !options.trustedObserver.configurationFile.startsWith("/"))) throw new Error("Invalid trusted OpenCode observer");
  return async (input, { signal, emit }) => {
    if (signal.aborted) return;
    const startedAt = new Date().toISOString();
    const provider = input.model.slice(0, input.model.indexOf("/"));
    if (!Object.hasOwn(options.providers, provider)) throw new Error("Model provider is not configured");
    const identity = options.trustedObserver ? openCodeCandidateIdentitySchema.parse(options.trustedObserver.identity(input)) : undefined;
    const home = await mkdtemp(join(await realpath(tmpdir()), "verrail-opencode-invocation-"));
    const reservation = createServer();
    let proc: ReturnType<typeof spawn> | undefined;
    let closed: Promise<void> | undefined;
    let spawnedError: Error | undefined;
    let stream: Awaited<ReturnType<ReturnType<typeof createOpenCodeHttpClient>["subscribeText"]>> | undefined;
    let facts: CollectedFacts | undefined;
    let before: OpenCodeRuntimeWitness | undefined;
    let after: OpenCodeRuntimeWitness | undefined;
    let nativePid: number | undefined;
    let candidateRuntime: OpenCodeCandidateRuntimeBinding | undefined;
    const observerMessages = new Map<string, unknown>();
    let notifyObserver: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
      if (signal.aborted) return;
      const password = randomBytes(32).toString("hex");
      const toolNames = [...options.tools];
      const config = {
        share: "disabled", enabled_providers: Object.keys(options.providers), provider: options.providers,
        model: input.model, small_model: input.model,
        permission: { "*": "deny", ...Object.fromEntries(toolNames.map(name => [name, "allow"])) },
        mcp: options.mcp(input),
      };
      const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
      proc = spawn(options.trustedObserver?.command ?? options.command ?? "opencode", options.trustedObserver ? [options.trustedObserver.entrypoint, ...args] : args, {
        cwd: home, detached: process.platform !== "win32", stdio: options.trustedObserver ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
        env: {
          PATH: process.env.PATH, HOME: home,
          XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
          OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          ...(options.trustedObserver ? { VERRAIL_OPENCODE_OBSERVER_CONFIG: options.trustedObserver.configurationFile,
            VERRAIL_OPENCODE_EXECUTION_IDENTITY: JSON.stringify(identity) } : {}),
        },
      });
      proc.on("error", error => { spawnedError = error; });
      closed = new Promise(resolve => proc!.once("close", () => resolve()));
      if (options.trustedObserver) proc.on("message", value => {
        try {
          if (Buffer.byteLength(JSON.stringify(value)) > 8192) throw new Error("Invalid observer message");
          const parsed = openCodeObserverStartedSchema.or(openCodeObserverBoundSchema).parse(value);
          if (observerMessages.has(parsed.kind) || parsed.observerPid !== proc!.pid || parsed.sessionId !== options.trustedObserver!.sessionId
            || parsed.manifestSha256 !== options.trustedObserver!.manifestSha256 || (nativePid !== undefined && parsed.nativePid !== nativePid)) {
            throw new Error("Invalid observer binding");
          }
          nativePid = parsed.nativePid; observerMessages.set(parsed.kind, parsed);
        } catch { spawnedError = new Error("OpenCode candidate observer failed"); }
        notifyObserver?.();
      });
      const waitForObserver = async (kind: string) => {
        if (!observerMessages.has(kind)) await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => { clearTimeout(timer); signal.removeEventListener("abort", aborted);
            proc!.off("close", exited); notifyObserver = undefined; error ? reject(error) : resolve(); };
          const exited = () => finish(new Error("OpenCode candidate observer exited"));
          const aborted = () => finish(new Error("OpenCode candidate observer canceled"));
          const timer = setTimeout(() => finish(new Error("OpenCode candidate observer timeout")), 10_000);
          notifyObserver = () => { if (spawnedError) finish(spawnedError); else if (observerMessages.has(kind)) finish(); };
          proc!.once("close", exited); signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted(); else if (proc!.exitCode !== null) exited(); else notifyObserver();
        });
        if (spawnedError) throw spawnedError;
        return observerMessages.get(kind);
      };
      if (options.trustedObserver) await waitForObserver("verrail.opencode-runtime-started");
      const url = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        signal.throwIfAborted();
        if (spawnedError || proc.exitCode !== null) throw new Error("OpenCode failed to start");
        try {
          const health = await fetch(`${url}/global/health`, {
            headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: "error",
          });
          ready = health.ok;
          await health.body?.cancel();
          if (ready) break;
        } catch { signal.throwIfAborted(); }
        await delay(100, undefined, { signal });
      }
      if (!ready) throw new Error("OpenCode startup timeout");
      const client = createOpenCodeHttpClient({ url, password, directory: home, version: options.version,
        executionTimeoutMs: options.executionTimeoutMs });
      const session = await client.createSession({ allowedTools: toolNames }, signal);
      if (options.trustedObserver) {
        proc.send!({ kind: "verrail.opencode-bind-session", sessionId: session }, error => { if (error) { spawnedError = error; notifyObserver?.(); } });
        candidateRuntime = openCodeObserverBoundSchema.parse(await waitForObserver("verrail.opencode-session-bound"));
        if (candidateRuntime.executionIdentitySha256 !== openCodeRuntimeDigest(identity) || candidateRuntime.httpSession.sessionId !== session
          || candidateRuntime.httpSession.runtimeVersion !== options.version || candidateRuntime.httpSession.homeSha256 !== createHash("sha256").update(home).digest("hex")) {
          throw new Error("OpenCode candidate session mismatch");
        }
      }
      const expectedRuntime = { model: input.model, enabledProviders: Object.keys(options.providers) };
      if (options.requireExecutionFacts) before = await client.collectRuntimeWitness(session, expectedRuntime, signal);
      const messages = new Map<string, string>();
      stream = await client.subscribeText(session, async (chunk, messageId) => {
        await emit(chunk);
        messages.set(messageId, (messages.get(messageId) ?? "") + chunk);
      }, signal);
      const result = await Promise.race([
        client.promptMessage(session, { model: input.model, system: input.systemPrompt, prompt: input.prompt }, signal),
        stream.done.then(() => { throw new Error("OpenCode event stream ended before completion"); }),
      ]);
      stream.close();
      await stream.done;
      // Tool rounds have distinct assistant messages; only reconcile the final
      // response with its own deltas, not earlier progress from the same session.
      const text = messages.get(result.messageId) ?? "";
      if (!result.text.trim() || !result.text.startsWith(text)) throw new Error("OpenCode response mismatch");
      if (result.text.length > text.length) await emit(result.text.slice(text.length));
      if (options.requireExecutionFacts) {
        after = await client.collectRuntimeWitness(session, expectedRuntime, signal);
        const { checkedAt: _beforeTime, ...beforeConfiguration } = before!;
        const { checkedAt: _afterTime, ...afterConfiguration } = after;
        if (canonicalJson(beforeConfiguration) !== canonicalJson(afterConfiguration)) throw new Error("OpenCode runtime configuration changed");
        facts = await client.collectExecutionFacts(session, { model: input.model, finalMessageId: result.messageId }, signal);
        if (candidateRuntime && candidateRuntime.httpSession.createdAt !== facts.sessionCreatedAt) throw new Error("OpenCode candidate session mismatch");
      }
    } finally {
      stream?.close();
      await stream?.done.catch(() => {});
      let cleanupFailure: unknown;
      try {
      if (proc?.pid) {
        const pid = process.platform === "win32" ? proc.pid : -proc.pid;
        try { process.kill(pid, "SIGTERM"); } catch {}
        const timer = setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, 2000);
        await closed;
        clearTimeout(timer);
        if (process.platform !== "win32") {
          // A parent can exit while descendants retain the process group.
          try { process.kill(pid, "SIGKILL"); } catch {}
          for (let attempt = 0; attempt < 100; attempt++) {
            try { process.kill(pid, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
              throw new GatewayRuntimeCleanupError("OpenCode process group cleanup could not be verified");
            }
            if (attempt === 99) throw new GatewayRuntimeCleanupError("OpenCode process group did not stop");
            await delay(20);
          }
        }
      }
      } catch (error) { cleanupFailure = error; }
      try {
      if (nativePid) {
        try { process.kill(-nativePid, "SIGKILL"); } catch {}
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(-nativePid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
            throw new GatewayRuntimeCleanupError("OpenCode native process group cleanup could not be verified");
          }
          if (attempt === 99) throw new GatewayRuntimeCleanupError("OpenCode native process group did not stop");
          await delay(20);
        }
      }
      } catch (error) { cleanupFailure ??= error; }
      if (cleanupFailure) throw cleanupFailure;
      // Runtime completion is reported only after its process group has exited.
      await rm(home, { recursive: true, force: true });
      if (options.trustedObserver && (proc?.exitCode !== 0 || proc?.signalCode !== null || !candidateRuntime)) {
        throw new GatewayRuntimeCleanupError("OpenCode candidate observer cleanup is unconfirmed");
      }
    }
    if (options.requireExecutionFacts) {
      signal.throwIfAborted();
      if (!facts || !before || !after) throw new Error("OpenCode execution facts were not collected");
      return { ...facts, runtime: "opencode", startedAt, finishedAt: new Date().toISOString(), cleanup: { runtime: true, home: true },
        runtimeWitness: { before, after }, fullHistory: { ...facts.fullHistory,
          projectionSha256: createHash("sha256").update(canonicalJson(facts.messages)).digest("hex") },
        ...(candidateRuntime ? { candidateRuntime } : {}) };
    }
  };
}
