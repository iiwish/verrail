import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { verrailConversationMessages } from "./verrail_conversations.js";
import { verrailDeploymentRevisions } from "./verrail_agents.js";

export const verrailConversationInvocations = pgTable("verrail_conversation_invocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull(),
  sourceMessageId: uuid("source_message_id").notNull(),
  principalId: text("principal_id").notNull(),
  agentVersionId: uuid("agent_version_id").notNull(),
  deploymentRevisionId: uuid("deployment_revision_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("queued"),
  fencingToken: integer("fencing_token").notNull().default(1),
  controllerId: text("controller_id"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastEventCursor: integer("last_event_cursor").notNull().default(0),
  output: text("output").notNull().default(""),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  idWorkspaceUq: unique("verrail_chat_invocations_id_workspace_uq").on(table.id, table.workspaceId),
  sourceUq: uniqueIndex("verrail_chat_invocations_source_uq").on(table.sourceMessageId),
  requestUq: uniqueIndex("verrail_chat_invocations_request_uq").on(table.workspaceId, table.principalId, table.idempotencyKey),
  activeUq: uniqueIndex("verrail_chat_invocations_active_uq").on(table.workspaceId, table.conversationId)
    .where(sql`${table.status} in ('queued', 'running', 'cancel_requested')`),
  conversationIdx: index("verrail_chat_invocations_conversation_idx").on(table.workspaceId, table.conversationId, table.createdAt),
  recoveryIdx: index("verrail_chat_invocations_recovery_idx").on(table.status, table.leaseExpiresAt),
  sourceFk: foreignKey({ name: "verrail_chat_invocations_source_fk",
    columns: [table.sourceMessageId, table.conversationId, table.workspaceId],
    foreignColumns: [verrailConversationMessages.id, verrailConversationMessages.conversationId, verrailConversationMessages.workspaceId],
  }).onDelete("cascade"),
  versionFk: foreignKey({ name: "verrail_chat_invocations_version_fk",
    columns: [table.deploymentRevisionId, table.agentVersionId, table.workspaceId],
    foreignColumns: [verrailDeploymentRevisions.id, verrailDeploymentRevisions.agentVersionId, verrailDeploymentRevisions.workspaceId],
  }).onDelete("restrict"),
  statusCheck: check("verrail_chat_invocations_status_check", sql`${table.status} in ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'canceled')`),
  countersCheck: check("verrail_chat_invocations_counters_check", sql`${table.fencingToken} > 0 and ${table.lastEventCursor} >= 0`),
  terminalCheck: check("verrail_chat_invocations_terminal_check", sql`(${table.status} in ('succeeded', 'failed', 'canceled')) = (${table.finishedAt} is not null)`),
  leaseCheck: check("verrail_chat_invocations_lease_check", sql`(${table.controllerId} is null) = (${table.leaseExpiresAt} is null)`),
}));

export const verrailConversationInvocationEvents = pgTable("verrail_conversation_invocation_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  invocationId: uuid("invocation_id").notNull(),
  cursor: integer("cursor").notNull(),
  type: text("type").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  cursorUq: uniqueIndex("verrail_chat_invocation_events_cursor_uq").on(table.invocationId, table.cursor),
  invocationFk: foreignKey({ name: "verrail_chat_invocation_events_scope_fk",
    columns: [table.invocationId, table.workspaceId],
    foreignColumns: [verrailConversationInvocations.id, verrailConversationInvocations.workspaceId],
  }).onDelete("cascade"),
  cursorCheck: check("verrail_chat_invocation_events_cursor_check", sql`${table.cursor} > 0`),
  typeCheck: check("verrail_chat_invocation_events_type_check", sql`${table.type} in ('start', 'chunk', 'cancel_requested', 'done', 'error')`),
}));
