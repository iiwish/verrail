import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, verrailRunAttempts } from "@paperclipai/db";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { listOfferedRepositoryAttempts } from "./repository-offers.js";
import { buildOfferedRepositoryRequest } from "./repository-request-builder.js";
import { startOfferedRepositoryAttempt } from "./repository-start.js";

export async function runRepositoryDispatchWorker(options: {
  db: Db; storage: Pick<StorageService, "getObject">; domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
  workspaceIds: string[]; signal: AbortSignal; intervalMs?: number;
  execute: (request: RepositoryExecutionRequest, cursor: number, signal: AbortSignal) => Promise<unknown>;
  onActive?: (active: boolean) => void;
  onCycle?: (result: { failed: boolean }) => void;
  onFailure: (value: { workspaceId: string; runAttemptId?: string; code: "REPOSITORY_SCAN_FAILED" | "REPOSITORY_DISPATCH_FAILED" }) => void;
}) {
  const workspaces = z.array(z.string().uuid()).min(1).max(100).parse(options.workspaceIds);
  if (new Set(workspaces).size !== workspaces.length) throw new Error("REPOSITORY_DUPLICATE_WORKSPACE");
  const interval = z.number().int().min(100).max(60000).parse(options.intervalMs ?? 5000);
  const cursors = new Map<string, string>();
  while (!options.signal.aborted) {
    let scanFailed = false;
    for (const workspaceId of workspaces) {
      if (options.signal.aborted) return;
      let offers: Awaited<ReturnType<typeof listOfferedRepositoryAttempts>>;
      try {
        offers = await listOfferedRepositoryAttempts({ db: options.db, workspaceId, after: cursors.get(workspaceId), limit: 1, signal: options.signal });
      } catch {
        if (options.signal.aborted) return;
        scanFailed = true;
        options.onFailure({ workspaceId, code: "REPOSITORY_SCAN_FAILED" });
        continue;
      }
      if (!offers.length) { cursors.delete(workspaceId); continue; }
      const offer = offers[0];
      cursors.set(workspaceId, offer.runAttemptId);
      options.onActive?.(true);
      try {
        const request = await buildOfferedRepositoryRequest({ db: options.db, storage: options.storage,
          identity: { workspaceId, ...offer }, signal: options.signal, timeoutSeconds: 900,
          output: { maxFiles: 10, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 } });
        options.signal.throwIfAborted();
        const [attempt] = await options.db.select({ cursor: verrailRunAttempts.lastEventCursor }).from(verrailRunAttempts)
          .where(and(eq(verrailRunAttempts.id, offer.runAttemptId), eq(verrailRunAttempts.runId, offer.runId),
            eq(verrailRunAttempts.workspaceId, workspaceId))).limit(1);
        if (!attempt) throw new Error("REPOSITORY_ATTEMPT_NOT_FOUND");
        options.signal.throwIfAborted();
        const cursor = await startOfferedRepositoryAttempt({ db: options.db, domainApi: options.domainApi,
          request, lastEventCursor: attempt.cursor, signal: options.signal });
        options.signal.throwIfAborted();
        await options.execute(request, cursor, options.signal);
      } catch {
        if (options.signal.aborted) return;
        options.onFailure({ workspaceId, runAttemptId: offer.runAttemptId, code: "REPOSITORY_DISPATCH_FAILED" });
      } finally {
        options.onActive?.(false);
      }
    }
    if (options.signal.aborted) return;
    options.onCycle?.({ failed: scanFailed });
    try { await delay(interval, undefined, { signal: options.signal }); } catch (error) {
      if (options.signal.aborted) return;
      throw error;
    }
  }
}
