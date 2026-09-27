import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { listPendingRepositoryCompletions, reconcileRepositoryCompletion } from "./repository-reconciliation.js";

export async function runRepositoryRecoveryWorker(options: {
  db: Db;
  domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
  workspaceIds: string[];
  signal: AbortSignal;
  intervalMs?: number;
  onCycle?: (result: { failed: boolean }) => void;
  onFailure: (failure: { workspaceId: string; runAttemptId?: string; code: "REPOSITORY_RECOVERY_SCAN_FAILED" | "REPOSITORY_RECOVERY_REGISTRATION_FAILED" }) => void;
}) {
  const workspaceIds = z.array(z.string().uuid()).min(1).max(100).parse(options.workspaceIds);
  if (new Set(workspaceIds).size !== workspaceIds.length) throw new Error("REPOSITORY_RECOVERY_DUPLICATE_WORKSPACE");
  const intervalMs = z.number().int().min(100).max(60_000).parse(options.intervalMs ?? 5_000);
  const cursors = new Map<string, string>();
  while (!options.signal.aborted) {
    let failed = false;
    // One bounded page per workspace keeps failures and large backlogs from
    // starving other workspaces. A completed scan starts again on the next tick.
    for (const workspaceId of workspaceIds) {
      if (options.signal.aborted) return;
      let records: Awaited<ReturnType<typeof listPendingRepositoryCompletions>>;
      try {
        records = await listPendingRepositoryCompletions({ db: options.db, workspaceId,
          after: cursors.get(workspaceId), limit: 20, signal: options.signal });
      } catch {
        if (options.signal.aborted) return;
        failed = true;
        options.onFailure({ workspaceId, code: "REPOSITORY_RECOVERY_SCAN_FAILED" });
        continue;
      }
      for (const { runAttemptId } of records) {
        if (options.signal.aborted) return;
        try {
          await reconcileRepositoryCompletion({ db: options.db, domainApi: options.domainApi,
            workspaceId, runAttemptId, signal: options.signal });
        } catch {
          if (options.signal.aborted) return;
          failed = true;
          options.onFailure({ workspaceId, runAttemptId, code: "REPOSITORY_RECOVERY_REGISTRATION_FAILED" });
        }
        cursors.set(workspaceId, runAttemptId);
      }
      if (records.length < 20) cursors.delete(workspaceId);
    }
    if (options.signal.aborted) return;
    options.onCycle?.({ failed });
    try {
      await delay(intervalMs, undefined, { signal: options.signal });
    } catch (error) {
      if (options.signal.aborted) return;
      throw error;
    }
  }
}
