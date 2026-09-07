import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, heartbeatRuns, issues, toolActionRequests,
  toolApplications, toolCallEvents, toolCatalogEntries, toolConnections,
  toolInvocations, toolPolicies, toolProfiles, toolRateLimitCounters,
  toolStdioCommandTemplates,
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const signingSecret = "boundary-test-only-signing-secret";
type Db = ReturnType<typeof createDb>;

(support.supported ? describe : describe.skip)("approved gateway dispatch boundary", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("approved-boundary-");
    db = createDb(database.connectionString);
  }, 20000);
  afterAll(async () => {
    await database?.cleanup();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  async function fixture(options: {
    test?: boolean;
    read?: boolean;
    local?: boolean;
    ratePriority?: number;
  } = {}) {
    const [company] = await db.insert(companies).values({ name: randomUUID(), issuePrefix: `T${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Actual test agent",
      role: "engineer",
      adapterType: "process"
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Actual test issue",
      status: "in_progress",
      assigneeAgentId: agent.id
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id }
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: randomUUID(),
      name: "Bounded fixture",
      type: options.local ? "mcp_stdio" : "mcp_http",
      status: "active"
    }).returning();
    const templateKey = randomUUID();
    const script = `
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  const result = message.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
    : { isError: true, content: [{ type: "text", text: "PRIVATE_PROVIDER_SENTINEL" }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;
    if (options.local)
      await db.insert(toolStdioCommandTemplates).values({
        companyId: company.id,
        templateKey,
        name: "Fixture",
        command: process.execPath,
        args: ["-e", script],
        envKeys: [],
        tools: []
      });
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Fixture",
      uid: randomUUID(),
      transport: options.local ? "local_stdio" : "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: options.local ? { templateId: templateKey } : { url: "https://example.invalid/mcp" }
    }).returning();
    const [entry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      entryKind: "tool",
      name: "publish",
      toolName: "publish",
      title: "Publish fixture",
      riskLevel: options.read ? "read" : "write",
      isReadOnly: !!options.read,
      isWrite: !options.read,
      status: "active",
      versionHash: randomUUID(),
      schemaHash: randomUUID()
    }).returning();
    const [policy] = await db.insert(toolPolicies).values({
      companyId: company.id,
      name: "Exact approval",
      policyType: "require_approval",
      selectors: { connectionId: connection.id }
    }).returning();
    if (options.ratePriority !== undefined) {
      await db.insert(toolPolicies).values({
        companyId: company.id,
        name: "One slot",
        policyType: "rate_limit",
        priority: options.ratePriority,
        selectors: { connectionId: connection.id },
        config: {
          limit: 1,
          windowSeconds: 3600,
          keyBy: ["agent", "tool"]
        },
      });
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "fixture",
      result: { content: [{ type: "text", text: "done" }], structuredContent: { commit: "fixed" } }
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const restart = () => createToolGatewayService(db, { toolActionSigningSecret: signingSecret });
    const gateway = restart();
    const session = await gateway.createSession({
      companyId: company.id,
      agentId: agent.id,
      runId: run.id
    });
    const tool = (await gateway.listToolsForSession(session.token)).find(t => t.catalogEntryId === entry.id)!;
    expect(tool).toBeTruthy();
    const parameters = {
      owner: "iiwish",
      repo: "verrail",
      branch: "codex/candidate-test",
      token: "first-raw-value"
    };
    const call = (g = gateway, args: unknown = parameters, actionRequestId?: string) => g.executeTool({
      sessionToken: session.token,
      tool: tool.name,
      parameters: args,
      idempotencyKey: randomUUID(),
      approvedActionRequestId: actionRequestId
    });
    if (options.test)
      await gateway.executeTestCall({
        companyId: company.id,
        connectionId: connection.id,
        agentId: agent.id,
        userId: "actual-test-user",
        toolName: "publish",
        parameters
      });
    else
      await expect(call()).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [action] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, company.id));
    const approve = (g = gateway) => g.approveActionRequest({
      companyId: company.id,
      actionRequestId: action.id,
      actor: { userId: "actual-reviewer" }
    });
    const current = async () => ({ action: (await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, action.id)))[0], invocation: (await db.select().from(toolInvocations).where(eq(toolInvocations.id, action.invocationId)))[0] });
    return {
      company,
      agent,
      issue,
      run,
      connection,
      entry,
      policy,
      templateKey,
      parameters,
      gateway,
      restart,
      fetch,
      call,
      action,
      approve,
      current,
      session,
      tool
    };
  }
  it.each(["pending", "approved", "replay", "approved-id", "test"])("rejects expired %s without dispatch", async (path) => {
    const f = await fixture({ test: path === "test" });
    await db.update(toolActionRequests).set({ expiresAt: new Date(0), ...(path === "pending" || path === "test" ? {} : { status: "approved", decidedAt: new Date() }) }).where(eq(toolActionRequests.id, f.action.id));
    if (path === "replay")
      await expect(f.call()).rejects.toMatchObject({ reasonCode: "action_expired" });
    else if (path === "approved-id")
      await expect(f.call(f.gateway, {}, f.action.id)).rejects.toMatchObject({ reasonCode: "action_expired" });
    else
      await expect(f.approve()).rejects.toMatchObject({ reasonCode: "action_expired" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.current()).action.status).toBe("expired");
  });
  it.each(["agent", "test", "approved-id"])("current deny overrides %s approval", async (path) => {
    const f = await fixture({ test: path === "test" });
    await db.update(toolPolicies).set({ policyType: "block" }).where(eq(toolPolicies.id, f.policy.id));
    if (path === "approved-id") {
      await db.update(toolActionRequests).set({ status: "approved", decidedAt: new Date() }).where(eq(toolActionRequests.id, f.action.id));
      await expect(f.call(f.gateway, {}, f.action.id)).rejects.toMatchObject({ reasonCode: "approved_action_policy_denied" });
    }
    else
      await f.approve();
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.current()).invocation.errorCode).toBe("approved_action_policy_denied");
  });
  it.each(["schema", "connection", "local-template", "raw-schema"])("test approval rejects signed %s drift", async (kind) => {
    const f = await fixture({ test: true, local: kind === "local-template" });
    if (kind === "schema")
      await db.update(toolCatalogEntries).set({ schemaHash: randomUUID() }).where(eq(toolCatalogEntries.id, f.entry.id));
    if (kind === "raw-schema")
      await db.update(toolCatalogEntries).set({ inputSchema: { type: "object", required: ["changed"] } }).where(eq(toolCatalogEntries.id, f.entry.id));
    if (kind === "connection")
      await db.update(toolConnections).set({ config: { url: "https://changed.invalid/mcp" } }).where(eq(toolConnections.id, f.connection.id));
    if (kind === "local-template")
      await db.update(toolStdioCommandTemplates).set({ args: ["-e", "process.exit(1)"] }).where(eq(toolStdioCommandTemplates.templateKey, f.templateKey));
    await f.approve();
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.current()).invocation.errorCode).toBe("approved_tool_target_changed");
  });
  it("unchanged require-approval executes exactly once for concurrent test approvals", async () => {
    const f = await fixture({ test: true });
    await Promise.allSettled([f.approve(), f.approve()]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await f.current()).action.status).toBe("executed");
    await expect(f.approve()).rejects.toMatchObject({ reasonCode: "action_not_pending" });
  });
  it.each(["remote-read", "local-read", "remote-write", "test-write"])("MCP %s error envelope is not success", async (kind) => {
    const f = await fixture({
      read: kind.endsWith("read"),
      local: kind === "local-read",
      test: kind === "test-write"
    });
    f.fetch.mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "fixture",
      result: { isError: true, content: [{ type: "text", text: "PRIVATE_PROVIDER_SENTINEL" }] }
    }), { headers: { "content-type": "application/json" } }));
    await f.approve();
    const state = await f.current();
    expect(state.invocation.status).not.toBe("succeeded");
    expect(state.action.status).not.toBe("executed");
    expect(state.invocation.errorCode).toBe(kind.endsWith("read") ? "mcp_tool_error" : "provider_effect_unknown");
    expect(JSON.stringify(state)).not.toContain("PRIVATE_PROVIDER_SENTINEL");
  });
  it.each(["agent", "test"])("uncertain %s write cannot replay after restart or with a fresh key", async (kind) => {
    const f = await fixture({ test: kind === "test" });
    f.fetch.mockRejectedValue(new Error("PRIVATE_PROVIDER_SENTINEL"));
    await f.approve();
    expect((await f.current()).invocation.errorCode).toBe("provider_effect_unknown");
    expect((await f.current()).action.status).toBe("failed");
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, f.connection.id));
    const next = f.restart();
    await expect(f.approve(next)).rejects.toMatchObject({ reasonCode: "provider_effect_unknown" });
    if (kind === "agent") {
      await expect(f.call(next)).rejects.toMatchObject({ reasonCode: "provider_effect_unknown" });
      await expect(f.call(next, {}, f.action.id)).rejects.toMatchObject({ reasonCode: "provider_effect_unknown" });
    }
    else
      await expect(next.executeTestCall({
        companyId: f.company.id,
        connectionId: f.connection.id,
        agentId: f.agent.id,
        userId: "actual-test-user",
        toolName: "publish",
        parameters: f.parameters
      })).rejects.toMatchObject({ reasonCode: "provider_effect_unknown" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("redacted hash collisions cannot replay another signed action", async () => {
    const f = await fixture();
    await f.approve();
    await expect(f.call(f.gateway, { ...f.parameters, token: "different-raw-value" })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).toHaveLength(2);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("an explicit idempotency key cannot replay different raw signed arguments", async () => {
    const f = await fixture();
    await f.approve();
    const invocation = (await f.current()).invocation;
    await expect(f.gateway.executeTool({
      sessionToken: f.session.token,
      tool: f.tool.name,
      parameters: { ...f.parameters, token: "different-raw-value" },
      idempotencyKey: invocation.idempotencyKey!,
    })).rejects.toMatchObject({ reasonCode: "idempotency_arguments_mismatch" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("a newer redacted collision cannot hide an older unknown action", async () => {
    const f = await fixture();
    f.fetch.mockRejectedValueOnce(new Error("unknown"));
    await f.approve();
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, f.connection.id));
    await expect(f.call(f.gateway, { ...f.parameters, token: "different-raw-value" })).rejects.toMatchObject({ reasonCode: "approval_required" });
    await expect(f.call()).rejects.toMatchObject({ reasonCode: "provider_effect_unknown" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("fails closed when bounded signed action history is exhausted", async () => {
    const f = await fixture();
    await f.approve();
    const action = (await f.current()).action;
    await db.insert(toolActionRequests).values(Array.from({ length: 32 }, () => ({ ...action, id: randomUUID() })));
    await expect(f.call()).rejects.toMatchObject({ reasonCode: "action_history_limit" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("another actual test user cannot repeat a signed unknown write", async () => {
    const f = await fixture({ test: true });
    f.fetch.mockRejectedValueOnce(new Error("unknown"));
    await f.approve();
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, f.connection.id));
    await expect(f.gateway.executeTestCall({
      companyId: f.company.id,
      connectionId: f.connection.id,
      agentId: f.agent.id,
      userId: "different-actual-user",
      toolName: "publish",
      parameters: f.parameters,
    })).rejects.toMatchObject({ reasonCode: "provider_effect_unknown" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("an existing second approval cannot dispatch after the first unknown effect", async () => {
    const f = await fixture({ test: true });
    await f.gateway.executeTestCall({
      companyId: f.company.id,
      connectionId: f.connection.id,
      agentId: f.agent.id,
      userId: "different-actual-user",
      toolName: "publish",
      parameters: f.parameters
    });
    const second = (await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).find(a => a.id !== f.action.id)!;
    expect(second).toBeTruthy();
    f.fetch.mockRejectedValueOnce(new Error("unknown"));
    await f.approve();
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, f.connection.id));
    await f.gateway.approveActionRequest({
      companyId: f.company.id,
      actionRequestId: second.id,
      actor: { userId: "actual-reviewer" }
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, second.invocationId));
    expect(invocation.errorCode).toBe("provider_effect_unknown");
  });
  it.each(["agent", "test"])("current %s actor suspension revokes approved dispatch", async (origin) => {
    const f = await fixture({ test: origin === "test" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    await f.approve();
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.current()).invocation.errorCode).toBe("approved_action_policy_denied");
  });
  it.each([false, true])("retains named gateway authority after run token cleanup (disabled=%s)", async (disabled) => {
    const f = await fixture();
    const [profile] = await db.insert(toolProfiles).values({
      companyId: f.company.id,
      profileKey: randomUUID(),
      name: randomUUID(),
      defaultAction: "allow"
    }).returning();
    const named = await f.gateway.createNamedGateway({ companyId: f.company.id, body: { name: randomUUID(), profileId: profile.id } });
    const token = await f.gateway.createNamedGatewayToken({
      companyId: f.company.id,
      gatewayId: named.id,
      body: {
        name: "Actual run token",
        subjectType: "heartbeat_run",
        subjectId: f.run.id,
        expiresAt: new Date(Date.now() + 60000)
      },
      actor: { agentId: f.agent.id }
    });
    await expect(f.gateway.executeTool({
      sessionToken: token.token,
      gatewayId: named.id,
      tool: f.tool.name,
      parameters: { ...f.parameters, branch: "codex/named-candidate" },
      idempotencyKey: randomUUID()
    })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const action = (await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).find(a => a.id !== f.action.id)!;
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await f.gateway.revokeNamedGatewayToken({ companyId: f.company.id, tokenId: token.id });
    if (disabled)
      await f.gateway.updateNamedGateway({
        companyId: f.company.id,
        gatewayId: named.id,
        body: { status: "disabled" }
      });
    await f.gateway.approveActionRequest({
      companyId: f.company.id,
      actionRequestId: action.id,
      actor: { userId: "actual-reviewer" }
    });
    expect(f.fetch).toHaveBeenCalledTimes(disabled ? 0 : 1);
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, action.invocationId));
    expect(invocation.gatewayId).toBe(named.id);
    expect(invocation.errorCode).toBe(disabled ? "approved_action_policy_denied" : null);
  });
  it("bounds signed payload bytes before retrieving the payload", async () => {
    const f = await fixture();
    await db.update(toolActionRequests).set({ signedArguments: "x".repeat(32 * 1024 * 1024 + 1) }).where(eq(toolActionRequests.id, f.action.id));
    await expect(f.call()).rejects.toMatchObject({ reasonCode: "action_history_limit" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not overwrite durable success when completion event projection fails", async () => {
    const f = await fixture();
    const originalInsert = db.insert.bind(db);
    const injected = vi.fn();
    vi.spyOn(db, "insert").mockImplementation(((table: Parameters<typeof db.insert>[0]) => {
      const query = originalInsert(table);
      if (table === toolCallEvents) {
        const originalValues = query.values.bind(query);
        vi.spyOn(query, "values").mockImplementation(((values: {
          eventType?: string;
        }) => {
          if (values.eventType === "call_completed") {
            injected();
            throw new Error("PRIVATE_PROJECTION_SENTINEL");
          }
          return originalValues(values as Parameters<typeof query.values>[0]);
        }) as typeof query.values);
      }
      return query;
    }) as typeof db.insert);
    await f.approve();
    expect(injected).toHaveBeenCalledTimes(1);
    const state = await f.current();
    expect(state.action.status).toBe("executed");
    expect(state.invocation.status).toBe("succeeded");
    expect(state.invocation.errorCode).toBeNull();
    await expect(f.call()).resolves.toMatchObject({ status: "replayed" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("a newly added deny is not hidden behind the already discharged approval policy", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "Later deny",
      policyType: "block",
      selectors: { connectionId: f.connection.id }
    });
    await f.approve();
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.current()).invocation.errorCode).toBe("approved_action_policy_denied");
  });
  it.each([-10, 200])("a fresh approval owns exactly one current rate slot at priority %s", async (ratePriority) => {
    const f = await fixture({ ratePriority });
    const before = await db.select().from(toolRateLimitCounters).where(eq(toolRateLimitCounters.companyId, f.company.id));
    expect(before).toHaveLength(1);
    expect(before[0].remaining).toBe(0);
    await f.approve();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await f.current()).action.status).toBe("executed");
    expect(await db.select().from(toolRateLimitCounters).where(eq(toolRateLimitCounters.companyId, f.company.id))).toEqual(before);
  });
  it("an old approval cannot silently use a newly added limiter with empty capacity", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "New limiter",
      policyType: "rate_limit",
      priority: 200,
      selectors: { connectionId: f.connection.id },
      config: {
        limit: 1,
        windowSeconds: 3600,
        keyBy: ["agent", "tool"]
      },
    });
    await f.approve();
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.current()).invocation.errorCode).toBe("approved_action_policy_denied");
    await expect(f.call()).rejects.toMatchObject({ reasonCode: "approval_required" });
    const next = (await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).find(a => a.id !== f.action.id)!;
    await f.gateway.approveActionRequest({
      companyId: f.company.id,
      actionRequestId: next.id,
      actor: { userId: "actual-reviewer" }
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("a new approval obligation requires fresh review rather than an approval loop", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({
      companyId: f.company.id,
      name: "New review",
      policyType: "require_approval",
      selectors: { connectionId: f.connection.id }
    });
    await f.approve();
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.call()).rejects.toMatchObject({ reasonCode: "approval_required" });
    const next = (await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).find(a => a.id !== f.action.id)!;
    await f.gateway.approveActionRequest({
      companyId: f.company.id,
      actionRequestId: next.id,
      actor: { userId: "actual-reviewer" }
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("ordinary allow priority is unchanged while approved dispatch checks later hard denies", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values([
      {
        companyId: f.company.id,
        name: "Priority allow",
        policyType: "allow",
        priority: -10,
        selectors: { connectionId: f.connection.id }
      },
      {
        companyId: f.company.id,
        name: "Later block",
        policyType: "block",
        priority: 200,
        selectors: { connectionId: f.connection.id }
      },
    ]);
    await expect(f.call(f.gateway, { ...f.parameters, branch: "codex/ordinary" })).resolves.toMatchObject({ status: "completed" });
    await f.approve();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await f.current()).invocation.errorCode).toBe("approved_action_policy_denied");
  });
  it.each(["executing", "unknown", "succeeded"])("a stale public expiry cannot overwrite a concurrent %s outcome", async outcome => {
    const f = await fixture();
    await db.update(toolActionRequests).set({ expiresAt: new Date(0) }).where(eq(toolActionRequests.id, f.action.id));
    const originalUpdate = db.update.bind(db);
    const raced = vi.fn();
    const interceptUpdate = (target: Db) => {
      const targetUpdate = target.update.bind(target);
      vi.spyOn(target, "update").mockImplementation(((table: Parameters<typeof db.update>[0]) => {
        const query = targetUpdate(table);
        const originalSet = query.set.bind(query);
        vi.spyOn(query, "set").mockImplementation(((values: { status?: string }) => {
          const update = originalSet(values as Parameters<typeof query.set>[0]);
          if (table === toolActionRequests && values.status === "expired") {
            const originalThen = update.then.bind(update);
            vi.spyOn(update, "then").mockImplementation((async (...args: Parameters<typeof update.then>) => {
              raced();
              await originalUpdate(toolActionRequests).set({
                status: outcome === "unknown" ? "failed" : outcome === "succeeded" ? "executed" : "executing",
              }).where(eq(toolActionRequests.id, f.action.id));
              await originalUpdate(toolInvocations).set({
                status: outcome === "unknown" ? "failed" : outcome === "succeeded" ? "succeeded" : "executing",
                errorCode: outcome === "unknown" ? "provider_effect_unknown" : null,
              }).where(eq(toolInvocations.id, f.action.invocationId));
              return originalThen(...args);
            }) as typeof update.then);
          }
          return update;
        }) as typeof query.set);
        return query;
      }) as typeof db.update);
    };
    interceptUpdate(db);
    const originalTransaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation(((callback: Parameters<typeof db.transaction>[0]) => originalTransaction(async tx => {
      interceptUpdate(tx as unknown as Db);
      return callback(tx);
    })) as typeof db.transaction);
    await expect(f.approve()).rejects.toMatchObject({ reasonCode: "action_expired" });
    expect(raced).toHaveBeenCalledTimes(1);
    const state = await f.current();
    expect(state.action.status).toBe(outcome === "unknown" ? "failed" : outcome === "succeeded" ? "executed" : "executing");
    expect(state.invocation.status).toBe(outcome === "unknown" ? "failed" : outcome === "succeeded" ? "succeeded" : "executing");
    expect(state.invocation.errorCode).toBe(outcome === "unknown" ? "provider_effect_unknown" : null);
  });
  it("an earlier allow cannot hide review required by a newly promoted stale trust rule", async () => {
    const f = await fixture();
    const requestInAnotherIssue = async () => {
      const [issue] = await db.insert(issues).values({
        companyId: f.company.id, title: "Distinct approval scope", status: "in_progress", assigneeAgentId: f.agent.id,
      }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: f.company.id, agentId: f.agent.id, invocationSource: "assignment",
        status: "running", contextSnapshot: { issueId: issue.id },
      }).returning();
      const session = await f.gateway.createSession({ companyId: f.company.id, agentId: f.agent.id, runId: run.id });
      await expect(f.gateway.executeTool({
        sessionToken: session.token, tool: f.tool.name, parameters: f.parameters, idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ reasonCode: "approval_required" });
      const [action] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.issueId, issue.id));
      return action;
    };
    const second = await requestInAnotherIssue();
    await f.approve();
    await f.gateway.approveActionRequest({
      companyId: f.company.id, actionRequestId: second.id, actor: { userId: "actual-reviewer" },
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await db.update(toolCatalogEntries).set({ versionHash: randomUUID(), schemaHash: randomUUID() })
      .where(eq(toolCatalogEntries.id, f.entry.id));
    const current = await requestInAnotherIssue();
    await toolAccessPolicyService(db).createTrustRuleFromActionRequest({
      companyId: f.company.id, actionRequestId: f.action.id,
      body: { approvalThreshold: 2, priority: 40 }, actor: { userId: "actual-reviewer" },
    });
    await db.insert(toolPolicies).values({
      companyId: f.company.id, name: "Earlier allow", policyType: "allow", priority: -10,
      selectors: { connectionId: f.connection.id },
    });
    await f.gateway.approveActionRequest({
      companyId: f.company.id, actionRequestId: current.id, actor: { userId: "actual-reviewer" },
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, current.invocationId));
    expect(invocation.errorCode).toBe("approved_action_policy_denied");
  });
});
