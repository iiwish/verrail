import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
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
    idWorkspaceUq: unique("verrail_conversation_messages_id_workspace_uq").on(
      table.id,
      table.workspaceId,
    ),
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
      sql`${table.contextType} in ('collection', 'target', 'target_revision', 'stage', 'artifact_revision', 'review', 'run', 'action_request')`,
    ),
  }),
);

export interface VerrailTargetDraftDefinitionRecord {
  collectionId: string | null;
  title: string | null;
  summary: string | null;
  outcomeOwner: { principalType: "user" | "agent"; principalId: string } | null;
  goal: string | null;
  constraints: string[];
  acceptanceCriteria: Array<{ title: string; description?: string | null }>;
  riskLevel: "low" | "medium" | "high" | "critical" | null;
  deadline: string | null;
  policySummary: string | null;
  resourceRefs: Array<Record<string, unknown>>;
}

export const verrailProviderConversationBindings = pgTable(
  "verrail_provider_conversation_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    providerKey: text("provider_key").notNull(),
    connectionId: text("connection_id").notNull(),
    externalConversationType: text("external_conversation_type").notNull(),
    externalConversationId: text("external_conversation_id").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceExternalUq: uniqueIndex("verrail_provider_conversation_bindings_external_uq").on(
      table.workspaceId,
      table.connectionId,
      table.externalConversationId,
    ),
    conversationIdx: index("verrail_provider_conversation_bindings_conversation_idx").on(
      table.workspaceId,
      table.conversationId,
    ),
    conversationWorkspaceFk: foreignKey({
      columns: [table.conversationId, table.workspaceId],
      foreignColumns: [verrailConversations.id, verrailConversations.workspaceId],
      name: "verrail_provider_conversation_bindings_conversation_workspace_fk",
    }).onDelete("cascade"),
    conversationTypeCheck: check(
      "verrail_provider_conversation_bindings_type_check",
      sql`${table.externalConversationType} in ('group', 'direct')`,
    ),
  }),
);

export const verrailTargetCreationDrafts = pgTable(
  "verrail_target_creation_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    sourceMessageId: uuid("source_message_id").notNull(),
    initiatedByPrincipalType: text("initiated_by_principal_type").notNull(),
    initiatedByPrincipalId: text("initiated_by_principal_id").notNull(),
    status: text("status").notNull().default("collecting"),
    activeRevisionId: uuid("active_revision_id").notNull(),
    activeRevisionNumber: integer("active_revision_number").notNull().default(1),
    convertedTargetId: uuid("converted_target_id"),
    convertedTargetRevisionId: uuid("converted_target_revision_id"),
    confirmedByPrincipalType: text("confirmed_by_principal_type"),
    confirmedByPrincipalId: text("confirmed_by_principal_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    conversionIdempotencyKey: text("conversion_idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_target_creation_drafts_id_workspace_uq").on(table.id, table.workspaceId),
    conversationStatusIdx: index("verrail_target_creation_drafts_conversation_status_idx").on(
      table.workspaceId,
      table.conversationId,
      table.status,
      table.updatedAt,
    ),
    conversationWorkspaceFk: foreignKey({
      columns: [table.conversationId, table.workspaceId],
      foreignColumns: [verrailConversations.id, verrailConversations.workspaceId],
      name: "verrail_target_creation_drafts_conversation_workspace_fk",
    }).onDelete("cascade"),
    sourceMessageFk: foreignKey({
      columns: [table.sourceMessageId, table.workspaceId],
      foreignColumns: [verrailConversationMessages.id, verrailConversationMessages.workspaceId],
      name: "verrail_target_creation_drafts_source_message_workspace_fk",
    }).onDelete("restrict"),
    statusCheck: check(
      "verrail_target_creation_drafts_status_check",
      sql`${table.status} in ('collecting', 'ready_for_confirmation', 'converting', 'converted', 'canceled')`,
    ),
  }),
);

export const verrailTargetCreationDraftRevisions = pgTable(
  "verrail_target_creation_draft_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    definition: jsonb("definition").$type<VerrailTargetDraftDefinitionRecord>().notNull(),
    missingFields: jsonb("missing_fields").$type<string[]>().notNull(),
    fieldSources: jsonb("field_sources").$type<Record<string, Record<string, unknown>>>().notNull().default({}),
    contentHash: text("content_hash").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    draftRevisionUq: uniqueIndex("verrail_target_creation_draft_revisions_number_uq").on(
      table.draftId,
      table.revisionNumber,
    ),
    draftWorkspaceFk: foreignKey({
      columns: [table.draftId, table.workspaceId],
      foreignColumns: [verrailTargetCreationDrafts.id, verrailTargetCreationDrafts.workspaceId],
      name: "verrail_target_creation_draft_revisions_draft_workspace_fk",
    }).onDelete("cascade"),
  }),
);
