import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { deliveryContextRoutes } from "../routes/delivery-context.js";
import { observeNativePermissions, validateNativePermissionObservation } from "./verrail-native-permission-observation.js";

describe("native control-plane permission observation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, server: Server;
  let origin: string, token: string;
  const identity = Object.fromEntries(["workspaceId", "agentId", "heartbeatRunId", "runId", "attemptId", "agentVersionId", "deploymentRevisionId"]
    .map(key => [key, randomUUID()])) as { workspaceId: string; agentId: string; heartbeatRunId: string; runId: string; attemptId: string; agentVersionId: string; deploymentRevisionId: string };
  const dispatchSha256 = "a".repeat(64);
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-native-permission-secret");
    database = await startEmbeddedPostgresTestDatabase("verrail-native-permission-"); db = createDb(database.connectionString);
    await db.insert(companies).values({ id: identity.workspaceId, name: "Synthetic permission probe", issuePrefix: "NPP" });
    await db.insert(agents).values({ id: identity.agentId, companyId: identity.workspaceId, name: "Synthetic", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: identity.heartbeatRunId, companyId: identity.workspaceId, agentId: identity.agentId, status: "running" });
    token = createLocalAgentJwt(identity.agentId, identity.workspaceId, "codex_local", identity.heartbeatRunId)!;
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    // Real authentication middleware; this small self-view substitutes only the agent-detail presentation.
    app.get("/api/agents/me", (req, res) => {
      if (req.actor.type !== "agent") { res.sendStatus(401); return; }
      res.json({ id: req.actor.agentId, companyId: req.actor.companyId, private: "PRIVATE AGENT DATA" });
    });
    app.use("/api", deliveryContextRoutes(db)); app.use(errorHandler);
    server = await new Promise<Server>(resolve => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30_000);
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs();
  });
  it("observes allow, Board denial, invalid credential and run-header denial through real HTTP", async () => {
    const observed = await observeNativePermissions({ identity, dispatchSha256, apiOrigin: origin, authToken: token });
    expect(observed.probes.map(probe => probe.status)).toEqual([200, 403, 401, 422]);
    expect(validateNativePermissionObservation(observed, identity, dispatchSha256)).toEqual(observed);
    expect(JSON.stringify(observed)).not.toContain(token);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    expect(observed.limitations).toContain("not_filesystem_or_network_isolation");
    expect(validateNativePermissionObservation({ ...observed, tokenSha256: "b".repeat(64) }, identity, dispatchSha256)).toBeNull();
    expect(validateNativePermissionObservation(observed, { ...identity, attemptId: randomUUID() }, dispatchSha256)).toBeNull();
    expect(validateNativePermissionObservation(observed, identity, "b".repeat(64))).toBeNull();
  });
  it.each(["https://example.com", "http://localhost:1234", "http://127.0.0.1:1234/path", "http://user:secret@127.0.0.1:1234", "http://127.0.0.1:1234?token=secret"])("refuses an unpinned origin %s before credentials leave the process", async apiOrigin => {
    const fetcher = vi.fn();
    await expect(observeNativePermissions({ identity, dispatchSha256, apiOrigin, authToken: token }, { fetch: fetcher })).rejects.toThrow("NATIVE_PERMISSION_OBSERVATION_UNAVAILABLE");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a credential for another run before I/O", async () => {
    const fetcher = vi.fn();
    await expect(observeNativePermissions({ identity: { ...identity, heartbeatRunId: randomUUID() }, dispatchSha256, apiOrigin: origin, authToken: token }, { fetch: fetcher })).rejects.toThrow("NATIVE_PERMISSION_OBSERVATION_UNAVAILABLE");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([200, 401, 404, 500])("does not relabel an unexpected response %d as proof", async status => {
    const fetcher = vi.fn(async () => Response.json({ id: identity.agentId, companyId: identity.workspaceId }, { status }));
    await expect(observeNativePermissions({ identity, dispatchSha256, apiOrigin: origin, authToken: token }, { fetch: fetcher })).rejects.toThrow("NATIVE_PERMISSION_OBSERVATION_UNAVAILABLE");
  });
});
