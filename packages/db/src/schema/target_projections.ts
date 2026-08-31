import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const targetProjectionSources = pgTable(
  "target_projection_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    projectionPolicyVersion: text("projection_policy_version").notNull(),
    eligibilityReason: text("eligibility_reason").notNull(),
    activeTargetRevisionId: uuid("active_target_revision_id").notNull(),
    sourceRevisionKey: text("source_revision_key").notNull(),
    sourceSnapshotHash: text("source_snapshot_hash").notNull(),
    lastProjectedAt: timestamp("last_projected_at", { withTimezone: true }).notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceSourceUq: uniqueIndex("target_projection_sources_workspace_source_uq").on(
      table.workspaceId,
      table.sourceType,
      table.sourceId,
    ),
    workspaceTargetUq: uniqueIndex("target_projection_sources_workspace_target_uq").on(
      table.workspaceId,
      table.targetId,
    ),
    workspaceActiveIdx: index("target_projection_sources_workspace_active_idx").on(
      table.workspaceId,
      table.disabledAt,
      table.updatedAt,
    ),
    sourceTypeCheck: check(
      "target_projection_sources_source_type_check",
      sql`${table.sourceType} in ('case', 'issue')`,
    ),
    eligibilityCheck: check(
      "target_projection_sources_eligibility_check",
      sql`${table.eligibilityReason} in ('explicit_marker', 'approved_backfill', 'operator_mapping')`,
    ),
  }),
);

export const targetProjectionRevisions = pgTable(
  "target_projection_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id").notNull(),
    projectionPolicyVersion: text("projection_policy_version").notNull(),
    sourceRevisionKey: text("source_revision_key").notNull(),
    sourceSnapshotHash: text("source_snapshot_hash").notNull(),
    schemaVersion: text("schema_version").notNull().default("1"),
    projection: jsonb("projection").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetRevisionUq: uniqueIndex("target_projection_revisions_target_revision_uq").on(
      table.targetRevisionId,
    ),
    workspaceTargetCreatedIdx: index("target_projection_revisions_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
  }),
);
