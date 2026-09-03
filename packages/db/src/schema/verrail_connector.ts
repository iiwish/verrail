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
import { verrailWorkNodes } from "./verrail_delivery.js";
import { verrailTargets } from "./verrail_targets.js";

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
    claimId: uuid("claim_id").notNull(),
    workNodeId: uuid("work_node_id"),
    provider: text("provider").notNull(),
    externalRef: text("external_ref").notNull(),
    conclusion: text("conclusion").notNull(),
    evidenceId: uuid("evidence_id").notNull(),
    verificationResultId: uuid("verification_result_id"),
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
        or (${table.conclusion} = 'neutral' and ${table.verificationResultId} is null)`,
    ),
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
    params: jsonb("params").$type<{ title: string; head: string; base: string }>().notNull(),
    paramsHash: text("params_hash").notNull(),
    status: text("status").notNull().default("pending_approval"),
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
      sql`${table.status} in ('pending_approval', 'approved', 'executed')`,
    ),
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
