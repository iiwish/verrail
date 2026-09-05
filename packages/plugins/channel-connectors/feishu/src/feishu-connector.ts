import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type {
  ChannelConnectionBindingV1,
  ChannelReplyRequestV1,
  ChannelReplyResultV1,
  ChannelWebhookRequestV1,
  ChannelWebhookResultV1,
  EnvSecretRefBinding,
} from "@paperclipai/shared";
import { channelConnectionBindingV1Schema } from "@paperclipai/shared";
import { FEISHU_CONNECTOR_KEY } from "./manifest.js";

type SecretRef = string | EnvSecretRefBinding;

export interface FeishuConnection extends ChannelConnectionBindingV1 {
  configPath: string;
  appId: string;
  appSecretRef: SecretRef;
  verificationTokenRef: SecretRef | null;
  encryptKeyRef: SecretRef | null;
}

export interface FeishuConnectorDependencies {
  getConfig(workspaceId: string): Promise<Record<string, unknown>>;
  resolveSecret(
    secretRef: SecretRef,
    options: { companyId: string; configPath: string },
  ): Promise<string>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export class FeishuWebhookError extends Error {
  constructor(
    readonly code:
      | "connection_not_configured"
      | "signature_missing"
      | "signature_invalid"
      | "payload_invalid"
      | "decryption_failed"
      | "verification_token_invalid"
      | "app_id_invalid"
      | "provider_request_failed",
    message: string,
  ) {
    super(message);
    this.name = "FeishuWebhookError";
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FeishuWebhookError("connection_not_configured", `${name} is required`);
  }
  return value;
}

function requiredSecretRef(value: unknown, name: string): SecretRef {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === "secret_ref"
    && typeof (value as { secretId?: unknown }).secretId === "string"
  ) {
    return value as EnvSecretRefBinding;
  }
  throw new FeishuWebhookError("connection_not_configured", `${name} must be a secret_ref`);
}

export function findConnection(config: Record<string, unknown>, connectionId: string): FeishuConnection {
  const rawConnections = config.channelConnections;
  if (!Array.isArray(rawConnections)) {
    throw new FeishuWebhookError("connection_not_configured", "channelConnections is required");
  }
  const index = rawConnections.findIndex((candidate) => (
    typeof candidate === "object"
    && candidate !== null
    && (candidate as { connectionId?: unknown }).connectionId === connectionId
  ));
  const parsed = channelConnectionBindingV1Schema.safeParse(rawConnections[index]);
  if (!parsed.success || parsed.data.connectorKey !== FEISHU_CONNECTOR_KEY) {
    throw new FeishuWebhookError("connection_not_configured", "Feishu connection is not configured");
  }
  return {
    ...parsed.data,
    configPath: `channelConnections.${index}`,
    appId: requiredString(parsed.data.appId, "appId"),
    appSecretRef: requiredSecretRef(parsed.data.appSecretRef, "appSecretRef"),
    verificationTokenRef: parsed.data.transport === "long_connection" ? null : requiredSecretRef(parsed.data.verificationTokenRef, "verificationTokenRef"),
    encryptKeyRef: parsed.data.transport === "long_connection" ? null : requiredSecretRef(parsed.data.encryptKeyRef, "encryptKeyRef"),
  };
}

function header(headers: Record<string, string | string[]>, key: string) {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function equalSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySignature(input: ChannelWebhookRequestV1, encryptKey: string) {
  const timestamp = header(input.headers, "x-lark-request-timestamp");
  const nonce = header(input.headers, "x-lark-request-nonce");
  const signature = header(input.headers, "x-lark-signature");
  if (!timestamp || !nonce || !signature) {
    throw new FeishuWebhookError("signature_missing", "Feishu signature headers are required");
  }
  const expected = createHash("sha256")
    .update(`${timestamp}${nonce}${encryptKey}${input.rawBody}`)
    .digest("hex");
  if (!equalSecret(signature, expected)) {
    throw new FeishuWebhookError("signature_invalid", "Feishu signature is invalid");
  }
}

function parseObject(value: string, code: "payload_invalid" | "decryption_failed") {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new FeishuWebhookError(code, code === "payload_invalid" ? "Feishu payload is invalid" : "Feishu payload decryption failed");
  }
}

function decryptPayload(encrypt: string, encryptKey: string) {
  try {
    const key = createHash("sha256").update(encryptKey).digest();
    const payload = Buffer.from(encrypt, "base64");
    if (payload.length <= 16) throw new Error();
    const decipher = createDecipheriv("aes-256-cbc", key, payload.subarray(0, 16));
    return parseObject(
      Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString("utf8"),
      "decryption_failed",
    );
  } catch (error) {
    if (error instanceof FeishuWebhookError) throw error;
    throw new FeishuWebhookError("decryption_failed", "Feishu payload decryption failed");
  }
}

function nestedObject(parent: Record<string, unknown>, key: string) {
  const value = parent[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function occurredAt(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseMessage(payload: Record<string, unknown>, appId: string): ChannelWebhookResultV1 {
  const headerValue = nestedObject(payload, "header");
  const event = nestedObject(payload, "event");
  const providerEventId = typeof headerValue?.event_id === "string" ? headerValue.event_id : null;
  if (headerValue?.app_id !== appId) {
    throw new FeishuWebhookError("app_id_invalid", "Feishu app id does not match the connection");
  }
  if (headerValue?.event_type !== "im.message.receive_v1" || !event) {
    return { kind: "ignored", contractVersion: 1, reason: "unsupported_event", providerEventId };
  }
  const sender = nestedObject(event, "sender");
  const senderId = sender ? nestedObject(sender, "sender_id") : null;
  const message = nestedObject(event, "message");
  if (sender?.sender_type !== "user") {
    return { kind: "ignored", contractVersion: 1, reason: "bot_message", providerEventId };
  }
  if (!providerEventId || !senderId || !message) {
    throw new FeishuWebhookError("payload_invalid", "Feishu message identity is incomplete");
  }
  if (message.message_type !== "text" || typeof message.content !== "string") {
    return { kind: "ignored", contractVersion: 1, reason: "unsupported_content", providerEventId };
  }
  const content = parseObject(message.content, "payload_invalid");
  const text = typeof content.text === "string" ? content.text.trim() : "";
  const externalConversationId = requiredString(message.chat_id, "event.message.chat_id");
  const providerUserId = requiredString(senderId.open_id ?? senderId.user_id ?? senderId.union_id, "event.sender.sender_id");
  const providerMessageId = requiredString(message.message_id, "event.message.message_id");
  if (!text) throw new FeishuWebhookError("payload_invalid", "Feishu text message is empty");
  const intent = /^\/verrail\s+target\s+create(?:\s|$)/i.test(text)
    ? { kind: "create_target_draft" as const }
    : null;
  return {
    kind: "message",
    contractVersion: 1,
    providerEventId,
    occurredAt: occurredAt(headerValue?.create_time),
    conversation: {
      externalConversationId,
      type: message.chat_type === "p2p" ? "direct" : "group",
    },
    author: { providerUserId },
    content: { kind: "text", text },
    intent,
    replyContext: { providerMessageId },
  };
}

export function normalizeLongConnectionMessage(data: unknown, appId: string): ChannelWebhookResultV1 {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new FeishuWebhookError("payload_invalid", "Invalid Feishu event");
  }
  const event = data as Record<string, unknown>;
  // EventDispatcher flattens the provider's v2 header and event fields.
  return parseMessage({ header: event, event }, appId);
}

async function providerJson(response: Response) {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body || (typeof body.code === "number" && body.code !== 0)) {
    throw new FeishuWebhookError("provider_request_failed", "Feishu request failed");
  }
  return body;
}

export function createFeishuConnector(dependencies: FeishuConnectorDependencies) {
  async function connection(workspaceId: string, connectionId: string) {
    return findConnection(await dependencies.getConfig(workspaceId), connectionId);
  }

  return {
    async handleWebhook(input: ChannelWebhookRequestV1): Promise<ChannelWebhookResultV1> {
      if (input.contractVersion !== 1 || input.connectorKey !== FEISHU_CONNECTOR_KEY) {
        throw new FeishuWebhookError("connection_not_configured", "Unsupported Channel Connector contract");
      }
      const current = await connection(input.workspaceId, input.connectionId);
      if (!current.encryptKeyRef || !current.verificationTokenRef) {
        throw new FeishuWebhookError("connection_not_configured", "This connection does not accept Webhooks");
      }
      const [encryptKey, verificationToken] = await Promise.all([
        dependencies.resolveSecret(current.encryptKeyRef, {
          companyId: input.workspaceId,
          configPath: `${current.configPath}.encryptKeyRef`,
        }),
        dependencies.resolveSecret(current.verificationTokenRef, {
          companyId: input.workspaceId,
          configPath: `${current.configPath}.verificationTokenRef`,
        }),
      ]);
      verifySignature(input, encryptKey);
      const outer = parseObject(input.rawBody, "payload_invalid");
      const payload = typeof outer.encrypt === "string"
        ? decryptPayload(outer.encrypt, encryptKey)
        : outer;
      const token = nestedObject(payload, "header")?.token ?? payload.token;
      if (typeof token !== "string" || !equalSecret(token, verificationToken)) {
        throw new FeishuWebhookError("verification_token_invalid", "Feishu verification token is invalid");
      }
      if (payload.type === "url_verification" && typeof payload.challenge === "string") {
        return { kind: "challenge", contractVersion: 1, challenge: payload.challenge };
      }
      return parseMessage(payload, current.appId);
    },

    async sendReply(input: ChannelReplyRequestV1): Promise<ChannelReplyResultV1> {
      const current = await connection(input.workspaceId, input.connectionId);
      const appSecret = await dependencies.resolveSecret(current.appSecretRef, {
        companyId: input.workspaceId,
        configPath: `${current.configPath}.appSecretRef`,
      });
      const tokenBody = await providerJson(await dependencies.fetch(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ app_id: current.appId, app_secret: appSecret }),
        },
      ));
      const token = requiredString(tokenBody.tenant_access_token, "tenant_access_token");
      const replyBody = await providerJson(await dependencies.fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(input.replyContext.providerMessageId)}/reply`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            msg_type: "text",
            content: JSON.stringify({ text: input.text }),
            uuid: input.idempotencyKey,
          }),
        },
      ));
      const data = nestedObject(replyBody, "data");
      return {
        contractVersion: 1,
        providerMessageId: requiredString(data?.message_id, "data.message_id"),
      };
    },
  };
}
