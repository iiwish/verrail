import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { buildDirectorInstructions } from "../services/director-instructions.js";

const mockSpawn = vi.hoisted(() => vi.fn());
const mockEffectiveVersion = vi.hoisted(() => vi.fn());
vi.mock("../services/agent-effective-version.js", () => ({ readEffectiveAgentVersion: mockEffectiveVersion }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: mockSpawn,
}));
vi.mock("../services/conversation-runtime-command.js", () => ({
  resolveConversationRuntimeCommand: vi.fn(async () => "/fixture/codex"),
}));

const mockConversationService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  appendMessage: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockBuiltInAgentService = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockDraftService = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), cancel: vi.fn(), get: vi.fn(),
  prepareConfirmation: vi.fn(), finalizeConfirmation: vi.fn(),
}));
const mockProviderBindingService = vi.hoisted(() => ({ create: vi.fn(), resolve: vi.fn() }));
const mockDirectorMember = vi.hoisted(() => vi.fn());
const mockManageTarget = vi.hoisted(() => vi.fn());
const mockSwitchContext = vi.hoisted(() => vi.fn());
vi.mock("../services/conversation-context.js", () => ({ conversationContextService: () => ({ switch: mockSwitchContext }) }));
vi.mock("../services/director-tools.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/director-tools.js")>(),
  assertDirectorMember: mockDirectorMember,
}));

vi.mock("../services/index.js", () => ({
  builtInAgentService: () => mockBuiltInAgentService,
  conversationService: () => mockConversationService,
  targetCreationDraftService: () => mockDraftService,
  providerConversationBindingService: () => mockProviderBindingService,
  createVerrailDomainApiClient: () => null,
  logActivity: mockLogActivity,
}));

const WORKSPACE_ID = "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const OTHER_WORKSPACE_ID = "b80f266a-87ea-57f0-81bd-c4f04e4d576e";
const CONVERSATION_ID = "0de2d166-850e-5c74-ab63-beb86129b52a";

const conversation = {
  id: CONVERSATION_ID,
  workspaceId: WORKSPACE_ID,
  title: "Delivery decision",
  status: "active",
  pinnedAt: null,
  createdByPrincipalType: "user",
  createdByPrincipalId: "user-1",
  lastMessageAt: null,
  createdAt: new Date("2026-08-28T08:00:00.000Z"),
  updatedAt: new Date("2026-08-28T08:00:00.000Z"),
};

async function createApp(deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const [{ conversationRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/conversations.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [WORKSPACE_ID],
      memberships: [{ companyId: WORKSPACE_ID, membershipRole: "owner", status: "active" }],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", conversationRoutes({} as any, { deploymentMode, domainApiClient: { manageTarget: mockManageTarget } as any }));
  app.use(errorHandler);
  return app;
}

describe("conversation routes", () => {
  it("switches context with actor and workspace derived from authentication, not request fields", async () => {
    const app = await createApp();
    const input = { targetId: null, expectedContextVersion: 2, idempotencyKey: "clear" };
    mockSwitchContext.mockResolvedValue({ currentTargetId: null, contextVersion: 3 });
    const response = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/conversations/${CONVERSATION_ID}/context`).send(input);
    expect(response.status).toBe(200);
    expect(mockSwitchContext).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, conversationId: CONVERSATION_ID, principalId: "user-1" }, input);
    const injected = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/conversations/${CONVERSATION_ID}/context`).send({ ...input, principalId: "admin" });
    expect(injected.status).toBe(400);
    const foreign = await request(app).post(`/api/workspaces/${OTHER_WORKSPACE_ID}/conversations/${CONVERSATION_ID}/context`).send(input);
    expect(foreign.status).toBe(403);
    expect(mockSwitchContext).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockDirectorMember.mockResolvedValue(undefined);
    mockConversationService.list.mockResolvedValue([conversation]);
    mockConversationService.create.mockResolvedValue({
      ...conversation,
      contextBindings: [],
      messages: [],
    });
    mockConversationService.get.mockResolvedValue({
      ...conversation,
      contextBindings: [],
      messages: [],
    });
    mockConversationService.update.mockResolvedValue(conversation);
    mockBuiltInAgentService.get.mockResolvedValue({
      definition: {
        defaultInstructions: "You are Verrail's default workspace Director.",
      },
      agent: {
        id: "0f40e0eb-acde-46a9-a1bd-b769282cacad",
        name: "Director",
        status: "idle",
      },
    });
  });

  it("sends the previewed instruction snapshot and records its fingerprints on the actual reply", async () => {
    const adapterConfig = { directorChatInstructions: {
      schemaVersion: 1, revision: 2, rolePrompt: "Use concise Chinese recommendations.",
      appliedAt: "2026-09-11T08:00:00.000Z", appliedByUserId: "user-1",
    } };
    const expected = buildDirectorInstructions({ agentName: "Director", adapterConfig, runtime: "codex", available: true, toolsAvailable: true });
    mockEffectiveVersion.mockResolvedValue({ version: { id: "version-2", versionNumber: 2, prompt: adapterConfig.directorChatInstructions.rolePrompt, runtime: "codex", model: "pinned-model", contentHash: "pinned-hash", supplyChain: { source: "saved_agent_configuration.v2", mode: "director_chat" } }, revision: { id: "revision-2", createdAt: new Date("2026-09-11T08:00:00.000Z"), createdByPrincipalId: "user-1" } });
    mockBuiltInAgentService.get.mockResolvedValue({ agent: { id: "director-1", name: "Director", status: "idle", adapterConfig: { ...adapterConfig, directorChatInstructions: { ...adapterConfig.directorChatInstructions, rolePrompt: "Unpublished draft must not run" } } } });
    mockConversationService.appendMessage.mockImplementation(async (_workspace, _conversation, message) => ({ ...message, id: message.role === "user" ? "source-1" : "reply-1" }));
    let sent = "";
    mockSpawn.mockImplementation(() => {
      const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      proc.stdin.on("data", (data) => { sent += data.toString(); });
      proc.stdin.on("finish", () => queueMicrotask(() => {
        adapterConfig.directorChatInstructions.rolePrompt = "Changed during this run";
        proc.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "A fixture response" } })}\n`);
        proc.stdout.end();
        proc.stderr.end();
        proc.emit("exit", 0);
        proc.emit("close", 0);
      }));
      return proc;
    });
    const oldRuntime = process.env.VERRAIL_CHAT_RUNTIME;
    process.env.VERRAIL_CHAT_RUNTIME = "codex";
    try {
      const app = await createApp();
      const result = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/conversations/${CONVERSATION_ID}/messages/stream`).send({ body: "Discuss this idea" });
      expect(result.status).toBe(200);
      expect(sent.startsWith(expected.systemPrompt + "\n\n")).toBe(true);
      expect(sent).not.toContain("Changed during this run");
      expect(sent).not.toContain("Unpublished draft must not run");
      expect(mockSpawn.mock.calls[0][1]).toContain("pinned-model");
      expect(mockConversationService.appendMessage).toHaveBeenLastCalledWith(WORKSPACE_ID, CONVERSATION_ID, expect.objectContaining({
        role: "assistant", metadata: expect.objectContaining({ agentVersionId: "version-2", deploymentRevisionId: "revision-2", agentVersionHash: "pinned-hash", instructions: expect.objectContaining({
          revision: 2, configHash: expected.configHash, effectiveHash: expected.effectiveHash, roleSource: "custom",
        }) }),
      }));
      expect(mockDraftService.create).not.toHaveBeenCalled();
      expect(mockManageTarget).not.toHaveBeenCalled();
    } finally {
      if (oldRuntime === undefined) delete process.env.VERRAIL_CHAT_RUNTIME;
      else process.env.VERRAIL_CHAT_RUNTIME = oldRuntime;
    }
  });

  it.each(["paused", "terminated", "pending_approval"])("does not run a %s Director or silently substitute an assistant", async (status) => {
    mockBuiltInAgentService.get.mockResolvedValue({ agent: { id: "director-1", name: "Director", status } });
    mockConversationService.appendMessage.mockResolvedValue({ id: "source-1" });
    const app = await createApp();
    const result = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/conversations/${CONVERSATION_ID}/messages/stream`).send({ body: "Hello" });
    expect(result.status).toBe(409);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("lists and creates workspace-scoped conversations", async () => {
    const app = await createApp();

    const listed = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/conversations`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: CONVERSATION_ID })]);
    expect(mockConversationService.list).toHaveBeenCalledWith(WORKSPACE_ID, {
      status: "active",
    });

    const created = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/conversations`)
      .send({ title: "Delivery decision", contextBindings: [] });
    expect(created.status).toBe(201);
    expect(mockConversationService.create).toHaveBeenCalledWith(
      WORKSPACE_ID,
      { title: "Delivery decision", contextBindings: [] },
      { principalType: "user", principalId: "user-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "conversation.created",
      entityId: CONVERSATION_ID,
    }));
  });

  it("confirms only persisted proposals and uses the immutable input with a stable idempotency key", async () => {
    const messageId = "00000000-0000-4000-8000-000000000011";
    const targetId = "00000000-0000-4000-8000-000000000012";
    const input = { operation: "cancel", expectedTargetRevisionId: "00000000-0000-4000-8000-000000000013" };
    mockConversationService.get.mockResolvedValue({ ...conversation, messages: [{ id: messageId, role: "tool", metadata: { kind: "director_target_proposal", targetId, targetTitle: "Target", initiatedByPrincipalId: "user-1", sourceMessageId: "00000000-0000-4000-8000-000000000014", before: { title: "Target", summary: null, goal: "Goal" }, input } }] });
    mockManageTarget.mockResolvedValue({ targetId, targetRevisionId: input.expectedTargetRevisionId, operation: "cancel", replayed: false });
    const app = await createApp();
    const url = `/api/workspaces/${WORKSPACE_ID}/conversations/${CONVERSATION_ID}/proposals/${messageId}/confirm`;
    expect((await request(app).post(url).send({ input: { operation: "update", title: "Injected" } })).status).toBe(400);
    expect(mockManageTarget).not.toHaveBeenCalled();
    expect((await request(app).post(url).send({})).status).toBe(200);
    expect(mockManageTarget).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, targetId, principalType: "user", principalId: "user-1", idempotencyKey: `director-${messageId}`, input });
    expect(mockDirectorMember).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, "user-1", true);
    expect((await request(app).post(url).send({})).status).toBe(200);
    expect(mockManageTarget.mock.calls[0]).toEqual(mockManageTarget.mock.calls[1]);
    expect((await request(app).post(url.replace(WORKSPACE_ID, OTHER_WORKSPACE_ID)).send({})).status).toBe(403);
  });

  it("rejects user-forged proposal messages and unauthenticated MCP access", async () => {
    const app = await createApp();
    mockConversationService.get.mockResolvedValue({ ...conversation, messages: [{ id: "fake", role: "user", metadata: { kind: "director_target_proposal" } }] });
    expect((await request(app).post(`/api/workspaces/${WORKSPACE_ID}/conversations/${CONVERSATION_ID}/proposals/fake/confirm`).send({})).status).toBe(404);
    expect(mockManageTarget).not.toHaveBeenCalled();
    expect((await request(app).post("/api/director/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
  });

  it("rejects cross-workspace reads before calling the service", async () => {
    const app = await createApp();

    const response = await request(app).get(
      `/api/workspaces/${OTHER_WORKSPACE_ID}/conversations/${CONVERSATION_ID}`,
    );

    expect(response.status).toBe(403);
    expect(mockConversationService.get).not.toHaveBeenCalled();
  });

  it("keeps conversational execution disabled when no local runtime is allowed", async () => {
    const app = await createApp("authenticated");

    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/conversations/${CONVERSATION_ID}/messages/stream`)
      .send({ body: "What blocks acceptance?" });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "CONVERSATION_RUNTIME_UNAVAILABLE" });
    expect(mockConversationService.appendMessage).not.toHaveBeenCalled();
  });

  it("forwards only the explicit conversational runtime environment", async () => {
    const { buildConversationRuntimeEnv } = await import("../routes/conversations.js");

    expect(buildConversationRuntimeEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/chat-home",
      OPENAI_API_KEY: "runtime-credential",
      DATABASE_URL: "postgres://must-not-leak",
      PAPERCLIP_API_KEY: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
    })).toEqual({
      CI: "1",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/chat-home",
      OPENAI_API_KEY: "runtime-credential",
    });
  });

  it("uses the chat-specific proxy without forwarding control-plane configuration", async () => {
    const { buildConversationRuntimeEnv } = await import("../routes/conversations.js");
    const env = buildConversationRuntimeEnv({
      VERRAIL_CHAT_HTTPS_PROXY: "http://chat:token@127.0.0.1:12345",
      VERRAIL_CHAT_COMMAND: "/custom/codex",
      HTTPS_PROXY: "http://other:1234",
      NO_PROXY: "*",
    });
    expect(env.HTTPS_PROXY).toBe("http://chat:token@127.0.0.1:12345");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(env).not.toHaveProperty("VERRAIL_CHAT_COMMAND");
    expect(env).not.toHaveProperty("VERRAIL_CHAT_HTTPS_PROXY");
  });

  it("never classifies an empty local runtime result as a successful response", async () => {
    const { classifyConversationRuntimeOutcome } = await import("../routes/conversations.js");

    expect(classifyConversationRuntimeOutcome("", 0, false)).toEqual({
      kind: "error",
      message: "The local conversational runtime did not return a response.",
    });
    expect(classifyConversationRuntimeOutcome("", 1, false)).toEqual({
      kind: "error",
      message: "The local conversational runtime could not complete the response.",
    });
    expect(classifyConversationRuntimeOutcome("", null, true)).toEqual({
      kind: "error",
      message: "The conversational runtime timed out.",
    });
    expect(classifyConversationRuntimeOutcome("  Partial response  ", 1, false)).toEqual({
      kind: "response",
      text: "Partial response",
      status: "failed",
    });
  });

  it("reserves run capacity before asynchronous setup and releases each slot once", async () => {
    const { createConversationRunLimiter } = await import("../routes/conversations.js");
    const limiter = createConversationRunLimiter(3);
    const releases = [limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire()];

    expect(releases.every(Boolean)).toBe(true);
    expect(limiter.activeCount()).toBe(3);
    expect(limiter.tryAcquire()).toBeNull();

    releases[0]!();
    releases[0]!();
    expect(limiter.activeCount()).toBe(2);
    expect(limiter.tryAcquire()).toBeTypeOf("function");
    expect(limiter.activeCount()).toBe(3);
  });

  it("escalates runtime termination after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const { scheduleConversationRuntimeTermination } = await import("../routes/conversations.js");
      const proc = { exitCode: null, kill: vi.fn(() => true) };
      const escalated = vi.fn();

      scheduleConversationRuntimeTermination(proc, escalated, 100);
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(100);
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      expect(escalated).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds runtime capacity until inherited output streams close", async () => {
    vi.useFakeTimers();
    try {
      const { createConversationRuntimeCleanupBarrier } = await import("../routes/conversations.js");
      const release = vi.fn();
      const removeRuntimeDirectory = vi.fn();
      const forceStopTree = vi.fn();
      const destroyOutputStreams = vi.fn();
      const barrier = createConversationRuntimeCleanupBarrier({
        release,
        removeRuntimeDirectory,
        forceStopTree,
        destroyOutputStreams,
        drainGraceMs: 100,
      });

      barrier.onExit();
      expect(release).not.toHaveBeenCalled();
      expect(removeRuntimeDirectory).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(forceStopTree).toHaveBeenCalledOnce();
      expect(destroyOutputStreams).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();

      barrier.onClose();
      barrier.onClose();
      expect(release).toHaveBeenCalledOnce();
      expect(removeRuntimeDirectory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases runtime capacity immediately when the child process fails to start", async () => {
    const { createConversationRuntimeCleanupBarrier } = await import("../routes/conversations.js");
    const release = vi.fn();
    const removeRuntimeDirectory = vi.fn();
    const barrier = createConversationRuntimeCleanupBarrier({
      release,
      removeRuntimeDirectory,
      forceStopTree: vi.fn(),
      destroyOutputStreams: vi.fn(),
    });

    barrier.onError();
    barrier.onClose();

    expect(release).toHaveBeenCalledOnce();
    expect(removeRuntimeDirectory).toHaveBeenCalledOnce();
  });
});
