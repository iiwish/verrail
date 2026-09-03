import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { verrailTargetRevisions, verrailTargets } from "./verrail_targets.js";

/**
 * Adjudication data spine (G2.4): immutable submissions, delivery reviews,
 * and acceptances closing the trusted delivery loop (ontology 147-153).
 * All tables are workspace-scoped to companies.id; parent links use composite
 * (id, workspace_id) foreign keys. All three tables are immutable
 * (no updated_at) per ontology invariants 4 and 9; an acceptance is settled
 * by the outcome owner and is invalidated by derivation (not mutation) when a
 * newer submission or target revision appears (invariant 10).
 */
export const verrailSubmissions = pgTable(
  "verrail_submissions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id").notNull(),
    artifactRevisionIds: uuid("artifact_revision_ids").array().notNull(),
    verificationResultIds: uuid("verification_result_ids").array().notNull(),
    commitRef: text("commit_ref"),
    environmentSummary: text("environment_summary"),
    notes: text("notes"),
    submissionHash: text("submission_hash").notNull(),
    submittedByPrincipalType: text("submitted_by_principal_type").notNull(),
    submittedByPrincipalId: text("submitted_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_submissions_id_workspace_uq").on(table.id, table.workspaceId),
    targetHashUq: unique("verrail_submissions_target_hash_uq").on(table.targetId, table.submissionHash),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_submissions_target_workspace_fk",
    }).onDelete("restrict"),
    targetRevisionWorkspaceFk: foreignKey({
      columns: [table.targetRevisionId, table.workspaceId],
      foreignColumns: [verrailTargetRevisions.id, verrailTargetRevisions.workspaceId],
      name: "verrail_submissions_target_revision_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetCreatedIdx: index("verrail_submissions_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    artifactRevisionIdsCheck: check(
      "verrail_submissions_artifact_revision_ids_check",
      sql`coalesce(array_length(${table.artifactRevisionIds}, 1), 0) > 0`,
    ),
  }),
);

export const verrailDeliveryReviews = pgTable(
  "verrail_delivery_reviews",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    reviewerPrincipalType: text("reviewer_principal_type").notNull(),
    reviewerPrincipalId: text("reviewer_principal_id").notNull(),
    verdict: text("verdict").notNull(),
    risks: text("risks"),
    unprovenItems: text("unproven_items").array().notNull(),
    comments: text("comments"),
    reviewHash: text("review_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_delivery_reviews_id_workspace_uq").on(table.id, table.workspaceId),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_delivery_reviews_target_workspace_fk",
    }).onDelete("restrict"),
    submissionWorkspaceFk: foreignKey({
      columns: [table.submissionId, table.workspaceId],
      foreignColumns: [verrailSubmissions.id, verrailSubmissions.workspaceId],
      name: "verrail_delivery_reviews_submission_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetCreatedIdx: index("verrail_delivery_reviews_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    submissionCreatedIdx: index("verrail_delivery_reviews_submission_created_idx").on(
      table.submissionId,
      table.createdAt,
    ),
    verdictCheck: check(
      "verrail_delivery_reviews_verdict_check",
      sql`${table.verdict} in ('approved', 'changes_requested', 'rejected')`,
    ),
    reviewerTypeCheck: check(
      "verrail_delivery_reviews_reviewer_type_check",
      sql`${table.reviewerPrincipalType} = 'user'`,
    ),
  }),
);

export const verrailAcceptances = pgTable(
  "verrail_acceptances",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    reviewId: uuid("review_id").notNull(),
    authority: text("authority").notNull(),
    acceptedByPrincipalType: text("accepted_by_principal_type").notNull(),
    acceptedByPrincipalId: text("accepted_by_principal_id").notNull(),
    acceptanceHash: text("acceptance_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_acceptances_id_workspace_uq").on(table.id, table.workspaceId),
    submissionUq: unique("verrail_acceptances_submission_uq").on(table.submissionId),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_acceptances_target_workspace_fk",
    }).onDelete("restrict"),
    targetRevisionWorkspaceFk: foreignKey({
      columns: [table.targetRevisionId, table.workspaceId],
      foreignColumns: [verrailTargetRevisions.id, verrailTargetRevisions.workspaceId],
      name: "verrail_acceptances_target_revision_workspace_fk",
    }).onDelete("restrict"),
    submissionWorkspaceFk: foreignKey({
      columns: [table.submissionId, table.workspaceId],
      foreignColumns: [verrailSubmissions.id, verrailSubmissions.workspaceId],
      name: "verrail_acceptances_submission_workspace_fk",
    }).onDelete("restrict"),
    reviewWorkspaceFk: foreignKey({
      columns: [table.reviewId, table.workspaceId],
      foreignColumns: [verrailDeliveryReviews.id, verrailDeliveryReviews.workspaceId],
      name: "verrail_acceptances_review_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetCreatedIdx: index("verrail_acceptances_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    authorityCheck: check(
      "verrail_acceptances_authority_check",
      sql`${table.authority} = 'outcome_owner'`,
    ),
    acceptedByTypeCheck: check(
      "verrail_acceptances_accepted_by_type_check",
      sql`${table.acceptedByPrincipalType} = 'user'`,
    ),
  }),
);
