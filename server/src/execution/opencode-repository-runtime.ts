import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { repositoryExecutionIdentitySchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import { nativeRunArtifactDirectory } from "../services/verrail-run-artifacts.js";
import { createOpenCodeToolRuntime, type OpenCodeRuntimeFacts } from "./opencode-runtime.js";
import { createRepositoryMcp } from "./repository-mcp.js";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";
import type { RepositoryCommandRunner } from "./repository-container-command.js";
import { repositoryRuntimeFactsSchema, type RepositoryRuntimeFacts } from "./repository-output-receipt.js";

export function createOpenCodeRepositoryRuntime(options: {
  command?: string; version: string; launcher?: string; providers: Record<string, unknown>;
  trustedObserver?: Omit<NonNullable<Parameters<typeof createOpenCodeToolRuntime>[0]["trustedObserver"]>, "identity">;
  runCommand?: RepositoryCommandRunner;
  authorize(request: RepositoryExecutionRequest, signal: AbortSignal): Promise<void>;
  consumeToolCall(request: RepositoryExecutionRequest): Promise<void>;
  emit(request: RepositoryExecutionRequest, text: string): Promise<void>;
}) {
  return async (request: RepositoryExecutionRequest, cwd: string, cancellation: AbortSignal) => {
    const lifetime = new AbortController();
    const deadline = AbortSignal.timeout(request.timeoutSeconds * 1000);
    const signal = AbortSignal.any([cancellation, lifetime.signal, deadline]);
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
    let executionFacts: RepositoryRuntimeFacts | undefined;
    let observation: OpenCodeRuntimeFacts | undefined;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      const runtime = createOpenCodeToolRuntime({ command: options.command, version: options.version,
        executionTimeoutMs: request.timeoutSeconds * 1000, requireExecutionFacts: true,
        providers: options.providers, tools: ["repository_execute_command"],
        ...(options.trustedObserver ? { trustedObserver: { ...options.trustedObserver,
          identity: () => repositoryExecutionIdentitySchema.strip().parse(request) } } : {}),
        mcp: () => ({ repository: { type: "remote", url, oauth: false, headers: { Authorization: secret } } }),
      });
      const observed = await runtime({ model: request.model, systemPrompt: "Use only the repository tool to complete the assigned work. Execution success does not grant approval or acceptance.",
        prompt: `${request.instructions}\n\nWrite deliverables and a manifest to ${nativeRunArtifactDirectory(request.runAttemptId)}.\n`
          + 'Manifest: {"schemaVersion":1,"artifacts":[{"title":"Changes","kind":"code_change","path":"changes.patch"}]}. '
          + 'For a trusted source bundle, explicitly use {"schemaVersion":2,"artifacts":[{"type":"source_snapshot","title":"Source","format":"git_bundle","scopeVersion":2}]}; the controller generates the bundle from frozen source bytes. '
          + "Paths must be simple filenames next to the manifest. Repository commands are offline; do not push, merge or perform external actions.",
      }, { signal, emit: text => options.emit(request, text) });
      signal.throwIfAborted();
      if (!observed || observed.model !== request.model || (options.trustedObserver && !observed.candidateRuntime)) {
        throw new Error("REPOSITORY_RUNTIME_FACTS_REQUIRED");
      }
      observation = observed;
      executionFacts = repositoryRuntimeFactsSchema.parse({ runtime: observed.runtime, runtimeVersion: observed.runtimeVersion,
        model: observed.model, startedAt: observed.startedAt, finishedAt: observed.finishedAt,
        cleanup: { runtime: observed.cleanup.runtime, home: observed.cleanup.home, commands: true } });
    } finally {
      lifetime.abort();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled([...pending]);
      if (cleanupUncertain) throw new GatewayRuntimeCleanupError("Repository command cleanup is unconfirmed");
    }
    AbortSignal.any([cancellation, deadline]).throwIfAborted();
    if (!executionFacts) throw new Error("REPOSITORY_RUNTIME_FACTS_REQUIRED");
    const finishedAt = new Date().toISOString();
    const finalFacts = { ...executionFacts, finishedAt };
    return { exitCode: 0, executionFacts: finalFacts,
      ...(observation?.fullHistoryBody ? { executionObservation: { fullHistoryBody: observation.fullHistoryBody, facts: {
        ...finalFacts, providerId: observation.providerId, modelId: observation.modelId, sessionId: observation.sessionId,
        messageId: observation.messageId, sessionCreatedAt: observation.sessionCreatedAt, healthVerifiedAt: observation.healthVerifiedAt,
        messages: observation.messages, fullHistory: observation.fullHistory, runtimeWitness: observation.runtimeWitness,
        ...(observation.candidateRuntime ? { candidateRuntime: observation.candidateRuntime } : {}),
        usageStatus: observation.usageStatus, usageScope: observation.usageScope, usage: observation.usage,
        costStatus: observation.costStatus, costBasis: observation.costBasis, reportedCostUsd: observation.reportedCostUsd,
      } } } : {}),
    };
  };
}
