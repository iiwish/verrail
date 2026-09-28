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
import { verrailArtifactRevisions } from "./verrail_assurance.js";
import { verrailGraphRevisions, verrailWorkNodes } from "./verrail_delivery.js";
import { verrailTargetRevisions, verrailTargets } from "./verrail_targets.js";

/** Immutable, version-bound submissions for HumanTask nodes. */
export const verrailHumanWorkResults = pgTable(
  "verrail_human_work_results",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id").notNull(),
    graphRevisionId: uuid("graph_revision_id").notNull(),
    workNodeId: uuid("work_node_id").notNull(),
    submittedByPrincipalType: text("submitted_by_principal_type").notNull(),
    submittedByPrincipalId: text("submitted_by_principal_id").notNull(),
    inputHash: text("input_hash").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    artifactRevisionId: uuid("artifact_revision_id"),
    attachmentHashes: text("attachment_hashes").array().notNull().default(sql`'{}'::text[]`),
    resultHash: text("result_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_human_work_results_id_workspace_uq").on(table.id, table.workspaceId),
    principalIdempotencyUq: uniqueIndex("verrail_human_work_results_principal_idempotency_uq").on(
      table.workspaceId,
      table.submittedByPrincipalType,
      table.submittedByPrincipalId,
      table.idempotencyKey,
    ),
    nodeCreatedIdx: index("verrail_human_work_results_node_created_idx").on(table.workNodeId, table.createdAt),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_human_work_results_target_workspace_fk",
    }).onDelete("restrict"),
    targetRevisionWorkspaceFk: foreignKey({
      columns: [table.targetRevisionId, table.workspaceId],
      foreignColumns: [verrailTargetRevisions.id, verrailTargetRevisions.workspaceId],
      name: "verrail_human_work_results_target_revision_workspace_fk",
    }).onDelete("restrict"),
    graphWorkspaceFk: foreignKey({
      columns: [table.graphRevisionId, table.workspaceId],
      foreignColumns: [verrailGraphRevisions.id, verrailGraphRevisions.workspaceId],
      name: "verrail_human_work_results_graph_workspace_fk",
    }).onDelete("restrict"),
    nodeWorkspaceFk: foreignKey({
      columns: [table.workNodeId, table.workspaceId],
      foreignColumns: [verrailWorkNodes.id, verrailWorkNodes.workspaceId],
      name: "verrail_human_work_results_node_workspace_fk",
    }).onDelete("restrict"),
    artifactRevisionWorkspaceFk: foreignKey({
      columns: [table.artifactRevisionId, table.workspaceId],
      foreignColumns: [verrailArtifactRevisions.id, verrailArtifactRevisions.workspaceId],
      name: "verrail_human_work_results_artifact_revision_workspace_fk",
    }).onDelete("restrict"),
    submitterTypeCheck: check("verrail_human_work_results_submitter_type_check", sql`${table.submittedByPrincipalType} = 'user'`),
    inputHashCheck: check("verrail_human_work_results_input_hash_check", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
    resultHashCheck: check("verrail_human_work_results_result_hash_check", sql`${table.resultHash} ~ '^[0-9a-f]{64}$'`),
  }),
);
