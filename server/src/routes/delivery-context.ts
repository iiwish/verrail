import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, tooManyRequests } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { channelTargetProofContextInputSchema, loadChannelTargetProofContext } from "../services/channel-target-proof-context.js";
import { codexExecutionProofContextInputSchema, loadCodexExecutionProofContext } from "../services/codex-execution-proof-context.js";
import { getRunLogStore, type RunLogStore } from "../services/run-log-store.js";

/** Authenticated inspection only; these endpoints cannot admit a proof. */
export function deliveryContextRoutes(db: Db, options: {
  channel?: typeof loadChannelTargetProofContext;
  codex?: typeof loadCodexExecutionProofContext;
  logs?: Pick<RunLogStore, "read">;
} = {}) {
  const router = Router();
  const active = new Set<string>();
  router.get("/workspaces/:workspaceId/delivery-context/channel", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const parsed = channelTargetProofContextInputSchema.omit({ workspaceId: true }).safeParse(req.query);
    if (!parsed.success || !channelTargetProofContextInputSchema.shape.workspaceId.safeParse(workspaceId).success) throw badRequest("Invalid channel context references");
    res.set("Cache-Control", "no-store").json(await (options.channel ?? loadChannelTargetProofContext)(db, { ...parsed.data, workspaceId }));
  });
  router.get("/workspaces/:workspaceId/delivery-context/codex", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const parsed = codexExecutionProofContextInputSchema.omit({ workspaceId: true }).safeParse(req.query);
    if (!parsed.success || !codexExecutionProofContextInputSchema.shape.workspaceId.safeParse(workspaceId).success
      || Boolean(parsed.data.artifactRevisionId) !== Boolean(parsed.data.fixedCiProofId)) throw badRequest("Invalid execution context references");
    const key = `${workspaceId}:${parsed.data.runId}`;
    if (active.size >= 2 || active.has(key)) throw tooManyRequests("Execution context read is already in progress");
    active.add(key);
    try {
      res.set("Cache-Control", "no-store").json(await (options.codex ?? loadCodexExecutionProofContext)(db,
        { ...parsed.data, workspaceId }, { logs: options.logs ?? getRunLogStore() }));
    } finally { active.delete(key); }
  });
  return router;
}
