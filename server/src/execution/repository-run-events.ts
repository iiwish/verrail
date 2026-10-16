import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest, type ReportRunEventInput } from "@paperclipai/shared";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { validateRepositoryResult } from "./repository-result.js";

export function createRepositoryRunReporter(options: {
  request: RepositoryExecutionRequest;
  lastEventCursor: number;
  domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
}) {
  const request = repositoryExecutionRequestSchema.parse(options.request);
  if (!Number.isSafeInteger(options.lastEventCursor) || options.lastEventCursor < 0) throw new Error("REPOSITORY_EVENT_CURSOR_INVALID");
  let cursor = options.lastEventCursor;
  let tail: Promise<void> = Promise.resolve();
  let uncertain = false;
  let textBytes = 0;
  const report = (event: Pick<ReportRunEventInput, "eventType" | "payload" | "artifacts" | "extendLeaseSeconds">, signal: AbortSignal) => {
    const operation = tail.then(async () => {
      if (uncertain) throw new Error("REPOSITORY_EVENT_STREAM_UNCERTAIN");
      signal.throwIfAborted();
      const next = cursor + 1;
      if (!Number.isSafeInteger(next)) throw new Error("REPOSITORY_EVENT_CURSOR_INVALID");
      const response = await options.domainApi.reportRunEvent({ workspaceId: request.workspaceId,
        signal,
        runId: request.runId, runAttemptId: request.runAttemptId,
        principalType: "service", principalId: "verrail-repository-runner",
        idempotencyKey: event.eventType === "terminated"
          ? `repository:${request.runAttemptId}:terminated:${next}` : `repository:${request.runAttemptId}:${next}`,
        input: { ...event, leaseId: request.leaseId, fencingToken: request.fencingToken,
          cursor: next, emittedAt: new Date().toISOString() },
      });
      if (!response.authoritative || response.runId !== request.runId || response.runAttemptId !== request.runAttemptId
        || response.cursor !== next || response.eventType !== event.eventType) throw new Error("REPOSITORY_EVENT_REJECTED");
      if (event.eventType === "succeeded" && (response.runStatus !== "succeeded"
        || response.attemptStatus !== "succeeded" || response.leaseStatus !== "released")) throw new Error("REPOSITORY_EVENT_REJECTED");
      if (event.eventType === "terminated" && (response.runStatus !== "canceled"
        || response.attemptStatus !== "canceled" || response.leaseStatus !== "released")) throw new Error("REPOSITORY_EVENT_REJECTED");
      cursor = next;
      signal.throwIfAborted();
      return response;
    });
    // An ambiguous write poisons this stream. Do not reuse its cursor or retry
    // a changed envelope; reconciliation must inspect authoritative Go state.
    tail = operation.then(() => {}, () => { uncertain = true; });
    return operation;
  };
  return {
    claim: (signal: AbortSignal) => report({ eventType: "claimed", payload: { runtimeProfile: "repository_sandbox" } }, signal),
    start: (signal: AbortSignal) => report({ eventType: "started", payload: { repositorySource: request.source } }, signal),
    renew: (signal: AbortSignal) => report({ eventType: "heartbeat", payload: {}, extendLeaseSeconds: 120 }, signal),
    progress: (text: string, signal: AbortSignal) => {
      textBytes += Buffer.byteLength(text);
      if (textBytes > 256 * 1024) return Promise.reject(new Error("REPOSITORY_OUTPUT_LIMIT"));
      return report({ eventType: "progress", payload: { text } }, signal);
    },
    succeed: (raw: unknown, signal: AbortSignal) => {
      const result = validateRepositoryResult(raw, request);
      return report({ eventType: "succeeded", payload: { repositoryOutput: result },
        artifacts: result.artifacts.map(({ title, kind, contentHash, contentRef }) => ({ title, kind, contentHash, contentRef })),
      }, signal);
    },
    fail: (signal: AbortSignal) => report({ eventType: "failed", payload: { errorCode: "REPOSITORY_EXECUTION_FAILED" } }, signal),
    terminate: (signal: AbortSignal) => report({ eventType: "terminated", payload: { cleanupConfirmed: true } }, signal),
  };
}
