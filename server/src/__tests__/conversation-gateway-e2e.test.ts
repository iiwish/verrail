import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, verrailAgentDefinitions, verrailAgentVersions, verrailEvaluationRuns, verrailDeployments, verrailDeploymentRevisions, verrailConversations, verrailConversationMessages } from "@paperclipai/db";
import { DIRECTOR_GATEWAY_TOOL_NAMES } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createExecutionGatewayApp } from "../execution/gateway-http.js";
import { createExecutionGatewayStore } from "../execution/gateway-store.js";
import { createOpenCodeGatewayRuntime } from "../execution/opencode-runtime.js";
import { withBuiltInAgentMarker } from "../services/built-in-agent-metadata.js";
import { bootstrapFirstOperator } from "../services/first-operator.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server | undefined) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe.skipIf(process.env.VERRAIL_TEST_OPENCODE_HTTP !== "1")("authenticated app to real OpenCode gateway", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let apiServer: Server;
  let provider: Server;
  let gatewayServer: Server;
  let app: Awaited<ReturnType<typeof import("../app.js")["createApp"]>>;
  let gateway: Awaited<ReturnType<typeof createExecutionGatewayStore>>;
  let base: string;
  let cookie: string;
  let workspaceId: string;
  let conversationId: string;
  let versionId: string;
  let mode: "complete" | "hold" = "complete";
  const offered: string[][] = [];
  const toolResults: unknown[] = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "verrail-chat-e2e-"));
    for (const [key, value] of Object.entries({ PAPERCLIP_HOME: root, PAPERCLIP_CONFIG: path.join(root, "absent.json"), PAPERCLIP_TELEMETRY_DISABLED: "1", BETTER_AUTH_SECRET: "fixture-auth-key-012345678901234567890123456789", PAPERCLIP_AUTH_RATE_LIMIT_ENABLED: "false", VERRAIL_CHAT_RUNTIME: "opencode", VERRAIL_CHAT_MODEL: "fixture/test", PAPERCLIP_STORAGE_LOCAL_DIR: path.join(root, "storage") })) vi.stubEnv(key, value);
    database = await startEmbeddedPostgresTestDatabase("verrail-chat-e2e-db-");
    db = createDb(database.connectionString);
    apiServer = createServer();
    base = await listen(apiServer);
    provider = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        offered.push((body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name));
        const results = body.messages.filter((message: { role: string }) => message.role === "tool");
        toolResults.push(...results);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const emit = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (mode === "hold") { emit({ role: "assistant", content: "Working" }); return; }
        if (!results.length) {
          emit({ role: "assistant", tool_calls: [{ index: 0, id: "call_context", type: "function", function: { name: "director_get_conversation_context", arguments: "{}" } }] });
          emit({}, "tool_calls");
        } else { emit({ role: "assistant", content: "Context verified" }); emit({}, "stop"); }
        res.end("data: [DONE]\n\n");
      } catch { res.writeHead(500).end(); }
    });
    const providerUrl = await listen(provider);
    gateway = await createExecutionGatewayStore({ root: path.join(root, "gateway"), runtime: createOpenCodeGatewayRuntime({
      version: "1.17.13", controlPlaneUrl: base,
      providers: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `${providerUrl}/v1`, apiKey: "fixture-only" }, models: { test: { name: "Test", limit: { context: 32000, output: 1000 } } } } },
    }) });
    const gatewayToken = "fixture-gateway-token-01234567890123456789";
    gatewayServer = createServer(createExecutionGatewayApp(gateway, gatewayToken));
    vi.stubEnv("VERRAIL_EXECUTION_GATEWAY_URL", await listen(gatewayServer));
    for (const [key, value] of [["VERRAIL_GATEWAY_TOKEN_FILE", gatewayToken], ["VERRAIL_DIRECTOR_SIGNING_KEY_FILE", "fixture-director-signing-01234567890123456789"]]) {
      const filename = path.join(root, key);
      await writeFile(filename, value, { mode: 0o600 });
      vi.stubEnv(key, filename);
    }
    const { loadConfig } = await import("../config.js");
    const { createBetterAuthInstance, createBetterAuthHandler, resolveBetterAuthSession } = await import("../auth/better-auth.js");
    const { createStorageServiceFromConfig } = await import("../storage/index.js");
    const config = { ...loadConfig(), deploymentMode: "authenticated" as const, deploymentExposure: "private" as const, authBaseUrlMode: "explicit" as const, authPublicBaseUrl: base, authDisableSignUp: true };
    const auth = createBetterAuthInstance(db, config, [base]);
    const { createApp } = await import("../app.js");
    app = await createApp(db, { uiMode: "none", serverPort: Number(new URL(base).port), storageService: createStorageServiceFromConfig(config), deploymentMode: "authenticated", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authPublicBaseUrl: base, authReady: true, companyDeletionEnabled: false, managedPluginAutoInstall: [], localPluginDir: path.join(root, "plugins"), decisionServiceOptions: { wakeOriginAgent: async () => null }, betterAuthHandler: createBetterAuthHandler(auth), resolveSession: req => resolveBetterAuthSession(auth, req) });
    await app.locals.bundledPluginsStartup;
    apiServer.on("request", app);
    const signup = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ name: "Fixture owner", email: "owner@example.test", password: "fixture-password-0123456789" }) });
    expect(signup.status).toBe(400);
    const operator = await bootstrapFirstOperator(db, { name: "Fixture owner", email: "owner@example.test", password: "fixture-password-0123456789" });
    expect(operator.status).toBe("created");
    const login = await fetch(`${base}/api/auth/sign-in/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ email: "owner@example.test", password: "fixture-password-0123456789" }) });
    expect(login.status).toBe(200);
    cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    expect(cookie).not.toBe("");
    const { user } = await login.json() as { user: { id: string } };
    const [workspace] = await db.insert(companies).values({ name: "Gateway fixture", issuePrefix: "GWF" }).returning();
    workspaceId = workspace.id;
    await db.insert(companyMemberships).values({ companyId: workspaceId, principalType: "user", principalId: user.id, membershipRole: "owner", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: workspaceId, name: "Director", role: "ceo", status: "idle", adapterType: "opencode_local", metadata: withBuiltInAgentMarker(null, { key: "director", featureKeys: [] }) }).returning();
    const owner = { createdByPrincipalType: "user", createdByPrincipalId: user.id };
    const [definition] = await db.insert(verrailAgentDefinitions).values({ id: randomUUID(), workspaceId, compatibilityAgentId: agent.id, name: "Director", ...owner }).returning();
    const [version] = await db.insert(verrailAgentVersions).values({ id: randomUUID(), workspaceId, agentDefinitionId: definition.id, versionNumber: 1, runtime: "opencode", model: "fixture/test", prompt: "Read the conversation context before replying", contentHash: "fixture", supplyChain: { source: "saved_agent_configuration.v2", mode: "director_chat" }, ...owner }).returning();
    versionId = version.id;
    const [evaluation] = await db.insert(verrailEvaluationRuns).values({ id: randomUUID(), workspaceId, candidateAgentVersionId: version.id, status: "inconclusive", safetyStatus: "not_run", ...owner }).returning();
    const [deployment] = await db.insert(verrailDeployments).values({ id: randomUUID(), workspaceId, agentDefinitionId: definition.id, name: "Director", isPrimary: true, ...owner }).returning();
    await db.insert(verrailDeploymentRevisions).values({ id: randomUUID(), workspaceId, deploymentId: deployment.id, revisionNumber: 1, agentVersionId: version.id, evaluationRunId: evaluation.id, state: "active", contentHash: "fixture", ...owner });
    const [conversation] = await db.insert(verrailConversations).values({ workspaceId, contextVersion: 17, ...owner }).returning();
    conversationId = conversation.id;
  }, 60000);

  afterAll(async () => {
    await app?.locals.paperclipShutdown?.();
    await gateway?.close();
    await close(apiServer);
    await close(gatewayServer);
    await close(provider);
    await db?.$client.end();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const url = () => `${base}/api/workspaces/${workspaceId}/conversations/${conversationId}/invocations`;
  const headers = () => ({ Cookie: cookie, Origin: base, "Content-Type": "application/json" });
  async function read(id: string) {
    const response = await fetch(`${url()}/${id}`, { headers: headers() });
    expect(response.status).toBe(200);
    return response.json();
  }

  it("authenticates, invokes a real scoped tool and persists one reply for replay", async () => {
    expect((await fetch(url())).status).toBe(403);
    expect((await fetch(url().replace(workspaceId, randomUUID()), { headers: headers() })).status).toBe(403);
    const input = { body: "Read my context", idempotencyKey: "real-tool-turn" };
    const response = await fetch(url(), { method: "POST", headers: headers(), body: JSON.stringify(input) });
    expect(response.status, await response.clone().text()).toBe(202);
    const { invocation } = await response.json();
    expect(invocation.agentVersionId).toBe(versionId);
    const events = await fetch(`${url()}/${invocation.id}/events`, { headers: headers(), signal: AbortSignal.timeout(45000) });
    const transcript = await events.text();
    expect(transcript).toContain("event: chunk");
    expect(transcript).toContain('"status":"succeeded"');
    expect((await read(invocation.id)).output).toBe("Context verified");
    expect(JSON.stringify(toolResults)).toContain("contextVersion");
    expect(JSON.stringify(toolResults)).toContain("17");
    expect([...new Set(offered.flat())].sort()).toEqual(DIRECTOR_GATEWAY_TOOL_NAMES.map(tool => `director_${tool}`).sort());
    const replay = await fetch(url(), { method: "POST", headers: headers(), body: JSON.stringify(input) });
    expect(replay.status).toBe(200);
    expect((await replay.json()).invocation.id).toBe(invocation.id);
    const rows = await db.select().from(verrailConversationMessages).where(eq(verrailConversationMessages.conversationId, conversationId));
    expect(rows.map(row => row.role)).toEqual(["user", "assistant"]);
  }, 60000);

  it("does not cancel on SSE disconnect and acknowledges explicit process cleanup", async () => {
    mode = "hold";
    const response = await fetch(url(), { method: "POST", headers: headers(), body: JSON.stringify({ body: "Keep working", idempotencyKey: "cancel-turn" }) });
    expect(response.status).toBe(202);
    const { invocation } = await response.json();
    const disconnected = new AbortController();
    const stream = await fetch(`${url()}/${invocation.id}/events`, { headers: headers(), signal: disconnected.signal });
    await stream.body!.getReader().read();
    disconnected.abort();
    await expect.poll(async () => (await read(invocation.id)).output, { timeout: 45000, interval: 250 }).toContain("Working");
    expect((await read(invocation.id)).status).toBe("running");
    const cancel = await fetch(`${url()}/${invocation.id}/cancel`, { method: "POST", headers: headers(), body: "{}" });
    expect(cancel.status).toBe(202);
    expect((await cancel.json()).status).toBe("cancel_requested");
    await expect.poll(async () => (await read(invocation.id)).status, { timeout: 15000, interval: 250 }).toBe("canceled");
    expect((await read(invocation.id)).finishedAt).not.toBeNull();
  }, 60000);
});
