import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { agentLifecycleRoutes } from "../routes/agent-lifecycle.js";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { errorHandler } from "../middleware/error-handler.js";

const preview = vi.hoisted(() => vi.fn());
vi.mock("../services/agent-publication.js", () => ({ readAgentPublication: preview }));
const workspaceId = "11111111-1111-4111-8111-111111111111";
const definitionId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const sourceHash = "a".repeat(64);
const snapshot = { runtime: "codex_local", model: "model", prompt: "Saved behavior", skills: [], tools: [], supplyChain: {} };
function app(actor: Record<string, unknown> = { type: "board", source: "local_implicit", userId: "local-board" }, definition: unknown = { id: definitionId, compatibilityAgentId: agentId }) {
  const publishAgentVersion = vi.fn().mockResolvedValue({ resourceId: "version", replayed: false });
  const db = { select: () => ({ from: () => ({ where: async () => definition ? [definition] : [] }) }) } as unknown as Db;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  server.use("/api", agentLifecycleRoutes(db, { domainApiClient: { publishAgentVersion } as unknown as VerrailDomainApiClient }));
  server.use(errorHandler);
  return { server, publishAgentVersion };
}
const route = `/api/workspaces/${workspaceId}/agent-definitions/${definitionId}/publish-saved`;
beforeEach(() => preview.mockReset().mockResolvedValue({ agentId, sourceHash, snapshot, warnings: [], mode: "compatibility_executor" }));
describe("publication route", () => {
  it("forwards only a server-generated snapshot to the authoritative writer", async () => {
    const test = app();
    await request(test.server).post(route).set("Idempotency-Key", "test.publish.1").send({ sourceHash }).expect(201);
    expect(preview).toHaveBeenCalledWith(expect.anything(), workspaceId, agentId);
    expect(test.publishAgentVersion).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, definitionId, input: snapshot, idempotencyKey: "test.publish.1" }));
  });
  it("rejects stale confirmation without writing", async () => {
    const test = app();
    await request(test.server).post(route).set("Idempotency-Key", "test.publish.1").send({ sourceHash: "b".repeat(64) }).expect(409);
    expect(test.publishAgentVersion).not.toHaveBeenCalled();
  });
  it("does not accept injected publish fields or foreign definitions", async () => {
    const test = app();
    await request(test.server).post(route).set("Idempotency-Key", "test.publish.1").send({ sourceHash, prompt: "injected" }).expect(400);
    const missing = app(undefined, null);
    await request(missing.server).post(route).set("Idempotency-Key", "test.publish.1").send({ sourceHash }).expect(404);
    expect(test.publishAgentVersion).not.toHaveBeenCalled();
    expect(missing.publishAgentVersion).not.toHaveBeenCalled();
  });
  it("requires human board access and workspace membership", async () => {
    for (const actor of [{ type: "agent", companyId: workspaceId, agentId }, { type: "board", source: "session", userId: "user", companyIds: [] }]) {
      const test = app(actor);
      await request(test.server).post(route).set("Idempotency-Key", "test.publish.1").send({ sourceHash }).expect(403);
      await request(test.server).get(`/api/workspaces/${workspaceId}/agents/${agentId}/publication-preview`).expect(403);
      expect(test.publishAgentVersion).not.toHaveBeenCalled();
    }
  });
});
