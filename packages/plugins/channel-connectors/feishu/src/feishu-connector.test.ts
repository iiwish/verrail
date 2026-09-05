import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChannelWebhookRequestV1, EnvSecretRefBinding } from "@paperclipai/shared";
import { createFeishuConnector } from "./feishu-connector.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "feishu-primary";
const encryptKey = "test-encrypt-key";
const verificationToken = "test-verification-token";
const appSecret = "test-app-secret";

function secret(secretId: string): EnvSecretRefBinding {
  return { type: "secret_ref", secretId };
}

function config() {
  return {
    channelConnections: [{
      contractVersion: 1,
      connectorKey: "feishu",
      connectionId,
      appId: "cli_test",
      appSecretRef: secret("app-secret"),
      verificationTokenRef: secret("verification-token"),
      encryptKeyRef: secret("encrypt-key"),
      authorizedUsers: [{ providerUserId: "ou_human", userId: "local-human" }],
    }],
  };
}

function signature(rawBody: string, timestamp = "1725440000", nonce = "nonce-1") {
  return createHash("sha256").update(`${timestamp}${nonce}${encryptKey}${rawBody}`).digest("hex");
}

function request(rawBody: string): ChannelWebhookRequestV1 {
  return {
    contractVersion: 1,
    workspaceId,
    connectionId,
    connectorKey: "feishu",
    endpointKey: "events",
    requestId: "22222222-2222-4222-8222-222222222222",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    headers: {
      "x-lark-request-timestamp": "1725440000",
      "x-lark-request-nonce": "nonce-1",
      "x-lark-signature": signature(rawBody),
    },
  };
}

function encryptedBody(payload: Record<string, unknown>) {
  const iv = Buffer.alloc(16, 7);
  const key = createHash("sha256").update(encryptKey).digest();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]);
  return JSON.stringify({ encrypt: encrypted.toString("base64") });
}

function connector(fetch = vi.fn<typeof globalThis.fetch>()) {
  return createFeishuConnector({
    getConfig: async () => config(),
    resolveSecret: async (ref, options) => {
      const id = typeof ref === "string" ? ref : ref.secretId;
      const field = { "app-secret": "appSecretRef", "verification-token": "verificationTokenRef", "encrypt-key": "encryptKeyRef" }[id];
      expect(options).toEqual({ companyId: workspaceId, configPath: `channelConnections.0.${field}` });
      return {
        "app-secret": appSecret,
        "verification-token": verificationToken,
        "encrypt-key": encryptKey,
      }[id]!;
    },
    fetch,
  });
}

describe("Feishu Channel Connector V1", () => {
  it("answers an authenticated URL challenge", async () => {
    const rawBody = JSON.stringify({
      type: "url_verification",
      token: verificationToken,
      challenge: "challenge-value",
    });
    await expect(connector().handleWebhook(request(rawBody))).resolves.toEqual({
      kind: "challenge",
      contractVersion: 1,
      challenge: "challenge-value",
    });
  });

  it("fails closed before parsing when the signature is invalid", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", token: verificationToken, challenge: "x" });
    const input = request(rawBody);
    input.headers["x-lark-signature"] = "not-valid";
    await expect(connector().handleWebhook(input)).rejects.toMatchObject({
      code: "signature_invalid",
    });
  });

  it("decrypts and normalizes an explicit group Target draft command", async () => {
    const rawBody = encryptedBody({
      schema: "2.0",
      header: {
        event_id: "evt-1",
        event_type: "im.message.receive_v1",
        app_id: "cli_test",
        token: verificationToken,
        create_time: "1725440000000",
      },
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_human" } },
        message: {
          message_id: "om_1",
          chat_id: "oc_group",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "/verrail target create" }),
        },
      },
    });
    await expect(connector().handleWebhook(request(rawBody))).resolves.toMatchObject({
      kind: "message",
      providerEventId: "evt-1",
      conversation: { externalConversationId: "oc_group", type: "group" },
      author: { providerUserId: "ou_human" },
      content: { kind: "text", text: "/verrail target create" },
      intent: { kind: "create_target_draft" },
      replyContext: { providerMessageId: "om_1" },
    });
  });

  it("normalizes an ordinary direct message without creating intent", async () => {
    const rawBody = encryptedBody({
      schema: "2.0",
      header: {
        event_id: "evt-2",
        event_type: "im.message.receive_v1",
        app_id: "cli_test",
        token: verificationToken,
      },
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_guest" } },
        message: {
          message_id: "om_2",
          chat_id: "oc_direct",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello Verrail" }),
        },
      },
    });
    await expect(connector().handleWebhook(request(rawBody))).resolves.toMatchObject({
      kind: "message",
      conversation: { type: "direct" },
      intent: null,
    });
  });

  it("uses the provider reply idempotency field and returns the delivery id", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply" } }), { status: 200 }));
    await expect(connector(fetch).sendReply({
      contractVersion: 1,
      workspaceId,
      connectionId,
      connectorKey: "feishu",
      replyContext: { providerMessageId: "om_1" },
      text: "Draft ready",
      idempotencyKey: "draft-1",
    })).resolves.toEqual({ contractVersion: 1, providerMessageId: "om_reply" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const replyInit = fetch.mock.calls[1]![1]!;
    expect(JSON.parse(String(replyInit.body))).toEqual({
      msg_type: "text",
      content: JSON.stringify({ text: "Draft ready" }),
      uuid: "draft-1",
    });
    expect(JSON.stringify(fetch.mock.calls[1])).not.toContain(appSecret);
  });
});
