import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { nativeRunArtifactDirectory } from "../services/verrail-run-artifacts.js";
import { createOpenCodeToolRuntime } from "./opencode-runtime.js";
import { createRepositoryMcp } from "./repository-mcp.js";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";
import type { RepositoryCommandRunner } from "./repository-container-command.js";

export function createOpenCodeRepositoryRuntime(options: {
  command?: string; version: string; launcher?: string; providers: Record<string, unknown>;
  runCommand?: RepositoryCommandRunner;
  authorize(request: RepositoryExecutionRequest, signal: AbortSignal): Promise<void>;
  consumeToolCall(request: RepositoryExecutionRequest): Promise<void>;
  emit(request: RepositoryExecutionRequest, text: string): Promise<void>;
}) {
  return async (request: RepositoryExecutionRequest, cwd: string, cancellation: AbortSignal) => {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([cancellation, lifetime.signal, AbortSignal.timeout(request.timeoutSeconds * 1000)]);
    signal.throwIfAborted();
    const secret = `Bearer ${randomBytes(32).toString("hex")}`;
    let cleanupUncertain = false;
    const handler = createRepositoryMcp({ launcher: options.launcher, runCommand: options.runCommand, cwd, signal,
      authorize: () => options.authorize(request, signal),
      consumeToolCall: () => options.consumeToolCall(request),
      invalidate: error => {
        cleanupUncertain ||= error.message === "REPOSITORY_COMMAND_CLEANUP_FAILED";
        lifetime.abort(new Error("REPOSITORY_RUNTIME_INVALIDATED"));
      },
    });
    const pending = new Set<Promise<void>>();
    const server = createServer((req, res) => {
      const task = (async () => {
        const header = req.headers.authorization ?? "";
        if (Buffer.byteLength(header) !== Buffer.byteLength(secret)
          || !timingSafeEqual(Buffer.from(header), Buffer.from(secret))) { res.writeHead(401).end(); return; }
        if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(405).end(); return; }
        try {
          req.setTimeout(5000, () => req.destroy());
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 100_000) { res.writeHead(413).end(); req.destroy(); return; }
            chunks.push(Buffer.from(chunk));
          }
          req.setTimeout(0);
          const response = await handler(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (response === null) { res.writeHead(202).end(); return; }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch { if (!res.headersSent) res.writeHead(403); res.end(); }
      })();
      pending.add(task);
      void task.then(() => pending.delete(task), () => {
        pending.delete(task);
        lifetime.abort(new Error("REPOSITORY_MCP_FAILED"));
        res.destroy();
      });
    });
    server.headersTimeout = 5000;
    server.maxConnections = 8;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      const runtime = createOpenCodeToolRuntime({ command: options.command, version: options.version,
        executionTimeoutMs: request.timeoutSeconds * 1000,
        providers: options.providers, tools: ["repository_execute_command"],
        mcp: () => ({ repository: { type: "remote", url, oauth: false, headers: { Authorization: secret } } }),
      });
      await runtime({ model: request.model, systemPrompt: "Use only the repository tool to complete the assigned work. Execution success does not grant approval or acceptance.",
        prompt: `${request.instructions}\n\nWrite deliverables and a manifest to ${nativeRunArtifactDirectory(request.runAttemptId)}.\n`
          + 'Manifest: {"schemaVersion":1,"artifacts":[{"title":"Changes","kind":"code_change","path":"changes.patch"}]}. '
          + "Paths must be simple filenames next to the manifest. Repository commands are offline; do not push, merge or perform external actions.",
      }, { signal, emit: text => options.emit(request, text) });
      signal.throwIfAborted();
      return { exitCode: 0 };
    } finally {
      lifetime.abort();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled([...pending]);
      if (cleanupUncertain) throw new GatewayRuntimeCleanupError("Repository command cleanup is unconfirmed");
    }
  };
}
