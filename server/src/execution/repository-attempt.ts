import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { prepareNativeRunArtifacts } from "../services/verrail-run-artifacts.js";
import { prepareRepositoryCheckout } from "./repository-checkout.js";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";

export interface RepositoryAttemptDependencies {
  checkoutRoot?: string;
  readSource(request: RepositoryExecutionRequest, signal: AbortSignal): Promise<Buffer>;
  revalidate(request: RepositoryExecutionRequest, signal: AbortSignal): Promise<void>;
  // Resolves only after the sandbox and all of its child processes have stopped.
  run(request: RepositoryExecutionRequest, cwd: string, signal: AbortSignal): Promise<{ exitCode: number }>;
  storage: Pick<StorageService, "putFile">;
}

export async function executeRepositoryAttempt(
  raw: RepositoryExecutionRequest,
  dependencies: RepositoryAttemptDependencies,
  cancellation: AbortSignal,
) {
  const request = repositoryExecutionRequestSchema.parse(raw);
  const deadline = new AbortController();
  const authority = new AbortController();
  const timer = setTimeout(() => deadline.abort(), request.timeoutSeconds * 1000);
  const signal = AbortSignal.any([cancellation, deadline.signal, authority.signal]);
  const check = () => signal.throwIfAborted();
  const revalidate = async () => { check(); await dependencies.revalidate(request, signal); check(); };
  let checkout: Awaited<ReturnType<typeof prepareRepositoryCheckout>> | undefined;
  try {
    await revalidate();
    const bundle = await dependencies.readSource(request, signal);
    check();
    checkout = await prepareRepositoryCheckout({ bundle, ...request.source, signal, checkoutRoot: dependencies.checkoutRoot });
    await revalidate();
    const monitorStop = new AbortController();
    const monitorSignal = AbortSignal.any([signal, monitorStop.signal]);
    const monitor = (async () => {
      try {
        while (!monitorSignal.aborted) {
          await delay(5000, undefined, { signal: monitorSignal });
          await dependencies.revalidate(request, monitorSignal);
        }
      } catch {
        if (!monitorSignal.aborted) authority.abort(new Error("REPOSITORY_LEASE_LOST"));
      }
    })();
    let result: { exitCode: number };
    try {
      result = await dependencies.run(request, checkout.cwd, signal);
    } finally {
      monitorStop.abort();
      await monitor;
    }
    check();
    if (result.exitCode !== 0) throw new Error("REPOSITORY_EXECUTION_FAILED");
    await revalidate();
    const prepared = await prepareNativeRunArtifacts({ cwd: checkout.cwd,
      workspaceId: request.workspaceId, runAttemptId: request.runAttemptId,
      limits: request.output, check });
    if (prepared.collectionStatus !== "collected") throw new Error("REPOSITORY_ARTIFACTS_REQUIRED");
    await revalidate();
    const artifacts = await prepared.upload({ putFile: async input => {
      await revalidate();
      const stored = await dependencies.storage.putFile(input);
      await revalidate();
      return stored;
    } });
    await revalidate();
    // The controller must register these against the still-current fenced Run.
    // Uploaded objects alone do not grant Run success or Target acceptance.
    return { runId: request.runId, runAttemptId: request.runAttemptId,
      leaseId: request.leaseId, fencingToken: request.fencingToken,
      source: request.source, artifacts };
  } finally {
    clearTimeout(timer);
    try {
      await checkout?.dispose();
    } catch (cause) {
      // Do not mask uncertain runtime cleanup with an ordinary filesystem error.
      throw new GatewayRuntimeCleanupError("Repository checkout cleanup is unconfirmed", { cause });
    }
  }
}
