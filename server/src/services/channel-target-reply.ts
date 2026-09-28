import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, companies, companyMemberships, verrailChannelEvents, verrailChannelTargetReplies,
  verrailConversationMessages, verrailProviderConversationBindings, verrailTargetCreationDrafts } from "@paperclipai/db";
import { channelConnectionBindingV1Schema, channelReplyResultV1Schema, channelReplyReadResultV1Schema, type ChannelTargetReplySummary } from "@paperclipai/shared";
import { normalizedContentHash } from "@paperclipai/shared/portability-hash";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { loadChannelTargetProofContext } from "./channel-target-proof-context.js";
import { logActivity } from "./activity-log.js";

const inputSchema = z.object({ workspaceId: z.string().uuid(), conversationId: z.string().uuid(), draftId: z.string().uuid(), principalId: z.string().trim().min(1).max(200) }).strict();
export const reconcileChannelTargetReplySchema = z.object({ providerMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict();
const reconcileSchema = inputSchema.extend(reconcileChannelTargetReplySchema.shape).strict();
const summary = (status: ChannelTargetReplySummary["status"], receiptId: string | null = null): ChannelTargetReplySummary => ({ status, receiptId });
type Options = {
  publicBaseUrl?: string | null;
  workerManager?: Pick<PluginWorkerManager, "call">;
  registry?: Pick<ReturnType<typeof pluginRegistryService>, "list" | "getConfig">;
};

/** A creation notification is not a Target transaction or independent proof. */
export function channelTargetReplyService(db: Db, options: Options) {
  const registry = options.registry ?? pluginRegistryService(db);
  const activeReads = new Set<string>();
  async function reconciliationContext(input: z.infer<typeof reconcileSchema>) {
    const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships)
      .innerJoin(companies, and(eq(companies.id, companyMemberships.companyId), eq(companies.status, "active")))
      .where(and(eq(companyMemberships.companyId, input.workspaceId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.principalId), eq(companyMemberships.status, "active")));
    if (!member) return null;
    const [receipt] = await db.select().from(verrailChannelTargetReplies).where(and(eq(verrailChannelTargetReplies.workspaceId, input.workspaceId),
      eq(verrailChannelTargetReplies.draftId, input.draftId), eq(verrailChannelTargetReplies.confirmedByPrincipalId, input.principalId)));
    if (!receipt) return null;
    const [draft] = await db.select().from(verrailTargetCreationDrafts).where(and(eq(verrailTargetCreationDrafts.id, receipt.draftId),
      eq(verrailTargetCreationDrafts.workspaceId, input.workspaceId), eq(verrailTargetCreationDrafts.conversationId, input.conversationId),
      eq(verrailTargetCreationDrafts.status, "converted"), eq(verrailTargetCreationDrafts.activeRevisionId, receipt.draftRevisionId),
      eq(verrailTargetCreationDrafts.convertedTargetId, receipt.targetId), eq(verrailTargetCreationDrafts.convertedTargetRevisionId, receipt.targetRevisionId),
      eq(verrailTargetCreationDrafts.confirmedByPrincipalType, "user"), eq(verrailTargetCreationDrafts.confirmedByPrincipalId, input.principalId)));
    if (!draft) return null;
    const [event] = await db.select().from(verrailChannelEvents).where(and(eq(verrailChannelEvents.id, receipt.channelEventId), eq(verrailChannelEvents.workspaceId, input.workspaceId),
      eq(verrailChannelEvents.conversationId, input.conversationId), eq(verrailChannelEvents.messageId, draft.sourceMessageId), eq(verrailChannelEvents.draftId, draft.id), eq(verrailChannelEvents.connectorKey, "feishu")));
    const [message] = await db.select().from(verrailConversationMessages).where(and(eq(verrailConversationMessages.id, draft.sourceMessageId),
      eq(verrailConversationMessages.workspaceId, input.workspaceId), eq(verrailConversationMessages.conversationId, input.conversationId)));
    if (!event || typeof message?.metadata?.providerMessageId !== "string") return null;
    const context = await loadChannelTargetProofContext(db, { workspaceId: input.workspaceId, channelEventId: event.id, draftRevisionId: receipt.draftRevisionId,
      createdTargetId: receipt.targetId, createdTargetRevisionId: receipt.targetRevisionId });
    if (context.contextSha256 !== receipt.contextSha256) return null;
    const candidates = [];
    for (const plugin of await registry.list()) {
      if (plugin.status !== "ready" || !plugin.manifestJson?.channelConnectors?.some(d => d.connectorKey === "feishu" && d.contractVersion === 1)) continue;
      const connections = (await registry.getConfig(plugin.id, input.workspaceId))?.configJson.channelConnections;
      if (!Array.isArray(connections)) continue;
      for (const config of connections) {
        const parsed = channelConnectionBindingV1Schema.safeParse(config);
        if (parsed.success && parsed.data.connectorKey === "feishu" && parsed.data.connectionId === event.connectionId
          && parsed.data.authorizedUsers.some(user => user.providerUserId === event.providerUserId && user.userId === draft.initiatedByPrincipalId)) {
          candidates.push({ pluginId: plugin.id, configurationSha256: normalizedContentHash(config) });
        }
      }
    }
    if (candidates.length !== 1 || candidates[0]!.pluginId !== receipt.pluginId || candidates[0]!.configurationSha256 !== receipt.configurationSha256) return null;
    return { receipt, event, parentProviderMessageId: message.metadata.providerMessageId,
      fingerprint: normalizedContentHash({ receipt, event, parent: message.metadata.providerMessageId, context: context.contextSha256, candidates }) };
  }
  return {
    async reconcile(raw: z.infer<typeof reconcileSchema>): Promise<ChannelTargetReplySummary> {
      const parsed = reconcileSchema.safeParse(raw);
      if (!parsed.success || !options.workerManager) return summary("blocked");
      const input = parsed.data, key = `${input.workspaceId}:${input.draftId}`;
      if (activeReads.size >= 2 || activeReads.has(key)) return summary("blocked");
      activeReads.add(key);
      let receiptId: string | null = null;
      try {
        const before = await reconciliationContext(input);
        if (!before) return summary("blocked");
        const { receipt, event } = before;
        receiptId = receipt.id;
        if (receipt.status === "succeeded") return receipt.providerMessageId === input.providerMessageId ? summary("succeeded", receipt.id) : summary("blocked");
        if (receipt.status === "sending" && Date.now() - receipt.startedAt.getTime() < 60_000) return summary("sending", receipt.id);
        if (receipt.status !== "unknown" && receipt.status !== "sending") return summary("blocked");
        const observed = channelReplyReadResultV1Schema.parse(await options.workerManager.call(receipt.pluginId, "handleChannelReplyRead", {
          contractVersion: 1, workspaceId: input.workspaceId, connectorKey: "feishu", connectionId: event.connectionId, providerMessageId: input.providerMessageId,
          parentProviderMessageId: before.parentProviderMessageId, externalConversationId: event.externalConversationId,
        }, 10_000));
        const createdAt = Date.parse(observed.createdAt), startedAt = receipt.startedAt.getTime();
        if (observed.providerMessageId !== input.providerMessageId || observed.parentProviderMessageId !== before.parentProviderMessageId
          || observed.externalConversationId !== event.externalConversationId || observed.bodySha256 !== receipt.bodySha256
          || createdAt < startedAt - 5000 || createdAt > startedAt + 60_000) return summary(receipt.status as "sending" | "unknown", receipt.id);
        const after = await reconciliationContext(input);
        if (!after || after.fingerprint !== before.fingerprint) return summary("blocked");
        const changed = await db.transaction(async tx => {
          const [member] = await tx.select({ id: companyMemberships.id }).from(companyMemberships)
            .innerJoin(companies, and(eq(companies.id, companyMemberships.companyId), eq(companies.status, "active")))
            .where(and(eq(companyMemberships.companyId, input.workspaceId), eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, input.principalId), eq(companyMemberships.status, "active"))).for("share");
          const [draft] = await tx.select({ id: verrailTargetCreationDrafts.id }).from(verrailTargetCreationDrafts)
            .where(and(eq(verrailTargetCreationDrafts.id, receipt.draftId), eq(verrailTargetCreationDrafts.workspaceId, input.workspaceId),
              eq(verrailTargetCreationDrafts.status, "converted"), eq(verrailTargetCreationDrafts.activeRevisionId, receipt.draftRevisionId),
              eq(verrailTargetCreationDrafts.confirmedByPrincipalType, "user"), eq(verrailTargetCreationDrafts.confirmedByPrincipalId, input.principalId),
              eq(verrailTargetCreationDrafts.convertedTargetId, receipt.targetId), eq(verrailTargetCreationDrafts.convertedTargetRevisionId, receipt.targetRevisionId))).for("share");
          if (!member || !draft) return false;
          const [row] = await tx.update(verrailChannelTargetReplies).set({ status: "succeeded", providerMessageId: observed.providerMessageId, completedAt: new Date() })
            .where(and(eq(verrailChannelTargetReplies.id, receipt.id), eq(verrailChannelTargetReplies.workspaceId, input.workspaceId),
              eq(verrailChannelTargetReplies.status, receipt.status), eq(verrailChannelTargetReplies.contextSha256, receipt.contextSha256),
              eq(verrailChannelTargetReplies.configurationSha256, receipt.configurationSha256))).returning({ id: verrailChannelTargetReplies.id });
          if (!row) return false;
          await logActivity(tx as unknown as Db, { companyId: input.workspaceId, actorType: "user", actorId: input.principalId,
            action: "channel.target_reply.reconciled", entityType: "target", entityId: receipt.targetId,
            details: { receiptId: receipt.id, bodySha256: observed.bodySha256, observedCreatedAt: observed.createdAt,
              observationSha256: normalizedContentHash(observed), method: "provider_message_read", previousStatus: receipt.status } });
          return true;
        });
        return changed ? summary("succeeded", receipt.id) : summary("blocked");
      } catch { return receiptId ? summary("unknown", receiptId) : summary("blocked"); }
      finally { activeReads.delete(key); }
    },
    async read(raw: z.infer<typeof inputSchema>): Promise<ChannelTargetReplySummary> {
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) return summary("blocked");
      const input = parsed.data;
      const [row] = await db.select({ id: verrailChannelTargetReplies.id, status: verrailChannelTargetReplies.status })
        .from(verrailChannelTargetReplies).innerJoin(verrailTargetCreationDrafts, and(
          eq(verrailTargetCreationDrafts.id, verrailChannelTargetReplies.draftId),
          eq(verrailTargetCreationDrafts.workspaceId, verrailChannelTargetReplies.workspaceId),
          eq(verrailTargetCreationDrafts.activeRevisionId, verrailChannelTargetReplies.draftRevisionId),
          eq(verrailTargetCreationDrafts.convertedTargetId, verrailChannelTargetReplies.targetId),
          eq(verrailTargetCreationDrafts.convertedTargetRevisionId, verrailChannelTargetReplies.targetRevisionId),
        )).where(and(eq(verrailChannelTargetReplies.workspaceId, input.workspaceId),
          eq(verrailChannelTargetReplies.draftId, input.draftId), eq(verrailTargetCreationDrafts.conversationId, input.conversationId),
          eq(verrailTargetCreationDrafts.status, "converted")));
      return row ? summary(row.status as "sending" | "succeeded" | "unknown", row.id) : summary("blocked");
    },
    async deliver(raw: z.infer<typeof inputSchema>): Promise<ChannelTargetReplySummary> {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return summary("blocked");
    const input = parsed.data;
    let receiptId: string | null = null;
    let reserved = false;
    try {
      const [draft] = await db.select().from(verrailTargetCreationDrafts).where(and(
        eq(verrailTargetCreationDrafts.workspaceId, input.workspaceId), eq(verrailTargetCreationDrafts.conversationId, input.conversationId),
        eq(verrailTargetCreationDrafts.id, input.draftId), eq(verrailTargetCreationDrafts.status, "converted"),
        eq(verrailTargetCreationDrafts.confirmedByPrincipalType, "user"), eq(verrailTargetCreationDrafts.confirmedByPrincipalId, input.principalId),
      ));
      if (!draft?.convertedTargetId || !draft.convertedTargetRevisionId) return summary("blocked");
      const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships)
        .innerJoin(companies, and(eq(companies.id, companyMemberships.companyId), eq(companies.status, "active")))
        .where(and(eq(companyMemberships.companyId, input.workspaceId), eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.principalId), eq(companyMemberships.status, "active")));
      if (!member) return summary("blocked");
      const events = await db.select().from(verrailChannelEvents).where(and(
        eq(verrailChannelEvents.workspaceId, input.workspaceId), eq(verrailChannelEvents.conversationId, input.conversationId),
        eq(verrailChannelEvents.messageId, draft.sourceMessageId), eq(verrailChannelEvents.draftId, draft.id),
      )).limit(2);
      const [message] = await db.select().from(verrailConversationMessages).where(and(
        eq(verrailConversationMessages.workspaceId, input.workspaceId), eq(verrailConversationMessages.id, draft.sourceMessageId),
        eq(verrailConversationMessages.conversationId, input.conversationId),
      ));
      if (events.length === 0) {
        const bindings = await db.select({ id: verrailProviderConversationBindings.id }).from(verrailProviderConversationBindings)
          .where(and(eq(verrailProviderConversationBindings.workspaceId, input.workspaceId), eq(verrailProviderConversationBindings.conversationId, input.conversationId))).limit(1);
        return summary(message && !message.metadata?.channelConnector && bindings.length === 0 ? "not_applicable" : "blocked");
      }
      const event = events[0];
      if (events.length !== 1 || !event || event.connectorKey !== "feishu" || !message
        || typeof message.metadata?.providerMessageId !== "string" || !message.metadata.providerMessageId.trim()) return summary("blocked");
      const proofInput = { workspaceId: input.workspaceId, channelEventId: event.id, draftRevisionId: draft.activeRevisionId,
        createdTargetId: draft.convertedTargetId, createdTargetRevisionId: draft.convertedTargetRevisionId };
      const context = await loadChannelTargetProofContext(db, proofInput);
      const [existing] = await db.select().from(verrailChannelTargetReplies).where(and(
        eq(verrailChannelTargetReplies.workspaceId, input.workspaceId), eq(verrailChannelTargetReplies.draftId, draft.id),
      ));
      if (existing) {
        if (existing.targetId !== draft.convertedTargetId || existing.targetRevisionId !== draft.convertedTargetRevisionId
          || existing.draftRevisionId !== draft.activeRevisionId || existing.channelEventId !== event.id) return summary("blocked");
        return summary(existing.status as "sending" | "succeeded" | "unknown", existing.id);
      }
      if (!options.workerManager || !options.publicBaseUrl) return summary("blocked");
      const url = new URL(options.publicBaseUrl);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return summary("blocked");
      const targetUrl = new URL(`/targets/${draft.convertedTargetId}/overview`, url).toString();
      const candidates = [];
      for (const plugin of await registry.list()) {
        if (plugin.status !== "ready" || !plugin.manifestJson?.channelConnectors?.some(d => d.contractVersion === 1 && d.connectorKey === "feishu")) continue;
        const config = (await registry.getConfig(plugin.id, input.workspaceId))?.configJson.channelConnections;
        if (!Array.isArray(config)) continue;
        for (const rawConnection of config) {
          const connection = channelConnectionBindingV1Schema.safeParse(rawConnection);
          if (connection.success && connection.data.connectionId === event.connectionId && connection.data.connectorKey === event.connectorKey
            && connection.data.authorizedUsers.some(user => user.providerUserId === event.providerUserId && user.userId === draft.initiatedByPrincipalId)) {
            candidates.push({ pluginId: plugin.id, configurationSha256: normalizedContentHash(rawConnection) });
          }
        }
      }
      if (candidates.length !== 1) return summary("blocked");
      const candidate = candidates[0]!;
      const text = `Verrail: Target created.\n${targetUrl}\nTargetRevision: ${draft.convertedTargetRevisionId}`;
      const idempotencyKey = `vtc:${draft.id}`;
      const bodySha256 = createHash("sha256").update(text).digest("hex");
      if ((await loadChannelTargetProofContext(db, proofInput)).contextSha256 !== context.contextSha256) return summary("blocked");
      // Commit the unique send reservation before touching the Provider. A crash,
      // timeout or unconfirmed response never grants another automatic attempt.
      const inserted = await db.transaction(async tx => {
        const [locked] = await tx.select().from(verrailTargetCreationDrafts).where(and(eq(verrailTargetCreationDrafts.id, draft.id),
          eq(verrailTargetCreationDrafts.workspaceId, input.workspaceId))).for("update");
        if (!locked || locked.status !== "converted" || locked.activeRevisionId !== draft.activeRevisionId
          || locked.confirmedByPrincipalId !== input.principalId || locked.convertedTargetRevisionId !== draft.convertedTargetRevisionId) return null;
        const [row] = await tx.insert(verrailChannelTargetReplies).values({ workspaceId: input.workspaceId, draftId: draft.id,
          draftRevisionId: draft.activeRevisionId, channelEventId: event.id, targetId: draft.convertedTargetId!, targetRevisionId: draft.convertedTargetRevisionId!,
          ...candidate, confirmedByPrincipalId: input.principalId, contextSha256: context.contextSha256, bodySha256, idempotencyKey, status: "sending" })
          .onConflictDoNothing().returning();
        if (row) await logActivity(tx as unknown as Db, { companyId: input.workspaceId, actorType: "user", actorId: input.principalId,
          action: "channel.target_reply.reserved", entityType: "target", entityId: row.targetId,
          details: { receiptId: row.id, targetRevisionId: row.targetRevisionId, draftRevisionId: row.draftRevisionId, bodySha256 } });
        return row ?? null;
      });
      if (!inserted) {
        const [winner] = await db.select().from(verrailChannelTargetReplies).where(and(eq(verrailChannelTargetReplies.workspaceId, input.workspaceId), eq(verrailChannelTargetReplies.draftId, draft.id)));
        return winner ? summary(winner.status as "sending" | "succeeded" | "unknown", winner.id) : summary("blocked");
      }
      receiptId = inserted.id; reserved = true;
      const reply = channelReplyResultV1Schema.parse(await options.workerManager.call(candidate.pluginId, "handleChannelReply", {
        contractVersion: 1, workspaceId: input.workspaceId, connectorKey: "feishu", connectionId: event.connectionId,
        replyContext: { providerMessageId: message.metadata.providerMessageId }, text, idempotencyKey,
      }, 10_000));
      await db.transaction(async tx => {
        await tx.update(verrailChannelTargetReplies).set({ status: "succeeded", providerMessageId: reply.providerMessageId, completedAt: new Date() })
          .where(and(eq(verrailChannelTargetReplies.id, receiptId!), eq(verrailChannelTargetReplies.workspaceId, input.workspaceId), eq(verrailChannelTargetReplies.status, "sending")));
        await logActivity(tx as unknown as Db, { companyId: input.workspaceId, actorType: "user", actorId: input.principalId,
          action: "channel.target_reply.succeeded", entityType: "target", entityId: draft.convertedTargetId!, details: { receiptId } });
      });
      return summary("succeeded", receiptId);
    } catch {
      if (reserved && receiptId) {
        await db.update(verrailChannelTargetReplies).set({ status: "unknown", completedAt: new Date() }).where(and(
          eq(verrailChannelTargetReplies.id, receiptId), eq(verrailChannelTargetReplies.workspaceId, input.workspaceId),
          eq(verrailChannelTargetReplies.status, "sending"),
        )).catch(() => {});
        return summary("unknown", receiptId);
      }
      return summary("blocked");
    }
  } };
}
