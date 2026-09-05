import { describe, expect, it, vi } from "vitest";
import { normalizedContentHash } from "@paperclipai/shared/portability-hash";
import { createChannelConnectorIngress } from "../services/channel-connector-ingress.js";

const workspaceId = "86679997-3f3a-4477-a2fa-d4da812140ae";
const connection = {
  contractVersion: 1, connectorKey: "feishu", connectionId: "test",
  transport: "long_connection", appId: "cli_test",
  authorizedUsers: [{ providerUserId: "ou_test", userId: "human" }],
};
const event = {
  kind: "message", contractVersion: 1, providerEventId: "evt1", occurredAt: null,
  conversation: { type: "direct", externalConversationId: "oc_test" },
  author: { providerUserId: "ou_test" }, content: { kind: "text", text: "/verrail target create" },
  intent: { kind: "create_target_draft" }, replyContext: { providerMessageId: "om_test" },
};
function setup() {
  const deps = {
    getPlugin: vi.fn().mockResolvedValue({ status: "ready", manifestJson: { channelConnectors: [{ contractVersion: 1, connectorKey: "feishu" }] } }),
    getConfig: vi.fn().mockResolvedValue({ channelConnections: [connection] }),
    ingest: vi.fn().mockResolvedValue({ duplicate: false, conversationId: "conversation", messageId: "message", draftId: "draft", authorizedUserId: "human", replyProviderMessageId: null }),
    sendReply: vi.fn().mockResolvedValue({ contractVersion: 1, providerMessageId: "om_reply" }),
    recordReply: vi.fn().mockResolvedValue("om_reply"),
  };
  const input = { contractVersion: 1, workspaceId, connectorKey: "feishu", connectionId: "test", configurationFingerprint: normalizedContentHash(connection), event: structuredClone(event) };
  return { deps, input, ingest: createChannelConnectorIngress(deps) };
}

describe("configured worker channel ingress", () => {
  it("binds ingress and reply to the host-owned workspace configuration", async () => {
    const { deps, input, ingest } = setup();
    await expect(ingest(input)).resolves.toMatchObject({ draftId: "draft", replyProviderMessageId: "om_reply" });
    expect(deps.getConfig).toHaveBeenCalledWith(workspaceId);
    expect(deps.ingest).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, connection, event }));
    expect(deps.sendReply).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, idempotencyKey: "verrail:draft", replyContext: event.replyContext }));
    expect(deps.recordReply).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, providerEventId: "evt1", providerMessageId: "om_reply" }));
  });
  it.each(["unconfigured", "undeclared", "disabled", "webhook", "stale"])("rejects %s connections without writing", async (kind) => {
    const { deps, input, ingest } = setup();
    if (kind === "unconfigured") deps.getConfig.mockResolvedValue({ channelConnections: [] });
    if (kind === "undeclared") deps.getPlugin.mockResolvedValue({ status: "ready", manifestJson: {} });
    if (kind === "disabled") deps.getPlugin.mockResolvedValue({ status: "disabled", manifestJson: { channelConnectors: [{ contractVersion: 1, connectorKey: "feishu" }] } });
    if (kind === "webhook") deps.getConfig.mockResolvedValue({ channelConnections: [{ ...connection, transport: "webhook" }] });
    if (kind === "stale") deps.getConfig.mockResolvedValue({ channelConnections: [{ ...connection, appId: "another-app" }] });
    await expect(ingest(input)).rejects.toThrow();
    expect(deps.ingest).not.toHaveBeenCalled();
  });
  it.each(["unmapped", "group"])("rejects %s messages before writing", async (kind) => {
    const { deps, input, ingest } = setup();
    if (kind === "unmapped") input.event.author.providerUserId = "unknown";
    if (kind === "group") input.event.conversation.type = "group";
    await expect(ingest(input)).rejects.toThrow();
    expect(deps.ingest).not.toHaveBeenCalled();
  });
  it("does not repeat a recorded reply", async () => {
    const { deps, input, ingest } = setup();
    deps.ingest.mockResolvedValue({ duplicate: true, draftId: "draft", replyProviderMessageId: "om_existing" });
    await expect(ingest(input)).resolves.toMatchObject({ replyProviderMessageId: "om_existing" });
    expect(deps.sendReply).not.toHaveBeenCalled();
  });
});
