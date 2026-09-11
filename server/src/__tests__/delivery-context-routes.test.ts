import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deliveryContextRoutes } from "../routes/delivery-context.js";

const workspaceId = randomUUID();
const query = { channelEventId: randomUUID(), draftRevisionId: randomUUID(), createdTargetId: randomUUID(), createdTargetRevisionId: randomUUID() };
function app(actor: object) {
  const channel = vi.fn().mockResolvedValue({ assurance: "database_context_only", unverified: ["provider_authenticity_and_user_mapping"] });
  const codex = vi.fn().mockResolvedValue({ assurance: "execution_context_only" });
  const server = express();
  server.use((req, _res, next) => { req.actor = actor as never; next(); });
  server.use(deliveryContextRoutes({} as never, { channel, codex, logs: { read: vi.fn() } }));
  server.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return { server, channel, codex };
}
describe("read-only delivery context HTTP boundaries", () => {
  it("limits execution reads and releases capacity after a failed read", async () => {
    const s = app({ type: "board", source: "session", companyIds: [workspaceId] });
    const refs = { targetId: randomUUID(), targetRevisionId: randomUUID(), graphRevisionId: randomUUID(), runId: randomUUID(), runAttemptId: randomUUID(), heartbeatRunId: randomUUID() };
    let finish!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    s.codex.mockImplementationOnce(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const url = `/workspaces/${workspaceId}/delivery-context/codex`;
    const first = request(s.server).get(url).query(refs).then(response => response);
    await started;
    expect((await request(s.server).get(url).query(refs)).status).toBe(429);
    finish({ assurance: "execution_context_only" });
    expect((await first).status).toBe(200);
    s.codex.mockRejectedValueOnce(new Error("Synthetic failure"));
    expect((await request(s.server).get(url).query(refs)).status).toBe(500);
    expect((await request(s.server).get(url).query(refs)).status).toBe(200);
  });
  it("uses path-owned workspace identity and retains non-proof assurance", async () => {
    const s = app({ type: "board", source: "session", companyIds: [workspaceId] });
    const result = await request(s.server).get(`/workspaces/${workspaceId}/delivery-context/channel`).query(query);
    expect(result.status).toBe(200);
    expect(result.body.assurance).toBe("database_context_only");
    expect(s.channel).toHaveBeenCalledWith(expect.anything(), { ...query, workspaceId });
  });
  it.each([{ type: "none" }, { type: "agent", companyId: workspaceId }, { type: "board", source: "session", companyIds: [] }])("denies unauthorized context reads", async actor => {
    const s = app(actor);
    expect((await request(s.server).get(`/workspaces/${workspaceId}/delivery-context/channel`).query(query)).status).toBe(403);
    expect(s.channel).not.toHaveBeenCalled();
  });
  it.each([{ passed: "true" }, { workspaceId: randomUUID() }, { draftRevisionId: "invalid" }])("rejects caller observations and malformed references", async patch => {
    const s = app({ type: "board", source: "local_implicit" });
    expect((await request(s.server).get(`/workspaces/${workspaceId}/delivery-context/channel`).query({ ...query, ...patch })).status).toBe(400);
    expect(s.channel).not.toHaveBeenCalled();
  });
});
