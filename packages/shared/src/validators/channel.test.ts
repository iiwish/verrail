import { describe, expect, it } from "vitest";
import {
  channelConnectionBindingV1Schema,
  channelWebhookResultV1Schema,
} from "./channel.js";

describe("Channel Connector V1 validators", () => {
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
