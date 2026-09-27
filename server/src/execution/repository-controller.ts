import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "@paperclipai/db";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { createRepositoryDispatchStore } from "./repository-dispatch.js";
import { createRepositorySourceReader } from "./repository-source.js";
import { createOpenCodeRepositoryRuntime } from "./opencode-repository-runtime.js";
import { executeRepositoryAttempt } from "./repository-attempt.js";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";
import type { RepositoryCommandRunner } from "./repository-container-command.js";

export function createRepositoryExecutionController(options: {
  db: Db; storage: StorageService; controllerId: string;
  command?: string; version: string; launcher?: string; providers: Record<string, unknown>;
  runCommand?: RepositoryCommandRunner;
  checkoutRoot?: string;
  // Must use the Go event protocol, not direct Run/Lease updates.
  renewRun(request: RepositoryExecutionRequest, signal: AbortSignal): Promise<void>;
  emit(request: RepositoryExecutionRequest, text: string, signal: AbortSignal): Promise<void>;
  onAuthority?: () => void;
}) {
  const store = createRepositoryDispatchStore(options.db, options.controllerId);
  const readSource = createRepositorySourceReader(options.db, options.storage);
  // Inputs must already be selected by the trusted scheduler and have a started
  // Go Attempt. This internal entry point is not a browser or model command.
  return async (raw: RepositoryExecutionRequest, cancellation: AbortSignal) => {
    const request = repositoryExecutionRequestSchema.parse(raw);
    const lifetime = new AbortController();
    const signal = AbortSignal.any([cancellation, lifetime.signal]);
    signal.throwIfAborted();
    if (!await store.claim(request, signal)) return { status: "already_dispatched" as const };
    options.onAuthority?.();
    const timer = setTimeout(() => lifetime.abort(new Error("REPOSITORY_DEADLINE")), request.timeoutSeconds * 1000);
    const monitorStop = new AbortController();
    const monitorSignal = AbortSignal.any([signal, monitorStop.signal]);
    const monitor = (async () => {
      try {
        while (!monitorSignal.aborted) {
          await delay(20_000, undefined, { signal: monitorSignal });
          await options.renewRun(request, monitorSignal);
          await store.renew(request, monitorSignal);
          options.onAuthority?.();
        }
      } catch {
        if (!monitorSignal.aborted) lifetime.abort(new Error("REPOSITORY_RENEWAL_FAILED"));
      }
    })();
    try {
      let outputBytes = 0;
      const run = createOpenCodeRepositoryRuntime({ command: options.command, version: options.version,
        launcher: options.launcher, runCommand: options.runCommand, providers: options.providers,
        authorize: (input, currentSignal) => store.authorize(input, currentSignal),
        consumeToolCall: input => store.consumeToolCall(input, signal),
        emit: async (input, text) => {
          outputBytes += Buffer.byteLength(text);
          if (outputBytes > 256 * 1024) throw new Error("REPOSITORY_OUTPUT_LIMIT");
          await store.authorize(input, signal);
          await options.emit(input, text, signal);
          signal.throwIfAborted();
        },
      });
      const result = await executeRepositoryAttempt(request, { readSource,
        revalidate: store.authorize, run, storage: options.storage, checkoutRoot: options.checkoutRoot }, signal);
      await store.finishSucceeded(request, result, signal);
      return { status: "succeeded" as const, result };
    } catch (error) {
      // A failed cleanup cannot mint a receipt, even if cancellation was requested.
      if (error instanceof GatewayRuntimeCleanupError) throw error;
      monitorStop.abort();
      await monitor;
      if (await store.finishCancellation(request, AbortSignal.timeout(5000))) {
        return { status: "canceled" as const };
      }
      try {
        await store.finishFailure(request, "failed", AbortSignal.timeout(5000));
      } catch (persistenceError) {
        throw new AggregateError([error, persistenceError], "REPOSITORY_FAILURE_PERSISTENCE_FAILED");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      monitorStop.abort();
      await monitor;
      lifetime.abort();
    }
  };
}
