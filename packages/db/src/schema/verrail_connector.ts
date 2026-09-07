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
import { toolConnections } from "./tool_access.js";
import {
  verrailClaims,
  verrailEvidence,
  verrailVerificationResults,
} from "./verrail_assurance.js";
import { verrailSubmissions } from "./verrail_adjudication.js";
import { verrailGraphRevisions, verrailWorkNodes } from "./verrail_delivery.js";
import { verrailTargetRevisions, verrailTargets } from "./verrail_targets.js";

/**
 * Connector data spine (G2.5): integration runs binding CI evidence and
 * verification results, governed pull-request action requests with
 * parameter-bound approvals, and immutable effect receipts for executed
 * external actions (ontology 111, 240, 242; invariants 4, 9, 10).
 * All tables are workspace-scoped to companies.id; parent links use composite
 * (id, workspace_id) foreign keys. Integration runs, approvals, and effect
 * receipts are immutable (no updated_at); action_requests carry the only
 * mutable columns in this slice (status + updated_at).
 */
export const verrailIntegrationRuns = pgTable(
  "verrail_integration_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id"),
    graphRevisionId: uuid("graph_revision_id"),
    claimId: uuid("claim_id").notNull(),
    workNodeId: uuid("work_node_id"),
    connectorVersion: text("connector_version"),
    connectionId: uuid("connection_id"),
    provider: text("provider").notNull(),
    externalRef: text("external_ref").notNull(),
    commitRef: text("commit_ref"),
    criterionKey: text("criterion_key"),
    environmentRef: text("environment_ref"),
    conclusion: text("conclusion").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    verificationResultId: uuid("verification_result_id"),
    providerReceipt: jsonb("provider_receipt").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key"),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_integration_runs_id_workspace_uq").on(table.id, table.workspaceId),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_integration_runs_target_workspace_fk",
    }).onDelete("restrict"),
    targetRevisionWorkspaceFk: foreignKey({
      columns: [table.targetRevisionId, table.workspaceId],
      foreignColumns: [verrailTargetRevisions.id, verrailTargetRevisions.workspaceId],
      name: "verrail_integration_runs_target_revision_workspace_fk",
    }).onDelete("restrict"),
    graphWorkspaceFk: foreignKey({
      columns: [table.graphRevisionId, table.workspaceId],
      foreignColumns: [verrailGraphRevisions.id, verrailGraphRevisions.workspaceId],
      name: "verrail_integration_runs_graph_workspace_fk",
    }).onDelete("restrict"),
    claimWorkspaceFk: foreignKey({
      columns: [table.claimId, table.workspaceId],
      foreignColumns: [verrailClaims.id, verrailClaims.workspaceId],
      name: "verrail_integration_runs_claim_workspace_fk",
    }).onDelete("restrict"),
    workNodeWorkspaceFk: foreignKey({
      columns: [table.workNodeId, table.workspaceId],
      foreignColumns: [verrailWorkNodes.id, verrailWorkNodes.workspaceId],
      name: "verrail_integration_runs_work_node_workspace_fk",
    }).onDelete("restrict"),
    evidenceWorkspaceFk: foreignKey({
      columns: [table.evidenceId, table.workspaceId],
      foreignColumns: [verrailEvidence.id, verrailEvidence.workspaceId],
      name: "verrail_integration_runs_evidence_workspace_fk",
    }).onDelete("restrict"),
    verificationResultWorkspaceFk: foreignKey({
      columns: [table.verificationResultId, table.workspaceId],
      foreignColumns: [verrailVerificationResults.id, verrailVerificationResults.workspaceId],
      name: "verrail_integration_runs_verification_result_workspace_fk",
    }).onDelete("restrict"),
    connectionFk: foreignKey({
      columns: [table.connectionId],
      foreignColumns: [toolConnections.id],
      name: "verrail_integration_runs_connection_fk",
    }).onDelete("restrict"),
    workspaceIdempotencyUq: uniqueIndex("verrail_integration_runs_workspace_idempotency_uq")
      .on(table.workspaceId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    workspaceTargetCreatedIdx: index("verrail_integration_runs_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    providerCheck: check(
      "verrail_integration_runs_provider_check",
      sql`${table.provider} = 'github'`,
    ),
    conclusionCheck: check(
      "verrail_integration_runs_conclusion_check",
      sql`${table.conclusion} in ('success', 'failure', 'neutral')`,
    ),
    verificationConclusionCheck: check(
      "verrail_integration_runs_verification_conclusion_check",
      sql`(${table.conclusion} in ('success', 'failure') and ${table.verificationResultId} is not null)
        or (${table.conclusion} = 'neutral')`,
    ),
  }),
);

export const verrailIntegrationAttempts = pgTable(
  "verrail_integration_attempts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    integrationRunId: uuid("integration_run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    connectorVersion: text("connector_version").notNull(),
    connectionId: uuid("connection_id").notNull(),
    providerRef: text("provider_ref").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerReceipt: jsonb("provider_receipt").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_integration_attempts_id_workspace_uq").on(table.id, table.workspaceId),
    runAttemptUq: uniqueIndex("verrail_integration_attempts_run_number_uq").on(table.integrationRunId, table.attemptNumber),
    connectionIdempotencyUq: uniqueIndex("verrail_integration_attempts_connection_idempotency_uq").on(
      table.workspaceId,
      table.connectionId,
      table.idempotencyKey,
    ),
    runWorkspaceFk: foreignKey({
      columns: [table.integrationRunId, table.workspaceId],
      foreignColumns: [verrailIntegrationRuns.id, verrailIntegrationRuns.workspaceId],
      name: "verrail_integration_attempts_run_workspace_fk",
    }).onDelete("restrict"),
    connectionFk: foreignKey({
      columns: [table.connectionId],
      foreignColumns: [toolConnections.id],
      name: "verrail_integration_attempts_connection_fk",
    }).onDelete("restrict"),
    attemptNumberCheck: check("verrail_integration_attempts_number_check", sql`${table.attemptNumber} > 0`),
    statusCheck: check("verrail_integration_attempts_status_check", sql`${table.status} in ('succeeded', 'failed', 'neutral')`),
  }),
);

export const verrailActionRequests = pgTable(
  "verrail_action_requests",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    actionType: text("action_type").notNull(),
    params: jsonb("params").$type<{ title: string; head: string; base: string; body?: string }>().notNull(),
    paramsHash: text("params_hash").notNull(),
    expectedCommitRef: text("expected_commit_ref"),
    status: text("status").notNull().default("pending_approval"),
    providerMarker: text("provider_marker"),
    executionAttemptCount: integer("execution_attempt_count").notNull().default(0),
    executionStartedAt: timestamp("execution_started_at", { withTimezone: true }),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    requestedByPrincipalType: text("requested_by_principal_type").notNull(),
    requestedByPrincipalId: text("requested_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_action_requests_id_workspace_uq").on(table.id, table.workspaceId),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_action_requests_target_workspace_fk",
    }).onDelete("restrict"),
    submissionWorkspaceFk: foreignKey({
      columns: [table.submissionId, table.workspaceId],
      foreignColumns: [verrailSubmissions.id, verrailSubmissions.workspaceId],
      name: "verrail_action_requests_submission_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetCreatedIdx: index("verrail_action_requests_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    submissionCreatedIdx: index("verrail_action_requests_submission_created_idx").on(
      table.submissionId,
      table.createdAt,
    ),
    actionTypeCheck: check(
      "verrail_action_requests_action_type_check",
      sql`${table.actionType} = 'create_pull_request'`,
    ),
    statusCheck: check(
      "verrail_action_requests_status_check",
      sql`${table.status} in ('pending_approval', 'approved', 'executing', 'unknown_effect', 'executed')`,
    ),
    providerMarkerCheck: check(
      "verrail_action_requests_provider_marker_check",
      sql`(${table.status} in ('pending_approval', 'approved') and ${table.providerMarker} is null)
        or (${table.status} in ('executing', 'unknown_effect', 'executed') and ${table.providerMarker} ~ '^[0-9a-f]{64}$')`,
    ),
    executionAttemptCountCheck: check(
      "verrail_action_requests_execution_attempt_count_check",
      sql`${table.executionAttemptCount} >= 0`,
    ),
    providerMarkerUq: uniqueIndex("verrail_action_requests_provider_marker_uq")
      .on(table.providerMarker)
      .where(sql`${table.providerMarker} is not null`),
    paramsKeysCheck: check(
      "verrail_action_requests_params_keys_check",
      sql`${table.params} ? 'title' and ${table.params} ? 'head' and ${table.params} ? 'base'`,
    ),
    paramsHashCheck: check(
      "verrail_action_requests_params_hash_check",
      sql`${table.paramsHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const verrailActionApprovals = pgTable(
  "verrail_action_approvals",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    actionRequestId: uuid("action_request_id").notNull(),
    approvedByPrincipalType: text("approved_by_principal_type").notNull(),
    approvedByPrincipalId: text("approved_by_principal_id").notNull(),
    paramsHash: text("params_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_action_approvals_id_workspace_uq").on(table.id, table.workspaceId),
    actionRequestUq: unique("verrail_action_approvals_action_request_uq").on(table.actionRequestId),
    actionRequestWorkspaceFk: foreignKey({
      columns: [table.actionRequestId, table.workspaceId],
      foreignColumns: [verrailActionRequests.id, verrailActionRequests.workspaceId],
      name: "verrail_action_approvals_action_request_workspace_fk",
    }).onDelete("restrict"),
    approverTypeCheck: check(
      "verrail_action_approvals_approver_type_check",
      sql`${table.approvedByPrincipalType} = 'user'`,
    ),
    paramsHashCheck: check(
      "verrail_action_approvals_params_hash_check",
      sql`${table.paramsHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const verrailEffectReceipts = pgTable(
  "verrail_effect_receipts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    actionRequestId: uuid("action_request_id").notNull(),
    actionType: text("action_type").notNull(),
    provider: text("provider").notNull(),
    providerMarker: text("provider_marker").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    externalUrl: text("external_url").notNull(),
    effectHash: text("effect_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_effect_receipts_id_workspace_uq").on(table.id, table.workspaceId),
    actionRequestUq: unique("verrail_effect_receipts_action_request_uq").on(table.actionRequestId),
    providerMarkerUq: unique("verrail_effect_receipts_provider_marker_uq").on(table.providerMarker),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_effect_receipts_target_workspace_fk",
    }).onDelete("restrict"),
    actionRequestWorkspaceFk: foreignKey({
      columns: [table.actionRequestId, table.workspaceId],
      foreignColumns: [verrailActionRequests.id, verrailActionRequests.workspaceId],
      name: "verrail_effect_receipts_action_request_workspace_fk",
    }).onDelete("restrict"),
    workspaceTargetCreatedIdx: index("verrail_effect_receipts_workspace_target_created_idx").on(
      table.workspaceId,
      table.targetId,
      table.createdAt,
    ),
    actionTypeCheck: check(
      "verrail_effect_receipts_action_type_check",
      sql`${table.actionType} = 'create_pull_request'`,
    ),
    providerCheck: check(
      "verrail_effect_receipts_provider_check",
      sql`${table.provider} = 'github'`,
    ),
    effectHashCheck: check(
      "verrail_effect_receipts_effect_hash_check",
      sql`${table.effectHash} ~ '^[0-9a-f]{64}$'`,
    ),
    providerMarkerCheck: check(
      "verrail_effect_receipts_provider_marker_check",
      sql`${table.providerMarker} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

/**
 * Workspace-scoped GitHub repo binding for the connector slice: tool_connections
 * carries no repo owner/name field, so the binding lives here (one per
 * workspace) and points at the connection that supplies credentials.
 */
export const verrailGithubRepoBindings = pgTable(
  "verrail_github_repo_bindings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_github_repo_bindings_id_workspace_uq").on(table.id, table.workspaceId),
    workspaceUq: unique("verrail_github_repo_bindings_workspace_uq").on(table.workspaceId),
    // Single-column FK to the connection PK: a composite FK over
    // (workspace_id, connection_id) would depend on the
    // tool_connections_company_id_uq constraint, which the connections-v3
    // migration machinery drops and recreates during rollback repair.
    connectionFk: foreignKey({
      columns: [table.connectionId],
      foreignColumns: [toolConnections.id],
      name: "verrail_github_repo_bindings_connection_fk",
    }).onDelete("restrict"),
    repoOwnerCheck: check(
      "verrail_github_repo_bindings_repo_owner_check",
      sql`char_length(${table.repoOwner}) between 1 and 200`,
    ),
    repoNameCheck: check(
      "verrail_github_repo_bindings_repo_name_check",
      sql`char_length(${table.repoName}) between 1 and 200`,
    ),
  }),
);

export const verrailCriterionProofs = pgTable("verrail_criterion_proofs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => companies.id),
  targetId: uuid("target_id").notNull(),
  targetRevisionId: uuid("target_revision_id").notNull(),
  graphRevisionId: uuid("graph_revision_id").notNull(),
  criterionKey: text("criterion_key").notNull(),
  requirementId: text("requirement_id").notNull(),
  phase: text("phase").notNull(),
  contractHash: text("contract_hash").notNull(),
  submissionId: uuid("submission_id"),
  effectReceiptId: uuid("effect_receipt_id"),
  verificationResultId: uuid("verification_result_id").notNull(),
  integrationRunId: uuid("integration_run_id").notNull(),
  contextHash: text("context_hash").notNull(),
  sourceIdentityHash: text("source_identity_hash"),
  sourcePayloadHash: text("source_payload_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  resultUq: unique("verrail_criterion_proofs_result_uq").on(table.verificationResultId),
  sourceUq: unique("verrail_criterion_proofs_source_uq").on(table.sourceIdentityHash),
  targetFk: foreignKey({ columns: [table.targetId, table.workspaceId], foreignColumns: [verrailTargets.id, verrailTargets.workspaceId], name: "verrail_criterion_proofs_target_fk" }),
  revisionFk: foreignKey({ columns: [table.targetRevisionId, table.workspaceId], foreignColumns: [verrailTargetRevisions.id, verrailTargetRevisions.workspaceId], name: "verrail_criterion_proofs_revision_fk" }),
  graphFk: foreignKey({ columns: [table.graphRevisionId, table.workspaceId], foreignColumns: [verrailGraphRevisions.id, verrailGraphRevisions.workspaceId], name: "verrail_criterion_proofs_graph_fk" }),
  submissionFk: foreignKey({ columns: [table.submissionId, table.workspaceId], foreignColumns: [verrailSubmissions.id, verrailSubmissions.workspaceId], name: "verrail_criterion_proofs_submission_fk" }),
  effectFk: foreignKey({ columns: [table.effectReceiptId, table.workspaceId], foreignColumns: [verrailEffectReceipts.id, verrailEffectReceipts.workspaceId], name: "verrail_criterion_proofs_effect_fk" }),
  resultFk: foreignKey({ columns: [table.verificationResultId, table.workspaceId], foreignColumns: [verrailVerificationResults.id, verrailVerificationResults.workspaceId], name: "verrail_criterion_proofs_result_fk" }),
  integrationFk: foreignKey({ columns: [table.integrationRunId, table.workspaceId], foreignColumns: [verrailIntegrationRuns.id, verrailIntegrationRuns.workspaceId], name: "verrail_criterion_proofs_integration_fk" }),
  lookupIdx: index("verrail_criterion_proofs_lookup_idx").on(table.workspaceId, table.targetId, table.targetRevisionId, table.criterionKey, table.requirementId, table.createdAt),
  phaseCheck: check("verrail_criterion_proofs_phase_check", sql`(${table.phase}='pre_acceptance' and ${table.submissionId} is null and ${table.effectReceiptId} is null) or (${table.phase}='post_effect' and ${table.submissionId} is not null and ${table.effectReceiptId} is not null)`),
  hashCheck: check("verrail_criterion_proofs_hash_check", sql`${table.contractHash} ~ '^[0-9a-f]{64}$' and ${table.contextHash} ~ '^[0-9a-f]{64}$'`),
  sourceHashCheck: check("verrail_criterion_proofs_source_hash_check", sql`(${table.sourceIdentityHash} is null and ${table.sourcePayloadHash} is null) or (${table.sourceIdentityHash} is not null and ${table.sourcePayloadHash} is not null and ${table.sourceIdentityHash} ~ '^[0-9a-f]{64}$' and ${table.sourcePayloadHash} ~ '^[0-9a-f]{64}$')`),
}));
