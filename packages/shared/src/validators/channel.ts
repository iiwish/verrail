import { z } from "zod";

const safeKey = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/);

export const channelConnectorDeclarationV1Schema = z.object({
  contractVersion: z.literal(1),
  connectorKey: safeKey,
  providerKey: safeKey,
  webhookEndpointKey: safeKey,
}).strict();

export const channelAuthorizedUserBindingV1Schema = z.object({
  providerUserId: z.string().min(1).max(300),
  userId: z.string().min(1).max(300),
}).strict();

export const channelConnectionBindingV1Schema = z.object({
  contractVersion: z.literal(1),
  connectorKey: safeKey,
  connectionId: z.string().min(1).max(200),
  authorizedUsers: z.array(channelAuthorizedUserBindingV1Schema).max(500).default([]),
}).passthrough().superRefine((value, ctx) => {
  const providerIds = new Set<string>();
  const userIds = new Set<string>();
  for (const [index, binding] of value.authorizedUsers.entries()) {
    if (providerIds.has(binding.providerUserId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizedUsers", index, "providerUserId"],
        message: "providerUserId must be unique within a channel connection",
      });
    }
    if (userIds.has(binding.userId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizedUsers", index, "userId"],
        message: "userId must be unique within a channel connection",
      });
    }
    providerIds.add(binding.providerUserId);
    userIds.add(binding.userId);
  }
});

export const channelWebhookRequestV1Schema = z.object({
  contractVersion: z.literal(1),
  workspaceId: z.string().uuid(),
  connectionId: z.string().min(1).max(200),
  connectorKey: safeKey,
  endpointKey: safeKey,
  headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  rawBody: z.string().max(2_000_000),
  parsedBody: z.unknown().optional(),
  requestId: z.string().uuid(),
}).strict();

const messageEventSchema = z.object({
  kind: z.literal("message"),
  contractVersion: z.literal(1),
  providerEventId: z.string().min(1).max(500),
  occurredAt: z.string().datetime({ offset: true }).nullable(),
  conversation: z.object({
    externalConversationId: z.string().min(1).max(500),
    type: z.enum(["group", "direct"]),
  }).strict(),
  author: z.object({ providerUserId: z.string().min(1).max(500) }).strict(),
  content: z.object({ kind: z.literal("text"), text: z.string().min(1).max(100_000) }).strict(),
  intent: z.object({ kind: z.literal("create_target_draft") }).strict().nullable(),
  replyContext: z.object({ providerMessageId: z.string().min(1).max(500) }).strict(),
}).strict();

export const channelWebhookResultV1Schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("challenge"),
    contractVersion: z.literal(1),
    challenge: z.string().min(1).max(10_000),
  }).strict(),
  z.object({
    kind: z.literal("ignored"),
    contractVersion: z.literal(1),
    reason: z.enum(["unsupported_event", "unsupported_content", "bot_message"]),
    providerEventId: z.string().min(1).max(500).nullable(),
  }).strict(),
  messageEventSchema,
]);

export const channelReplyRequestV1Schema = z.object({
  contractVersion: z.literal(1),
  workspaceId: z.string().uuid(),
  connectionId: z.string().min(1).max(200),
  connectorKey: safeKey,
  replyContext: z.object({ providerMessageId: z.string().min(1).max(500) }).strict(),
  text: z.string().min(1).max(100_000),
  idempotencyKey: z.string().min(1).max(50),
}).strict();

export const channelReplyResultV1Schema = z.object({
  contractVersion: z.literal(1),
  providerMessageId: z.string().min(1).max(500),
}).strict();

export const channelIngressRequestV1Schema = z.object({
  contractVersion: z.literal(1),
  workspaceId: z.string().uuid(),
  connectorKey: safeKey,
  connectionId: z.string().min(1).max(200),
  configurationFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  event: messageEventSchema,
}).strict();
