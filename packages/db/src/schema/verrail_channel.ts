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
