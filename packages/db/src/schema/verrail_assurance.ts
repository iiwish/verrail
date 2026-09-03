import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { verrailRuns, verrailWorkNodes } from "./verrail_delivery.js";
import { verrailTargetRevisions, verrailTargets } from "./verrail_targets.js";

/**
 * Assurance data spine (G2.3): artifacts, content-addressed artifact
 * revisions, claims, and immutable evidence + verification results.
 * All tables are workspace-scoped to companies.id; parent links use composite
 * (id, workspace_id) foreign keys. Evidence and VerificationResult are
 * immutable (no updated_at) per ontology invariants 4 and 9.
 */
export const verrailArtifacts = pgTable(
  "verrail_artifacts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_artifacts_id_workspace_uq").on(table.id, table.workspaceId),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_artifacts_target_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetCreatedIdx: index("verrail_artifacts_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    kindCheck: check(
      "verrail_artifacts_kind_check",
      sql`${table.kind} in ('code_change', 'document', 'report', 'external_reference')`,
    ),
  }),
);

export const verrailArtifactRevisions = pgTable(
  "verrail_artifact_revisions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    contentHash: text("content_hash").notNull(),
    contentRef: text("content_ref").notNull(),
    sourceRunId: uuid("source_run_id"),
    sourceWorkNodeId: uuid("source_work_node_id"),
    baseRevisionId: uuid("base_revision_id"),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_artifact_revisions_id_workspace_uq").on(table.id, table.workspaceId),
    artifactNumberUq: uniqueIndex("verrail_artifact_revisions_artifact_number_uq").on(
      table.artifactId,
      table.revisionNumber,
    ),
    artifactHashUq: uniqueIndex("verrail_artifact_revisions_artifact_hash_uq").on(
      table.artifactId,
      table.contentHash,
    ),
    artifactWorkspaceFk: foreignKey({
      columns: [table.artifactId, table.workspaceId],
      foreignColumns: [verrailArtifacts.id, verrailArtifacts.workspaceId],
      name: "verrail_artifact_revisions_artifact_workspace_fk",
    }).onDelete("restrict"),
    runWorkspaceFk: foreignKey({
      columns: [table.sourceRunId, table.workspaceId],
      foreignColumns: [verrailRuns.id, verrailRuns.workspaceId],
      name: "verrail_artifact_revisions_run_workspace_fk",
    }).onDelete("restrict"),
    workNodeWorkspaceFk: foreignKey({
      columns: [table.sourceWorkNodeId, table.workspaceId],
      foreignColumns: [verrailWorkNodes.id, verrailWorkNodes.workspaceId],
      name: "verrail_artifact_revisions_work_node_workspace_fk",
    }).onDelete("restrict"),
    baseRevisionWorkspaceFk: foreignKey({
      columns: [table.baseRevisionId, table.workspaceId],
      // Self-FK: referencing the exported const here is a TS7022 circular reference.
      foreignColumns: [table.id, table.workspaceId],
      name: "verrail_artifact_revisions_base_revision_workspace_fk",
    }).onDelete("restrict"),
    revisionNumberCheck: check(
      "verrail_artifact_revisions_revision_number_check",
      sql`${table.revisionNumber} >= 1`,
    ),
  }),
);

export const verrailClaims = pgTable(
  "verrail_claims",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id").notNull(),
    criterionKey: text("criterion_key").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("open"),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_claims_id_workspace_uq").on(table.id, table.workspaceId),
    openCriterionUq: uniqueIndex("verrail_claims_target_revision_criterion_open_uq")
      .on(table.targetRevisionId, table.criterionKey)
      .where(sql`${table.status} = 'open'`),
    targetRevisionWorkspaceFk: foreignKey({
      columns: [table.targetRevisionId, table.workspaceId],
      foreignColumns: [verrailTargetRevisions.id, verrailTargetRevisions.workspaceId],
      name: "verrail_claims_target_revision_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetCreatedIdx: index("verrail_claims_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    criterionKeyCheck: check(
      "verrail_claims_criterion_key_check",
      sql`char_length(${table.criterionKey}) between 1 and 100`,
    ),
    statusCheck: check(
      "verrail_claims_status_check",
      sql`${table.status} in ('open', 'supported', 'refuted', 'waived')`,
    ),
  }),
);

export const verrailEvidence = pgTable(
  "verrail_evidence",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    claimId: uuid("claim_id"),
    kind: text("kind").notNull(),
    producerPrincipalType: text("producer_principal_type").notNull(),
    producerPrincipalId: text("producer_principal_id").notNull(),
    objectHash: text("object_hash").notNull(),
    reference: text("reference").notNull(),
    trustLevel: text("trust_level").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_evidence_id_workspace_uq").on(table.id, table.workspaceId),
    claimWorkspaceFk: foreignKey({
      columns: [table.claimId, table.workspaceId],
      foreignColumns: [verrailClaims.id, verrailClaims.workspaceId],
      name: "verrail_evidence_claim_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetRecordedIdx: index("verrail_evidence_workspace_target_recorded_idx").on(
      table.workspaceId,
      table.targetId,
      table.recordedAt,
    ),
    claimRecordedIdx: index("verrail_evidence_claim_recorded_idx").on(table.claimId, table.recordedAt),
    kindCheck: check(
      "verrail_evidence_kind_check",
      sql`${table.kind} in ('ci_result', 'scan_result', 'human_review', 'agent_observation', 'external_reference')`,
    ),
    producerTypeCheck: check(
      "verrail_evidence_producer_type_check",
      sql`${table.producerPrincipalType} in ('user', 'service', 'agent')`,
    ),
    trustLevelCheck: check(
      "verrail_evidence_trust_level_check",
      sql`${table.trustLevel} in ('high', 'medium', 'low')`,
    ),
    agentTrustCheck: check(
      "verrail_evidence_agent_trust_check",
      sql`${table.producerPrincipalType} <> 'agent' or (${table.kind} = 'agent_observation' and ${table.trustLevel} = 'low')`,
    ),
  }),
);

export const verrailVerificationResults = pgTable(
  "verrail_verification_results",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    claimId: uuid("claim_id").notNull(),
    verdict: text("verdict").notNull(),
    verifierVersion: text("verifier_version").notNull(),
    evidenceIds: uuid("evidence_ids").array().notNull(),
    waiverReference: text("waiver_reference"),
    resultHash: text("result_hash").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_verification_results_id_workspace_uq").on(table.id, table.workspaceId),
    claimHashUq: uniqueIndex("verrail_verification_results_claim_hash_uq").on(table.claimId, table.resultHash),
    claimWorkspaceFk: foreignKey({
      columns: [table.claimId, table.workspaceId],
      foreignColumns: [verrailClaims.id, verrailClaims.workspaceId],
      name: "verrail_verification_results_claim_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetCreatedIdx: index("verrail_verification_results_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    claimCreatedIdx: index("verrail_verification_results_claim_created_idx").on(table.claimId, table.createdAt),
    verdictCheck: check(
      "verrail_verification_results_verdict_check",
      sql`${table.verdict} in ('passed', 'failed', 'inconclusive', 'waived')`,
    ),
    evidenceCheck: check(
      "verrail_verification_results_evidence_check",
      sql`${table.verdict} = 'waived' or coalesce(array_length(${table.evidenceIds}, 1), 0) > 0`,
    ),
    waiverCheck: check(
      "verrail_verification_results_waiver_check",
      sql`(${table.verdict} = 'waived') = (${table.waiverReference} is not null)`,
    ),
  }),
);
