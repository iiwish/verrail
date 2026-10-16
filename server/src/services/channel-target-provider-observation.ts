import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, verrailChannelEvents, verrailChannelTargetReplies, verrailConversationMessages } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { loadChannelTargetProofContext, type ChannelTargetProofContextInput } from "./channel-target-proof-context.js";
import { assertDeliveryProofReader, type DeliveryProofReaderAccess } from "./delivery-proof-reader-access.js";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const channelProviderObservationConfigSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: z.string().uuid(), connectionId: identifier, appId: identifier,
  appSecret: z.string().min(1).max(4096), publicBaseUrl: z.url(),
  authorizedUsers: z.array(z.object({ providerUserId: identifier, userId: z.string().min(1).max(200) }).strict()).min(1).max(1000),
}).strict();
export type ChannelProviderObservationConfig = z.infer<typeof channelProviderObservationConfigSchema>;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const textDigest = (value: string) => createHash("sha256").update(value).digest("hex");
function unavailable(): never { throw new Error("CHANNEL_PROVIDER_OBSERVATION_UNAVAILABLE"); }
const messageSchema = z.object({
  message_id: identifier, msg_type: z.literal("text"), deleted: z.literal(false), updated: z.literal(false),
  chat_id: identifier, parent_id: identifier.optional(), create_time: z.string().regex(/^\d{13}$/),
  sender: z.object({ id: identifier, id_type: z.enum(["open_id", "app_id"]), sender_type: z.enum(["user", "app"]) }),
  body: z.object({ content: z.string().min(1).max(200_000) }),
});

/** Uses an operator-held configuration, not the candidate's plugin config or RPC.
 * Output is readback evidence only; it does not grant criterion admission.
 */
export async function observeChannelTargetProvider(db: Db, input: ChannelTargetProofContextInput,
  trustedConfiguration: ChannelProviderObservationConfig, dependencies: { access: DeliveryProofReaderAccess; fetch?: typeof fetch }) {
  try {
    if (dependencies.access.schemaVersion !== 2 || dependencies.access.workspaceId !== input.workspaceId) unavailable();
    const authority = await assertDeliveryProofReader(db, dependencies.access);
    const config = channelProviderObservationConfigSchema.parse(trustedConfiguration);
    const base = new URL(config.publicBaseUrl);
    if (config.workspaceId !== input.workspaceId || !["http:", "https:"].includes(base.protocol)
      || base.username || base.password || base.search || base.hash
      || new Set(config.authorizedUsers.map(user => user.providerUserId)).size !== config.authorizedUsers.length) unavailable();
    const startedAt = new Date().toISOString();
    const fetcher = dependencies.fetch ?? fetch;
    const deadline = AbortSignal.timeout(15_000);
    async function providerJson(url: string, init: RequestInit, maxBytes: number): Promise<unknown> {
      const response = await fetcher(url, { ...init, redirect: "error", credentials: "omit", signal: deadline });
      if (!response.ok || response.redirected || !response.body) unavailable();
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes) unavailable();
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    async function loadSource() {
      const context = await loadChannelTargetProofContext(db, input);
      const rows = await db.select({ event: verrailChannelEvents, reply: verrailChannelTargetReplies,
        message: { metadata: verrailConversationMessages.metadata, authorPrincipalType: verrailConversationMessages.authorPrincipalType,
          authorPrincipalId: verrailConversationMessages.authorPrincipalId } })
        .from(verrailChannelEvents)
        .innerJoin(verrailConversationMessages, and(eq(verrailConversationMessages.workspaceId, input.workspaceId),
          eq(verrailConversationMessages.id, context.messageId), eq(verrailConversationMessages.id, verrailChannelEvents.messageId)))
        .innerJoin(verrailChannelTargetReplies, and(eq(verrailChannelTargetReplies.workspaceId, input.workspaceId),
          eq(verrailChannelTargetReplies.channelEventId, verrailChannelEvents.id), eq(verrailChannelTargetReplies.draftId, context.draft.id)))
        .where(and(eq(verrailChannelEvents.workspaceId, input.workspaceId), eq(verrailChannelEvents.id, input.channelEventId))).limit(2);
      const row = rows[0];
      if (rows.length !== 1 || !row) unavailable();
      const { event, message, reply } = row;
      const parent = identifier.parse(message.metadata?.providerMessageId);
      const bodySha256 = z.string().regex(/^[a-f0-9]{64}$/).parse(message.metadata?.proofReaderBodySha256);
      if (event.connectionId !== config.connectionId || event.connectorKey !== "feishu" || message.authorPrincipalType !== "user"
        || !config.authorizedUsers.some(user => user.providerUserId === event.providerUserId && user.userId === message.authorPrincipalId)
        || reply.status !== "succeeded" || !reply.providerMessageId || !reply.completedAt || reply.completedAt < reply.startedAt
        || reply.draftRevisionId !== input.draftRevisionId || reply.targetId !== input.createdTargetId
        || reply.targetRevisionId !== input.createdTargetRevisionId || reply.contextSha256 !== context.contextSha256
        || reply.idempotencyKey !== `vtc:${context.draft.id}` || reply.startedAt.getTime() < Date.parse(context.createdAt) - 5000) unavailable();
      identifier.parse(reply.providerMessageId);
      const expectedReply = `Verrail: Target created.\n${new URL(`/targets/${input.createdTargetId}/overview`, base)}\nTargetRevision: ${input.createdTargetRevisionId}`;
      if (textDigest(expectedReply) !== reply.bodySha256) unavailable();
      return { context, event, reply, parent, bodySha256, messageRuntimeSessionId: message.metadata?.runtimeSessionId ?? null,
        fingerprint: digest({ context, row }) };
    }
    const before = await loadSource();
    const token = z.object({ code: z.literal(0), tenant_access_token: z.string().min(1).max(8192) }).parse(await providerJson(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }) }, 64 * 1024));
    async function readMessage(id: string) {
      const response = z.object({ code: z.literal(0), data: z.object({ items: z.array(messageSchema).length(1) }) }).parse(await providerJson(
        `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(id)}`, { method: "GET", headers: { authorization: `Bearer ${token.tenant_access_token}` } }, 512 * 1024));
      const message = response.data.items[0]!;
      const text = z.object({ text: z.string().min(1).max(100_000) }).strict().parse(JSON.parse(message.body.content)).text;
      if (message.message_id !== id || message.chat_id !== before.event.externalConversationId) unavailable();
      return { message, text };
    }
    const inbound = await readMessage(before.parent), reply = await readMessage(before.reply.providerMessageId!);
    const received = before.event.receivedAt.getTime(), incomingTime = Number(inbound.message.create_time), replyTime = Number(reply.message.create_time);
    if (inbound.message.sender.id !== before.event.providerUserId || inbound.message.sender.id_type !== "open_id"
      || inbound.message.sender.sender_type !== "user" || textDigest(inbound.text.trim()) !== before.bodySha256
      || incomingTime > received + 5000 || incomingTime < received - 300_000
      || reply.message.sender.id !== config.appId || reply.message.sender.id_type !== "app_id" || reply.message.sender.sender_type !== "app"
      || reply.message.parent_id !== before.parent || textDigest(reply.text) !== before.reply.bodySha256
      || replyTime < before.reply.startedAt.getTime() - 5000 || replyTime > before.reply.startedAt.getTime() + 60_000
      || replyTime > before.reply.completedAt!.getTime() + 5000) unavailable();
    const after = await loadSource();
    if (before.fingerprint !== after.fingerprint || deadline.aborted) unavailable();
    await assertDeliveryProofReader(db, dependencies.access);
    const { appSecret: _secret, ...publicConfig } = config;
    const observation = { schemaVersion: 1, kind: "verrail.channel-target-provider-observation",
      assurance: "provider_message_and_reply_readback", workspaceId: input.workspaceId, channelEventId: input.channelEventId,
      readerPolicySha256: authority.policySha256,
      databaseContextSha256: before.context.contextSha256, sourceContextSha256: before.fingerprint,
      configurationSha256: digest(publicConfig), replyReceiptId: before.reply.id,
      pluginId: before.reply.pluginId,
      runtimeSessionId: z.string().uuid().nullable().parse(before.messageRuntimeSessionId),
      providerReferences: { ...before.context.providerReferences, creationReplySha256: digest(["verrail/channel-reference/v1",
        input.workspaceId, config.connectionId, "message", before.reply.providerMessageId]) },
      messageBodySha256: before.bodySha256, replyBodySha256: before.reply.bodySha256,
      providerMessageCreatedAt: new Date(incomingTime).toISOString(), providerReplyCreatedAt: new Date(replyTime).toISOString(),
      startedAt, verifiedAt: new Date().toISOString(),
      limitations: ["callback_reference_is_database_correlation_not_signature_replay", "candidate_runtime_binding_not_verified"] };
    return { ...observation, sha256: digest(observation) };
  } catch { unavailable(); }
}
