import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
}));
const mockIngest = vi.hoisted(() => vi.fn());
const mockRecordReply = vi.hoisted(() => vi.fn());

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));
vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));
vi.mock("../services/issues.js", () => ({
  issueService: () => ({}),
}));
vi.mock("../services/channel-connector-host.js", () => ({
  channelConnectorHostService: () => ({ ingest: mockIngest, recordReply: mockRecordReply }),
}));

function fakeDb() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "33333333-3333-4333-8333-333333333333" }]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updates.push(value);
        return { where: vi.fn(async () => []) };
      }),
    })),
  };
}

async function appWith(workerManager: { call: ReturnType<typeof vi.fn> }) {
  const { pluginRoutes } = await import("../routes/plugins.js");
  const db = fakeDb();
  const app = express();
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));
  app.use("/api", pluginRoutes(
    db as never,
    { installPlugin: vi.fn() } as never,
    undefined,
    { workerManager } as never,
  ));
  return { app, db };
}

describe("plugin Channel Connector webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const manifestJson = {
      id: "verrail.channel-connector-feishu",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Feishu",
      description: "Feishu channel",
      author: "Verrail",
      categories: ["connector"],
      capabilities: ["webhooks.receive"],
      entrypoints: { worker: "dist/worker.js" },
      webhooks: [{ endpointKey: "events", displayName: "Events" }],
      channelConnectors: [{
        contractVersion: 1,
        connectorKey: "feishu",
        providerKey: "feishu",
        webhookEndpointKey: "events",
      }],
    };
    const plugin = { id: pluginId, pluginKey: manifestJson.id, status: "ready", manifestJson };
    mockRegistry.getById.mockResolvedValue(plugin);
    mockRegistry.getByKey.mockResolvedValue(plugin);
    mockRegistry.getConfig.mockResolvedValue({
      configJson: {
        channelConnections: [{
          contractVersion: 1,
          connectorKey: "feishu",
          connectionId: "primary",
          authorizedUsers: [{ providerUserId: "ou_1", userId: "user-1" }],
        }],
      },
    });
  });

  it("returns an authenticated challenge without calling the Host ingestion service", async () => {
    const workerManager = { call: vi.fn().mockResolvedValue({
      kind: "challenge",
      contractVersion: 1,
      challenge: "challenge-1",
    }) };
    const { app, db } = await appWith(workerManager);
    const response = await request(app)
      .post(`/api/plugins/${pluginId}/channel-connectors/feishu/${workspaceId}/primary/webhook`)
      .send({ challenge: "provider-payload" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ challenge: "challenge-1" });
    expect(mockIngest).not.toHaveBeenCalled();
    expect(db.updates).toContainEqual(expect.objectContaining({ status: "success" }));
  });

  it("ingests a normalized message, creates one draft reply, and never forwards raw data to core", async () => {
    const normalized = {
      kind: "message",
      contractVersion: 1,
      providerEventId: "evt-1",
      occurredAt: null,
      conversation: { externalConversationId: "oc_1", type: "group" },
      author: { providerUserId: "ou_1" },
      content: { kind: "text", text: "/verrail target create" },
      intent: { kind: "create_target_draft" },
      replyContext: { providerMessageId: "om_1" },
    };
    const workerManager = {
      call: vi.fn()
        .mockResolvedValueOnce(normalized)
        .mockResolvedValueOnce({ contractVersion: 1, providerMessageId: "om_reply" }),
    };
    mockIngest.mockResolvedValue({
      duplicate: false,
      conversationId: "44444444-4444-4444-8444-444444444444",
      messageId: "55555555-5555-4555-8555-555555555555",
      draftId: "66666666-6666-4666-8666-666666666666",
      authorizedUserId: "user-1",
      replyProviderMessageId: null,
    });
    const { app } = await appWith(workerManager);
    const response = await request(app)
      .post(`/api/plugins/${pluginId}/channel-connectors/feishu/${workspaceId}/primary/webhook`)
      .set("authorization", "Bearer must-not-reach-plugin")
      .send({ secretProviderField: "must-not-reach-core" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "success", replyDeliveryId: "om_reply" });
    expect(mockIngest).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      connectorKey: "feishu",
      connectionId: "primary",
      event: normalized,
    }));
    expect(JSON.stringify(mockIngest.mock.calls)).not.toContain("secretProviderField");
    expect(JSON.stringify(workerManager.call.mock.calls[0])).not.toContain("must-not-reach-plugin");
    expect(workerManager.call).toHaveBeenNthCalledWith(2, pluginId, "handleChannelReply", expect.objectContaining({
      idempotencyKey: "verrail:66666666-6666-4666-8666-666666666666",
    }));
    expect(mockRecordReply).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: "om_reply" }));
  });

  it("returns the recorded reply for a replayed event without sending another reply", async () => {
    const normalized = {
      kind: "message",
      contractVersion: 1,
      providerEventId: "evt-1",
      occurredAt: null,
      conversation: { externalConversationId: "oc_1", type: "group" },
      author: { providerUserId: "ou_1" },
      content: { kind: "text", text: "/verrail target create" },
      intent: { kind: "create_target_draft" },
      replyContext: { providerMessageId: "om_1" },
    };
    const workerManager = { call: vi.fn().mockResolvedValue(normalized) };
    mockIngest.mockResolvedValue({
      duplicate: true,
      conversationId: "44444444-4444-4444-8444-444444444444",
      messageId: "55555555-5555-4555-8555-555555555555",
      draftId: "66666666-6666-4666-8666-666666666666",
      authorizedUserId: "user-1",
      replyProviderMessageId: "om_reply",
    });

    const { app } = await appWith(workerManager);
    const response = await request(app)
      .post(`/api/plugins/${pluginId}/channel-connectors/feishu/${workspaceId}/primary/webhook`)
      .send({ event_id: "evt-1" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "duplicate",
      replyDeliveryId: "om_reply",
    });
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(mockRecordReply).not.toHaveBeenCalled();
  });

  it("fails closed when the plugin rejects authentication", async () => {
    const workerManager = { call: vi.fn().mockRejectedValue(new Error("signature invalid")) };
    const { app, db } = await appWith(workerManager);
    const response = await request(app)
      .post(`/api/plugins/${pluginId}/channel-connectors/feishu/${workspaceId}/primary/webhook`)
      .send({ event: "untrusted" });
    expect(response.status).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });
});
