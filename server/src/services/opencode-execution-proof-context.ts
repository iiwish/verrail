import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Db, verrailRepositoryDispatches } from "@paperclipai/db";
import { opencodeExecutionObservationSchema, repositoryExecutionRequestSchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { validateRepositoryExecutionObservation } from "../execution/repository-execution-observation.js";
import { validateRepositoryResult } from "../execution/repository-result.js";
import { repositoryRequestSha256 } from "../execution/repository-output-receipt.js";
import { conflict } from "../errors.js";
import type { GitHubCiSourceContextInput } from "./github-ci-source-context.js";
import { loadRepositoryCiSourceContext, type RepositoryCiSourceOptions } from "./github-ci-repository-source-context.js";
import { readExecutionProofObject } from "./delivery-proof-storage-reader.js";

function unavailable(): never { throw conflict("OpenCode execution proof context unavailable or changed"); }

/** The caller separately checks the active criterion and independently observed candidate runtime. */
export async function loadOpenCodeExecutionProofContext(db: Db,
  input: GitHubCiSourceContextInput & { runId: string; runAttemptId: string }, options: RepositoryCiSourceOptions) {
  return db.transaction(async tx => {
    const source = await loadRepositoryCiSourceContext(tx, input, options);
    if (source.source.runId !== input.runId || source.source.runAttemptId !== input.runAttemptId) unavailable();
    const dispatches = await tx.select().from(verrailRepositoryDispatches).where(and(
      eq(verrailRepositoryDispatches.workspaceId, input.workspaceId), eq(verrailRepositoryDispatches.runId, input.runId),
      eq(verrailRepositoryDispatches.runAttemptId, input.runAttemptId), eq(verrailRepositoryDispatches.status, "succeeded"))).limit(2);
    const dispatch = dispatches[0];
    if (dispatches.length !== 1 || !dispatch || dispatch.errorCode || !dispatch.finishedAt) unavailable();
    try {
      const request = repositoryExecutionRequestSchema.parse(dispatch.input);
      const result = validateRepositoryResult(dispatch.result, request), receipt = result.outputReceipt;
      if (!receipt?.executionObservation || receipt.sha256 !== source.source.outputReceiptSha256
        || repositoryRequestSha256(request) !== dispatch.requestHash || request.leaseId !== dispatch.leaseId
        || request.fencingToken !== dispatch.fencingToken || request.runId !== input.runId
        || request.runAttemptId !== input.runAttemptId || request.workspaceId !== input.workspaceId) unavailable();
      const encoded = await readExecutionProofObject(options.storage, input.workspaceId, receipt.executionObservation, "repository-execution-observations");
      const parsed = opencodeExecutionObservationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)));
      const log = await readExecutionProofObject(options.storage, input.workspaceId, parsed.log, "repository-execution-logs");
      const execution = receipt.executionFacts;
      const observed = validateRepositoryExecutionObservation(parsed, log, request, {
        runtime: execution.runtime, runtimeVersion: execution.runtimeVersion, model: execution.model,
        startedAt: execution.startedAt, finishedAt: execution.finishedAt,
        cleanup: { runtime: execution.cleanup.runtime, commands: execution.cleanup.commands, home: execution.cleanup.home },
      });
      const facts = observed.facts;
      if (!facts.candidateRuntime || facts.usageStatus !== "complete" || !facts.usage || Date.parse(observed.recordedAt) > Date.parse(receipt.finalizedAt)
        || Date.parse(facts.finishedAt) > Date.parse(receipt.sourceBefore.observedAt)) unavailable();
      const context = { ...observed.identity, requestSha256: receipt.requestSha256, outputReceiptSha256: receipt.sha256,
        runEventId: source.source.runEventId, executionObservation: receipt.executionObservation, logRef: observed.log,
        executionWindow: { startedAt: facts.startedAt, finishedAt: facts.finishedAt }, runtime: facts.runtime,
        runtimeVersion: facts.runtimeVersion, model: facts.model, providerId: facts.providerId, modelId: facts.modelId,
        sessionId: facts.sessionId, messageId: facts.messageId, sessionCreatedAt: facts.sessionCreatedAt,
        healthVerifiedAt: facts.healthVerifiedAt, sessionCompletedAt: facts.messages.at(-1)!.completedAt!,
        fullHistory: facts.fullHistory, runtimeWitness: facts.runtimeWitness, candidateRuntime: facts.candidateRuntime,
        usageStatus: facts.usageStatus, usageScope: facts.usageScope, usage: facts.usage,
        costStatus: facts.costStatus, costBasis: facts.costBasis, reportedCostUsd: facts.reportedCostUsd,
        cleanup: receipt.executionFacts.cleanup };
      return { source, execution: { ...context, contextSha256: createHash("sha256").update(canonicalJson({
        sourceContextSha256: source.contextSha256, context, observationSha256: receipt.executionObservation.contentHash,
      })).digest("hex") } };
    } catch { return unavailable(); }
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export type OpenCodeExecutionProofContext = Awaited<ReturnType<typeof loadOpenCodeExecutionProofContext>>["execution"];
