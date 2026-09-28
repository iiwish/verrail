import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { DIRECTOR_INSTRUCTIONS_CONFIG_KEY, startConversationInvocationSchema, type ConversationInvocationView } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { readEffectiveAgentVersion } from "../services/agent-effective-version.js";
import { buildDirectorInstructions } from "../services/director-instructions.js";
import { conversationInvocationService } from "../services/conversation-invocations.js";
import type { createConversationInvocationController } from "../services/conversation-invocation-controller.js";

export function conversationInvocationView(row: Awaited<ReturnType<ReturnType<typeof conversationInvocationService>["claim"]>>): ConversationInvocationView {
  return {
    id: row.id, workspaceId: row.workspaceId, conversationId: row.conversationId, sourceMessageId: row.sourceMessageId,
    principalId: row.principalId, agentVersionId: row.agentVersionId, deploymentRevisionId: row.deploymentRevisionId,
    status: row.status as ConversationInvocationView["status"], lastEventCursor: row.lastEventCursor, output: row.output, errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function conversationInvocationRoutes(db: Db, controller: ReturnType<typeof createConversationInvocationController>) {
  const router = Router();
  const service = conversationInvocationService(db);
  const scope = (req: Parameters<typeof assertBoard>[0]) => {
    assertBoard(req);
    const workspaceId = z.string().uuid().parse(req.params.workspaceId);
    const conversationId = z.string().uuid().parse(req.params.conversationId);
    assertCompanyAccess(req, workspaceId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") throw new HttpError(403, "User session required");
    return { workspaceId, conversationId, principalId: actor.actorId };
  };
  router.post("/workspaces/:workspaceId/conversations/:conversationId/invocations", async (req, res) => {
    const identity = scope(req);
    const input = startConversationInvocationSchema.parse(req.body);
    const replay = await service.replay(identity, input);
    if (replay) {
      controller.start();
      res.json({ invocation: conversationInvocationView(replay), replayed: true });
      return;
    }
    const { agent } = await builtInAgentService(db).get(identity.workspaceId, "director");
    if (!agent || agent.pausedAt || ["paused", "terminated", "pending_approval"].includes(agent.status)) throw new HttpError(409, "Director unavailable");
    const effective = await readEffectiveAgentVersion(db, identity.workspaceId, agent.id);
    if (effective.version.runtime !== "opencode" || effective.version.supplyChain.mode !== "director_chat") throw new HttpError(409, "Activate an OpenCode Director version");
    const instructions = buildDirectorInstructions({
      agentName: agent.name, runtime: "opencode", available: true, toolsAvailable: true,
      adapterConfig: { [DIRECTOR_INSTRUCTIONS_CONFIG_KEY]: { schemaVersion: 1, revision: effective.version.versionNumber, rolePrompt: effective.version.prompt, appliedAt: effective.revision.createdAt.toISOString(), appliedByUserId: effective.revision.createdByPrincipalId } },
    });
    const result = await service.begin(identity, input, { agentVersionId: effective.version.id, deploymentRevisionId: effective.revision.id, assistantAgentId: agent.id, runtime: "opencode", model: effective.version.model, systemPrompt: instructions.systemPrompt });
    controller.start();
    res.status(result.replayed ? 200 : 202).json({ invocation: conversationInvocationView(result.invocation), replayed: result.replayed });
  });
  router.get("/workspaces/:workspaceId/conversations/:conversationId/invocations", async (req, res) => {
    res.json((await service.list(scope(req))).map(conversationInvocationView));
  });
  router.get("/workspaces/:workspaceId/conversations/:conversationId/invocations/:invocationId", async (req, res) => {
    const result = await service.read(scope(req), z.string().uuid().parse(req.params.invocationId));
    res.json(conversationInvocationView(result.invocation));
  });
  router.post("/workspaces/:workspaceId/conversations/:conversationId/invocations/:invocationId/cancel", async (req, res) => {
    z.object({}).strict().parse(req.body);
    const result = await service.cancel(scope(req), z.string().uuid().parse(req.params.invocationId));
    controller.start();
    res.status(202).json(conversationInvocationView(result));
  });
  router.get("/workspaces/:workspaceId/conversations/:conversationId/invocations/:invocationId/events", async (req, res) => {
    const identity = scope(req);
    const id = z.string().uuid().parse(req.params.invocationId);
    let cursor = z.coerce.number().int().min(0).max(2147483647).parse(req.get("Last-Event-ID") ?? req.query.after ?? 0);
    let result = await service.read(identity, id, cursor);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const disconnected = new AbortController();
    res.once("close", () => disconnected.abort());
    try {
      while (!disconnected.signal.aborted) {
        for (const event of result.events) {
          if (!res.write(`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)) await once(res, "drain", { signal: disconnected.signal });
          cursor = event.cursor;
        }
        if (result.invocation.finishedAt && cursor >= result.invocation.lastEventCursor) break;
        await delay(500, undefined, { signal: disconnected.signal });
        result = await service.read(identity, id, cursor);
      }
    } catch { /* Closing or revoked membership ends delivery, not execution. */ }
    finally { res.end(); }
  });
  return router;
}
