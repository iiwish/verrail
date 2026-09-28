import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import { verrailRepositoryDispatches as dispatches, verrailRunAttempts as attempts, verrailRuns as runs, type Db } from "@paperclipai/db";
import { repositoryExecutionRequestSchema } from "@paperclipai/shared";
import { z } from "zod";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { validateRepositoryResult } from "./repository-result.js";
import { createRepositoryLeaseValidator } from "./repository-lease.js";
import { createRepositoryRunReporter } from "./repository-run-events.js";

export async function listPendingRepositorySuccesses(options: {
  db: Db; workspaceId: string; after?: string; limit?: number; signal: AbortSignal;
}) {
  return listPendingRepositoryCompletions(options, "succeeded");
}

export async function listPendingRepositoryCompletions(options: {
  db: Db; workspaceId: string; after?: string; limit?: number; signal: AbortSignal;
}, expectedStatus?: "succeeded") {
  const workspaceId = z.string().uuid().parse(options.workspaceId);
  const after = z.string().uuid().optional().parse(options.after);
  const limit = z.number().int().min(1).max(100).parse(options.limit ?? 20);
  options.signal.throwIfAborted();
  // Keyset pagination advances past a rejected receipt without changing its facts.
  const records = await options.db.select({ runAttemptId: dispatches.runAttemptId })
    .from(dispatches)
    .innerJoin(attempts, and(eq(attempts.id, dispatches.runAttemptId), eq(attempts.workspaceId, dispatches.workspaceId), eq(attempts.runId, dispatches.runId)))
    .innerJoin(runs, and(eq(runs.id, dispatches.runId), eq(runs.workspaceId, dispatches.workspaceId)))
    .where(and(eq(dispatches.workspaceId, workspaceId), expectedStatus ? eq(dispatches.status, expectedStatus) : undefined, or(
      and(eq(dispatches.status, "succeeded"), eq(attempts.status, "running"), eq(runs.status, "running")),
      and(eq(dispatches.status, "canceled"), inArray(attempts.status, ["cancel_requested", "cancel_acknowledged"]), eq(runs.status, "cancel_requested")),
    ), after ? gt(dispatches.runAttemptId, after) : undefined))
    .orderBy(asc(dispatches.runAttemptId)).limit(limit);
  options.signal.throwIfAborted();
  return records;
}

export async function reconcileSucceededRepositoryRun(options: {
  db: Db; domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
  workspaceId: string; runAttemptId: string; signal: AbortSignal;
}) {
  return reconcileRepositoryCompletion(options, "succeeded");
}

export async function reconcileRepositoryCompletion(options: {
  db: Db; domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
  workspaceId: string; runAttemptId: string; signal: AbortSignal;
}, expectedStatus?: "succeeded" | "canceled") {
  const workspaceId = z.string().uuid().parse(options.workspaceId);
  const runAttemptId = z.string().uuid().parse(options.runAttemptId);
  options.signal.throwIfAborted();
  const [record] = await options.db.select({ input: dispatches.input, requestHash: dispatches.requestHash, status: dispatches.status,
    result: dispatches.result, runId: runs.id, runStatus: runs.status, attemptStatus: attempts.status,
    attemptResult: attempts.result, cursor: attempts.lastEventCursor })
    .from(dispatches)
    .innerJoin(attempts, and(eq(attempts.id, dispatches.runAttemptId), eq(attempts.workspaceId, dispatches.workspaceId), eq(attempts.runId, dispatches.runId)))
    .innerJoin(runs, and(eq(runs.id, dispatches.runId), eq(runs.workspaceId, dispatches.workspaceId)))
    .where(and(eq(dispatches.workspaceId, workspaceId), eq(dispatches.runAttemptId, runAttemptId),
      expectedStatus ? eq(dispatches.status, expectedStatus) : inArray(dispatches.status, ["succeeded", "canceled"]))).limit(1);
  options.signal.throwIfAborted();
  if (!record) return { status: "not_ready" as const };
  const request = repositoryExecutionRequestSchema.parse(record.input);
  if (request.workspaceId !== workspaceId || request.runAttemptId !== runAttemptId || request.runId !== record.runId
    || createHash("sha256").update(JSON.stringify(request)).digest("hex") !== record.requestHash) {
    throw new Error("REPOSITORY_DISPATCH_IDENTITY_INVALID");
  }
  if (record.status === "canceled") {
    if (record.runStatus === "canceled" && record.attemptStatus === "canceled") return { status: "registered" as const };
    if (record.runStatus !== "cancel_requested" || !["cancel_requested", "cancel_acknowledged"].includes(record.attemptStatus)) {
      return { status: "inactive" as const };
    }
    // The owned dispatch records completed cleanup. Go rechecks the current
    // Attempt, fence, cancellation and live lease in its terminal transaction.
    const reporter = createRepositoryRunReporter({ request, lastEventCursor: record.cursor, domainApi: options.domainApi });
    await reporter.terminate(options.signal);
    return { status: "registered" as const };
  }
  const result = validateRepositoryResult(record.result, request);
  if (record.runStatus === "succeeded" && record.attemptStatus === "succeeded") {
    const registered = validateRepositoryResult(record.attemptResult?.repositoryOutput, request);
    if (JSON.stringify(registered) !== JSON.stringify(result)) throw new Error("REPOSITORY_RESULT_CONFLICT");
    return { status: "registered" as const };
  }
  if (record.runStatus !== "running" || record.attemptStatus !== "running") return { status: "inactive" as const };
  await createRepositoryLeaseValidator(options.db)(request, options.signal);
  const reporter = createRepositoryRunReporter({ request, lastEventCursor: record.cursor, domainApi: options.domainApi });
  // This path has no harness access. Go's cursor/idempotency/lease transaction
  // remains authoritative if two reconcilers race or cancellation arrives.
  await reporter.succeed(result, options.signal);
  return { status: "registered" as const };
}
