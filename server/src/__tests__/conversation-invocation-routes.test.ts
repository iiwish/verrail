import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { conversationInvocationRoutes } from "../routes/conversation-invocations.js";
import type { createConversationInvocationController } from "../services/conversation-invocation-controller.js";

const service = vi.hoisted(() => ({ replay: vi.fn(), begin: vi.fn(), read: vi.fn(), cancel: vi.fn() }));
vi.mock("../services/conversation-invocations.js", () => ({ conversationInvocationService: () => service }));
const workspaceId = randomUUID();
const conversationId = randomUUID();
const id = randomUUID();
const row = {
  id, workspaceId, conversationId, sourceMessageId: randomUUID(), principalId: "owner",
  agentVersionId: randomUUID(), deploymentRevisionId: randomUUID(), status: "succeeded", lastEventCursor: 2,
  output: "Reply", errorCode: null, createdAt: new Date(), startedAt: new Date(), finishedAt: new Date(),
  input: { systemPrompt: "PRIVATE SYSTEM PROMPT" }, controllerId: "PRIVATE CONTROLLER", fencingToken: 3,
};
const controller = { start: vi.fn(), close: vi.fn(), reconcile: vi.fn() } as ReturnType<typeof createConversationInvocationController>;
function app() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "owner", companyIds: [workspaceId], memberships: [{ companyId: workspaceId, membershipRole: "owner", status: "active" }], source: "session", isInstanceAdmin: false };
    next();
  });
  app.use(conversationInvocationRoutes({} as Db, controller));
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 400).json({ error: "Rejected" }); });
  return app;
}
const base = `/workspaces/${workspaceId}/conversations/${conversationId}/invocations`;
beforeEach(() => { vi.clearAllMocks(); });
describe("durable invocation HTTP routes", () => {
  it("replays accepted requests without reading changed runtime configuration or leaking internals", async () => {
    service.replay.mockResolvedValue(row);
    const response = await request(app()).post(base).send({ body: "Hello", idempotencyKey: "one" });
    expect(response.status).toBe(200);
    expect(response.body.replayed).toBe(true);
    expect(response.text).not.toContain("PRIVATE");
    expect(service.replay).toHaveBeenCalledWith({ workspaceId, conversationId, principalId: "owner" }, { body: "Hello", idempotencyKey: "one" });
    expect(service.begin).not.toHaveBeenCalled();
    const forged = await request(app()).post(base).send({ body: "Hello", idempotencyKey: "one", principalId: "admin" });
    expect(forged.status).toBe(400);
  });
  it("rejects another workspace before reading its data", async () => {
    const response = await request(app()).get(`/workspaces/${randomUUID()}/conversations/${conversationId}/invocations/${id}`);
    expect(response.status).toBe(403);
    expect(service.read).not.toHaveBeenCalled();
  });
  it("replays SSE after its saved cursor without cancelling the invocation", async () => {
    service.read.mockResolvedValue({ invocation: row, events: [{ cursor: 2, type: "done", data: { status: "succeeded" } }] });
    const response = await request(app()).get(`${base}/${id}/events`).set("Last-Event-ID", "1");
    expect(response.status).toBe(200);
    expect(response.text).toBe('id: 2\nevent: done\ndata: {"status":"succeeded"}\n\n');
    expect(service.read).toHaveBeenCalledWith({ workspaceId, conversationId, principalId: "owner" }, id, 1);
    expect(service.cancel).not.toHaveBeenCalled();
  });
});
