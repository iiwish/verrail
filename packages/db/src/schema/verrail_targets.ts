import { sql } from "drizzle-orm";
import {
  check,
  date,
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
import { projects } from "./projects.js";
import { verrailCollections } from "./verrail_collections.js";

export interface VerrailAcceptanceCriterionRecord {
  id: string;
  title: string;
  description: string | null;
}

export const verrailTargets = pgTable(
  "verrail_targets",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id),
    // Compatibility storage for pre-G1 rolling upgrades (expand/contract):
    // native Verrail code never reads or writes this column; it is retained so
    // a pre-G1 service can keep running against a migrated database until the
    // contract migration drops it after pre-G1 service retirement.
    projectId: uuid("project_id"),
    collectionId: uuid("collection_id"),
    activeTargetRevisionId: uuid("active_target_revision_id").notNull(),
    status: text("status").notNull().default("draft"),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_targets_id_workspace_uq").on(table.id, table.workspaceId),
    collectionWorkspaceFk: foreignKey({
      columns: [table.collectionId, table.workspaceId],
      foreignColumns: [verrailCollections.id, verrailCollections.workspaceId],
      name: "verrail_targets_collection_workspace_fk",
    }).onDelete("restrict"),
    projectCompatFk: foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "verrail_targets_project_id_projects_id_fk",
    }),
    workspaceUpdatedIdx: index("verrail_targets_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    workspaceCollectionUpdatedIdx: index("verrail_targets_workspace_collection_updated_idx").on(
      table.workspaceId,
      table.collectionId,
      table.updatedAt,
    ),
    workspaceProjectUpdatedCompatIdx: index("verrail_targets_workspace_project_updated_idx").on(
      table.workspaceId,
      table.projectId,
      table.updatedAt,
    ),
  }),
);

export const verrailTargetRevisions = pgTable(
  "verrail_target_revisions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id),
    targetId: uuid("target_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    outcomeOwnerPrincipalType: text("outcome_owner_principal_type").notNull(),
    outcomeOwnerPrincipalId: text("outcome_owner_principal_id").notNull(),
    outcomeOwnerDisplayName: text("outcome_owner_display_name"),
    goal: text("goal").notNull(),
    constraints: jsonb("constraints").$type<string[]>().notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria")
      .$type<VerrailAcceptanceCriterionRecord[]>()
      .notNull(),
    riskLevel: text("risk_level").notNull(),
    deadline: date("deadline"),
    policySummary: text("policy_summary"),
    resourceRefs: jsonb("resource_refs").$type<Array<Record<string, unknown>>>().notNull().default([]),
    contentHash: text("content_hash").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_target_revisions_id_workspace_uq").on(table.id, table.workspaceId),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_target_revisions_target_workspace_fk",
    }).onDelete("cascade"),
    targetRevisionNumberUq: uniqueIndex("verrail_target_revisions_target_number_uq").on(
      table.targetId,
      table.revisionNumber,
    ),
    workspaceTargetCreatedIdx: index("verrail_target_revisions_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
  }),
);

export const verrailCommandReceipts = pgTable(
  "verrail_command_receipts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    commandType: text("command_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    targetId: uuid("target_id").notNull().references(() => verrailTargets.id),
    targetRevisionId: uuid("target_revision_id").notNull().references(() => verrailTargetRevisions.id),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    commandKeyUq: uniqueIndex("verrail_command_receipts_principal_key_uq").on(
      table.workspaceId,
      table.principalType,
      table.principalId,
      table.commandType,
      table.idempotencyKey,
    ),
    targetIdx: index("verrail_command_receipts_target_idx").on(table.targetId),
  }),
);

export const verrailAuditEvents = pgTable(
  "verrail_audit_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceOccurredIdx: index("verrail_audit_events_workspace_occurred_idx").on(
      table.workspaceId,
      table.occurredAt,
    ),
    aggregateIdx: index("verrail_audit_events_aggregate_idx").on(
      table.aggregateType,
      table.aggregateId,
      table.occurredAt,
    ),
  }),
);

export const verrailOutboxEvents = pgTable(
  "verrail_outbox_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    workflowId: text("workflow_id"),
    workflowRunId: text("workflow_run_id"),
    lastError: text("last_error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pendingIdx: index("verrail_outbox_events_pending_idx").on(
      table.status,
      table.availableAt,
      table.createdAt,
    ),
    aggregateIdx: index("verrail_outbox_events_aggregate_idx").on(
      table.aggregateType,
      table.aggregateId,
      table.createdAt,
    ),
    statusCheck: check(
      "verrail_outbox_events_status_check",
      sql`${table.status} IN ('pending', 'delivering', 'delivered', 'failed')`,
    ),
    attemptCountCheck: check(
      "verrail_outbox_events_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    deliveryClaimCheck: check(
      "verrail_outbox_events_delivery_claim_check",
      sql`${table.status} <> 'delivering' OR (${table.claimToken} IS NOT NULL AND ${table.claimedAt} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    deliveredCheck: check(
      "verrail_outbox_events_delivered_check",
      sql`${table.status} <> 'delivered' OR (${table.workflowId} IS NOT NULL AND ${table.publishedAt} IS NOT NULL)`,
    ),
  }),
);
