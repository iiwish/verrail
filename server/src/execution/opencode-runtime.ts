import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenCodeHttpClient } from "@paperclipai/adapter-opencode-local/http-client";
import { DIRECTOR_GATEWAY_TOOL_NAMES } from "@paperclipai/shared";
import { GatewayRuntimeCleanupError, type GatewayRuntime } from "./gateway-store.js";

export function createOpenCodeGatewayRuntime(options: {
  command?: string;
  version: string;
  controlPlaneUrl: string;
  providers: Record<string, unknown>;
}): GatewayRuntime {
  const callback = new URL("/api/director/mcp", options.controlPlaneUrl);
  if (!["http:", "https:"].includes(callback.protocol) || callback.username || callback.password) throw new Error("Invalid control plane URL");
  return createOpenCodeToolRuntime({ ...options, tools: DIRECTOR_GATEWAY_TOOL_NAMES.map(name => `director_${name}`),
    mcp: (input: Parameters<GatewayRuntime>[0]) => ({ director: { type: "remote", url: callback.href,
      oauth: false, headers: { "X-Verrail-Chat-Token": input.directorToken } } }),
  });
}

type OpenCodePrompt = { model: string; systemPrompt: string; prompt: string };
type RuntimeControl = { signal: AbortSignal; emit: (text: string) => Promise<void> };

// Tool configuration is provided by trusted runtime wiring, never model input.
export function createOpenCodeToolRuntime<T extends OpenCodePrompt>(options: {
  command?: string;
  version: string;
  providers: Record<string, unknown>;
  tools: readonly string[];
  executionTimeoutMs?: number;
  mcp: (input: T) => Record<string, unknown>;
}): (input: T, control: RuntimeControl) => Promise<void> {
  if (!options.tools.length || options.tools.some(name => !/^[a-z][a-z0-9_]+$/.test(name))) throw new Error("Invalid runtime tool allowlist");
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error("Pin an exact OpenCode version");
  return async (input, { signal, emit }) => {
    if (signal.aborted) return;
    const provider = input.model.slice(0, input.model.indexOf("/"));
    if (!Object.hasOwn(options.providers, provider)) throw new Error("Model provider is not configured");
    const home = await mkdtemp(join(tmpdir(), "verrail-opencode-invocation-"));
    const reservation = createServer();
    let proc: ReturnType<typeof spawn> | undefined;
    let closed: Promise<void> | undefined;
    let spawnedError: Error | undefined;
    let stream: Awaited<ReturnType<ReturnType<typeof createOpenCodeHttpClient>["subscribeText"]>> | undefined;
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
      proc = spawn(options.command ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: home, detached: process.platform !== "win32", stdio: "ignore",
        env: {
          PATH: process.env.PATH, HOME: home,
          XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
          OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        },
      });
      proc.on("error", error => { spawnedError = error; });
      closed = new Promise(resolve => proc!.once("close", () => resolve()));
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
    } finally {
      stream?.close();
      await stream?.done.catch(() => {});
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
      // Runtime completion is reported only after its process group has exited.
      await rm(home, { recursive: true, force: true });
    }
  };
}
