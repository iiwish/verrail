import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { prepareNativeRunArtifacts } from "../services/verrail-run-artifacts.js";
import { prepareRepositoryCheckout } from "./repository-checkout.js";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";
import { captureSourceTree } from "../services/verrail-native-source.js";
import { finalizeRepositoryOutputReceipt, repositoryOutputArtifactSchema, repositoryRequestSha256, repositoryRuntimeFactsSchema,
  repositorySourceBindingSchema, repositorySourceObservation, type RepositoryRuntimeFacts, type RepositorySourceBinding } from "./repository-output-receipt.js";
import { persistRepositoryExecutionObservation, type RepositoryExecutionObservationInput } from "./repository-execution-observation.js";

export interface RepositoryAttemptDependencies {
  checkoutRoot?: string;
  readSource(request: RepositoryExecutionRequest, signal: AbortSignal): Promise<Buffer>;
  revalidate(request: RepositoryExecutionRequest, signal: AbortSignal): Promise<void>;
  // Resolves only after the sandbox and all of its child processes have stopped.
  run(request: RepositoryExecutionRequest, cwd: string, signal: AbortSignal): Promise<{
    exitCode: number; executionFacts?: RepositoryRuntimeFacts; executionObservation?: RepositoryExecutionObservationInput;
  }>;
  // Reads the server-owned Run source binding and verifies the provenance bytes.
  readSourceBinding?(request: RepositoryExecutionRequest, signal: AbortSignal): Promise<RepositorySourceBinding>;
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
  const dispose = async () => {
    const owned = checkout;
    checkout = undefined;
    try { await owned?.dispose(); } catch (cause) {
      throw new GatewayRuntimeCleanupError("Repository checkout cleanup is unconfirmed", { cause });
    }
  };
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
    let result: Awaited<ReturnType<RepositoryAttemptDependencies["run"]>>;
    try {
      result = await dependencies.run(request, checkout.cwd, signal);
    } finally {
      monitorStop.abort();
      await monitor;
    }
    check();
    if (result.exitCode !== 0) throw new Error("REPOSITORY_EXECUTION_FAILED");
    await revalidate();
    const sourceBefore = await captureSourceTree({ cwd: checkout.cwd, scopeVersion: 2 });
    check();
    const prepared = await prepareNativeRunArtifacts({ cwd: checkout.cwd,
      workspaceId: request.workspaceId, runAttemptId: request.runAttemptId,
      limits: request.output, sourceTree: sourceBefore, check });
    if (prepared.collectionStatus !== "collected") throw new Error("REPOSITORY_ARTIFACTS_REQUIRED");
    const sourceAfter = await captureSourceTree({ cwd: checkout.cwd, scopeVersion: 2 });
    check();
    let proof: { executionFacts: RepositoryRuntimeFacts; sourceBinding: RepositorySourceBinding } | undefined;
    if (prepared.hasSourceSnapshot) {
      if (sourceBefore.status !== "captured" || sourceAfter.status !== "captured"
        || JSON.stringify(sourceBefore.repository) !== JSON.stringify(sourceAfter.repository)
        || JSON.stringify(sourceBefore.manifest) !== JSON.stringify(sourceAfter.manifest)) throw new Error("REPOSITORY_OUTPUT_SOURCE_CHANGED");
      const executionFacts = repositoryRuntimeFactsSchema.parse(result.executionFacts);
      if (!dependencies.readSourceBinding) throw new Error("REPOSITORY_OUTPUT_SOURCE_BINDING_REQUIRED");
      proof = { executionFacts, sourceBinding: repositorySourceBindingSchema.parse(await dependencies.readSourceBinding(request, signal)) };
    }
    await revalidate();
    const artifacts = await prepared.upload({ putFile: async input => {
      await revalidate();
      const stored = await dependencies.storage.putFile(input);
      await revalidate();
      return stored;
    } });
    await revalidate();
    const executionObservation = proof && result.executionObservation ? await persistRepositoryExecutionObservation({
      request, execution: result.executionObservation, expected: proof.executionFacts,
      storage: dependencies.storage, revalidate,
    }) : undefined;
    // No trusted output receipt exists until the ephemeral checkout is gone.
    await dispose();
    await revalidate();
    const outputReceipt = proof ? finalizeRepositoryOutputReceipt({ schemaVersion: 1,
      kind: "verrail.repository-output-receipt", phase: "after_runtime_cleanup",
      identity: { workspaceId: request.workspaceId, targetId: request.targetId, targetRevisionId: request.targetRevisionId,
        graphRevisionId: request.graphRevisionId, workNodeId: request.workNodeId, runId: request.runId,
        runAttemptId: request.runAttemptId, leaseId: request.leaseId, fencingToken: request.fencingToken,
        agentVersionId: request.agentVersionId, deploymentRevisionId: request.deploymentRevisionId },
      requestSha256: repositoryRequestSha256(request), inputSource: request.source, sourceBinding: proof.sourceBinding,
      executionFacts: { ...proof.executionFacts, requestSha256: repositoryRequestSha256(request), exitCode: 0,
        cleanup: { ...proof.executionFacts.cleanup, checkout: true } },
      sourceBefore: repositorySourceObservation(sourceBefore, "before_collection"),
      sourceAfter: repositorySourceObservation(sourceAfter, "after_collection"), sourceStatus: "stable", collectionStatus: "collected",
      artifacts: artifacts.map(artifact => repositoryOutputArtifactSchema.parse(artifact)), finalizedAt: new Date().toISOString(),
      ...(executionObservation ? { executionObservation } : {}),
    }, request) : undefined;
    // The controller must register these against the still-current fenced Run.
    // Uploaded objects alone do not grant Run success or Target acceptance.
    return { runId: request.runId, runAttemptId: request.runAttemptId,
      leaseId: request.leaseId, fencingToken: request.fencingToken,
      source: request.source, artifacts, ...(outputReceipt ? { outputReceipt } : {}) };
  } finally {
    clearTimeout(timer);
    await dispose();
  }
}
