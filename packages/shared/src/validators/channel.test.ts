import { describe, expect, it } from "vitest";
import {
  channelConnectionBindingV1Schema,
  channelWebhookResultV1Schema,
  channelReplyReadRequestV1Schema,
  channelReplyReadResultV1Schema,
} from "./channel.js";

describe("Channel Connector V1 validators", () => {
  it("keeps reply read references closed and rejects paths or supplied success facts", () => {
    const input = { contractVersion: 1, workspaceId: "11111111-1111-4111-8111-111111111111", connectionId: "primary", connectorKey: "feishu",
      providerMessageId: "om_reply", parentProviderMessageId: "om_parent", externalConversationId: "oc_chat" };
    expect(channelReplyReadRequestV1Schema.parse(input)).toEqual(input);
    for (const patch of [{ providerMessageId: "../messages" }, { workspaceId: "other" }, { succeeded: true }, { parentProviderMessageId: "" }]) {
      expect(channelReplyReadRequestV1Schema.safeParse({ ...input, ...patch }).success).toBe(false);
    }
  });
  it("keeps reply observations closed without Provider text or credentials", () => {
    const result = { contractVersion: 1, providerMessageId: "om_reply", parentProviderMessageId: "om_parent", externalConversationId: "oc_chat",
      bodySha256: "a".repeat(64), createdAt: "2026-09-09T00:00:00.000Z" };
    expect(channelReplyReadResultV1Schema.parse(result)).toEqual(result);
    for (const patch of [{ bodySha256: "unknown" }, { createdAt: "today" }, { text: "private" }, { token: "private" }]) {
      expect(channelReplyReadResultV1Schema.safeParse({ ...result, ...patch }).success).toBe(false);
    }
  });
  it("accepts a normalized message without provider payload fields", () => {
    expect(channelWebhookResultV1Schema.parse({
      kind: "message",
      contractVersion: 1,
      providerEventId: "evt-1",
      occurredAt: null,
      conversation: { externalConversationId: "chat-1", type: "group" },
      author: { providerUserId: "user-1" },
      content: { kind: "text", text: "hello" },
      intent: null,
      replyContext: { providerMessageId: "message-1" },
    })).toMatchObject({ kind: "message", contractVersion: 1 });
  });

  it("rejects duplicate provider-user mappings", () => {
    const result = channelConnectionBindingV1Schema.safeParse({
      contractVersion: 1,
      connectorKey: "feishu",
      connectionId: "primary",
      authorizedUsers: [
        { providerUserId: "ou_1", userId: "local-1" },
        { providerUserId: "ou_1", userId: "local-2" },
      ],
    });
    expect(result.success).toBe(false);
  });
});
