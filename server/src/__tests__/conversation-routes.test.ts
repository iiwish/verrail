import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConversationService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  appendMessage: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  conversationService: () => mockConversationService,
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
  app.use("/api", conversationRoutes({} as any, { deploymentMode }));
  app.use(errorHandler);
  return app;
}

describe("conversation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
