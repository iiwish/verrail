import { sql } from "drizzle-orm";
import {
  boolean,
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
import { agents } from "./agents.js";

export const verrailAgentDefinitions = pgTable(
  "verrail_agent_definitions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    compatibilityAgentId: uuid("compatibility_agent_id").references(() => agents.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_agent_definitions_id_workspace_uq").on(table.id, table.workspaceId),
    workspaceNameUq: uniqueIndex("verrail_agent_definitions_workspace_name_uq").on(table.workspaceId, table.name),
    compatibilityAgentUq: uniqueIndex("verrail_agent_definitions_compat_agent_uq").on(table.compatibilityAgentId),
    workspaceUpdatedIdx: index("verrail_agent_definitions_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
    statusCheck: check("verrail_agent_definitions_status_check", sql`${table.status} in ('draft', 'published', 'retired')`),
  }),
);

export const verrailAgentVersions = pgTable(
  "verrail_agent_versions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentDefinitionId: uuid("agent_definition_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    runtime: text("runtime").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt").notNull(),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    tools: jsonb("tools").$type<string[]>().notNull().default([]),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>().notNull().default({}),
    capabilityCeiling: jsonb("capability_ceiling").$type<string[]>().notNull().default([]),
    supplyChain: jsonb("supply_chain").$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text("content_hash").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_agent_versions_id_workspace_uq").on(table.id, table.workspaceId),
    definitionVersionUq: uniqueIndex("verrail_agent_versions_definition_number_uq").on(table.agentDefinitionId, table.versionNumber),
    definitionHashUq: uniqueIndex("verrail_agent_versions_definition_hash_uq").on(table.agentDefinitionId, table.contentHash),
    definitionWorkspaceFk: foreignKey({
      columns: [table.agentDefinitionId, table.workspaceId],
      foreignColumns: [verrailAgentDefinitions.id, verrailAgentDefinitions.workspaceId],
      name: "verrail_agent_versions_definition_workspace_fk",
    }).onDelete("restrict"),
  }),
);

export const verrailEvaluationRuns = pgTable(
  "verrail_evaluation_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    candidateAgentVersionId: uuid("candidate_agent_version_id").notNull(),
    baselineAgentVersionId: uuid("baseline_agent_version_id"),
    status: text("status").notNull(),
    qualityScore: integer("quality_score"),
    costCents: integer("cost_cents"),
    latencyMs: integer("latency_ms"),
    safetyStatus: text("safety_status").notNull(),
    summary: text("summary"),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_evaluation_runs_id_workspace_uq").on(table.id, table.workspaceId),
    candidateWorkspaceFk: foreignKey({
      columns: [table.candidateAgentVersionId, table.workspaceId],
      foreignColumns: [verrailAgentVersions.id, verrailAgentVersions.workspaceId],
      name: "verrail_evaluation_runs_candidate_workspace_fk",
    }).onDelete("restrict"),
    baselineWorkspaceFk: foreignKey({
      columns: [table.baselineAgentVersionId, table.workspaceId],
      foreignColumns: [verrailAgentVersions.id, verrailAgentVersions.workspaceId],
      name: "verrail_evaluation_runs_baseline_workspace_fk",
    }).onDelete("restrict"),
    candidateCreatedIdx: index("verrail_evaluation_runs_candidate_created_idx").on(table.candidateAgentVersionId, table.createdAt),
    statusCheck: check("verrail_evaluation_runs_status_check", sql`${table.status} in ('passed', 'failed', 'inconclusive')`),
    safetyCheck: check("verrail_evaluation_runs_safety_check", sql`${table.safetyStatus} in ('passed', 'failed', 'not_run')`),
  }),
);

export const verrailDeployments = pgTable(
  "verrail_deployments",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentDefinitionId: uuid("agent_definition_id").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    isDefault: boolean("is_default").notNull().default(false),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_deployments_id_workspace_uq").on(table.id, table.workspaceId),
    workspaceNameUq: uniqueIndex("verrail_deployments_workspace_name_uq").on(table.workspaceId, table.name),
    workspaceDefaultUq: uniqueIndex("verrail_deployments_workspace_default_uq").on(table.workspaceId).where(sql`${table.isDefault}`),
    definitionWorkspaceFk: foreignKey({
      columns: [table.agentDefinitionId, table.workspaceId],
      foreignColumns: [verrailAgentDefinitions.id, verrailAgentDefinitions.workspaceId],
      name: "verrail_deployments_definition_workspace_fk",
    }).onDelete("restrict"),
    statusCheck: check("verrail_deployments_status_check", sql`${table.status} in ('active', 'paused', 'retired')`),
  }),
);

export const verrailDeploymentRevisions = pgTable(
  "verrail_deployment_revisions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    evaluationRunId: uuid("evaluation_run_id").notNull(),
    state: text("state").notNull(),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text("content_hash").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_deployment_revisions_id_workspace_uq").on(table.id, table.workspaceId),
    deploymentRevisionUq: uniqueIndex("verrail_deployment_revisions_deployment_number_uq").on(table.deploymentId, table.revisionNumber),
    deploymentWorkspaceFk: foreignKey({
      columns: [table.deploymentId, table.workspaceId],
      foreignColumns: [verrailDeployments.id, verrailDeployments.workspaceId],
      name: "verrail_deployment_revisions_deployment_workspace_fk",
    }).onDelete("restrict"),
    versionWorkspaceFk: foreignKey({
      columns: [table.agentVersionId, table.workspaceId],
      foreignColumns: [verrailAgentVersions.id, verrailAgentVersions.workspaceId],
      name: "verrail_deployment_revisions_version_workspace_fk",
    }).onDelete("restrict"),
    evaluationWorkspaceFk: foreignKey({
      columns: [table.evaluationRunId, table.workspaceId],
      foreignColumns: [verrailEvaluationRuns.id, verrailEvaluationRuns.workspaceId],
      name: "verrail_deployment_revisions_evaluation_workspace_fk",
    }).onDelete("restrict"),
    stateCheck: check("verrail_deployment_revisions_state_check", sql`${table.state} in ('active', 'paused', 'superseded', 'retired')`),
  }),
);

export const verrailAgentCommandReceipts = pgTable(
  "verrail_agent_command_receipts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    commandType: text("command_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    commandKeyUq: uniqueIndex("verrail_agent_command_receipts_key_uq").on(
      table.workspaceId,
      table.principalType,
      table.principalId,
      table.commandType,
      table.idempotencyKey,
    ),
  }),
);
