import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const verrailConversations = pgTable(
  "verrail_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New conversation"),
    status: text("status").notNull().default("active"),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceStatusActivityIdx: index("verrail_conversations_workspace_status_activity_idx").on(
      table.workspaceId,
      table.status,
      table.lastMessageAt,
    ),
    workspacePinnedIdx: index("verrail_conversations_workspace_pinned_idx").on(
      table.workspaceId,
      table.pinnedAt,
    ),
    idWorkspaceUq: unique("verrail_conversations_id_workspace_uq").on(
      table.id,
      table.workspaceId,
    ),
    statusCheck: check(
      "verrail_conversations_status_check",
      sql`${table.status} in ('active', 'archived')`,
    ),
  }),
);

export const verrailConversationMessages = pgTable(
  "verrail_conversation_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("complete"),
    body: text("body").notNull(),
    authorPrincipalType: text("author_principal_type"),
    authorPrincipalId: text("author_principal_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationCreatedIdx: index("verrail_conversation_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    workspaceCreatedIdx: index("verrail_conversation_messages_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    conversationWorkspaceFk: foreignKey({
      columns: [table.conversationId, table.workspaceId],
      foreignColumns: [verrailConversations.id, verrailConversations.workspaceId],
      name: "verrail_conversation_messages_conversation_workspace_fk",
    }).onDelete("cascade"),
    roleCheck: check(
      "verrail_conversation_messages_role_check",
      sql`${table.role} in ('user', 'assistant', 'system', 'tool')`,
    ),
    statusCheck: check(
      "verrail_conversation_messages_status_check",
      sql`${table.status} in ('complete', 'failed')`,
    ),
  }),
);

export const verrailConversationContextBindings = pgTable(
  "verrail_conversation_context_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    contextType: text("context_type").notNull(),
    contextId: text("context_id").notNull(),
    label: text("label"),
    href: text("href"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationContextUq: uniqueIndex("verrail_conversation_context_bindings_context_uq").on(
      table.conversationId,
      table.contextType,
      table.contextId,
    ),
    workspaceContextIdx: index("verrail_conversation_context_bindings_workspace_context_idx").on(
      table.workspaceId,
      table.contextType,
      table.contextId,
    ),
    conversationWorkspaceFk: foreignKey({
      columns: [table.conversationId, table.workspaceId],
      foreignColumns: [verrailConversations.id, verrailConversations.workspaceId],
      name: "verrail_conversation_context_bindings_conversation_workspace_fk",
    }).onDelete("cascade"),
    contextTypeCheck: check(
      "verrail_conversation_context_bindings_type_check",
      sql`${table.contextType} in ('project', 'target', 'target_revision', 'stage', 'artifact_revision', 'review', 'run', 'action_request')`,
    ),
  }),
);
