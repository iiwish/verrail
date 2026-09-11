import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Durable inbox for normalized enterprise-channel events. Raw provider payloads,
 * request headers and credentials never enter this table. The composite unique
 * key is the concurrency boundary for provider retries.
 */
export const verrailChannelEvents = pgTable(
  "verrail_channel_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectorKey: text("connector_key").notNull(),
    connectionId: text("connection_id").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    externalConversationType: text("external_conversation_type").notNull(),
    externalConversationId: text("external_conversation_id").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    messageId: uuid("message_id").notNull(),
    draftId: uuid("draft_id"),
    replyProviderMessageId: text("reply_provider_message_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceEventUq: uniqueIndex("verrail_channel_events_workspace_event_uq").on(
      table.workspaceId,
      table.connectorKey,
      table.connectionId,
      table.providerEventId,
    ),
    workspaceConversationIdx: index("verrail_channel_events_workspace_conversation_idx").on(
      table.workspaceId,
      table.connectionId,
      table.externalConversationId,
      table.receivedAt,
    ),
    conversationTypeCheck: check(
      "verrail_channel_events_conversation_type_check",
      sql`${table.externalConversationType} in ('group', 'direct')`,
    ),
  }),
);

export const verrailChannelTargetReplies = pgTable(
  "verrail_channel_target_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id").notNull(),
    draftRevisionId: uuid("draft_revision_id").notNull(),
    channelEventId: uuid("channel_event_id").notNull(),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id").notNull(),
    pluginId: uuid("plugin_id").notNull(),
    confirmedByPrincipalId: text("confirmed_by_principal_id").notNull(),
    configurationSha256: text("configuration_sha256").notNull(),
    contextSha256: text("context_sha256").notNull(),
    bodySha256: text("body_sha256").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  table => ({
    draftUq: uniqueIndex("verrail_channel_target_replies_draft_uq").on(table.workspaceId, table.draftId),
    targetIdx: index("verrail_channel_target_replies_target_idx").on(table.workspaceId, table.targetId),
    statusCheck: check("verrail_channel_target_replies_status_check", sql`${table.status} in ('sending', 'succeeded', 'unknown')`),
    receiptCheck: check("verrail_channel_target_replies_receipt_check", sql`(${table.status} = 'succeeded' and ${table.providerMessageId} is not null and ${table.completedAt} is not null) or (${table.status} <> 'succeeded' and ${table.providerMessageId} is null)`),
  }),
);
