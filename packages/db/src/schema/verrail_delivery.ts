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
import { verrailTargetRevisions, verrailTargets } from "./verrail_targets.js";
import { verrailAgentVersions, verrailDeploymentRevisions } from "./verrail_agents.js";

export const verrailWorkGraphs = pgTable(
  "verrail_work_graphs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    activeGraphRevisionId: uuid("active_graph_revision_id"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_work_graphs_id_workspace_uq").on(table.id, table.workspaceId),
    targetUq: uniqueIndex("verrail_work_graphs_target_uq").on(table.targetId),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_work_graphs_target_workspace_fk",
    }).onDelete("cascade"),
    statusCheck: check("verrail_work_graphs_status_check", sql`${table.status} in ('draft', 'active', 'completed', 'canceled')`),
  }),
);

export const verrailGraphRevisions = pgTable(
  "verrail_graph_revisions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id").notNull(),
    workGraphId: uuid("work_graph_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    status: text("status").notNull().default("draft"),
    contentHash: text("content_hash").notNull(),
    createdByPrincipalType: text("created_by_principal_type").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_graph_revisions_id_workspace_uq").on(table.id, table.workspaceId),
    graphRevisionUq: uniqueIndex("verrail_graph_revisions_graph_number_uq").on(table.workGraphId, table.revisionNumber),
    targetWorkspaceFk: foreignKey({
      columns: [table.targetId, table.workspaceId],
      foreignColumns: [verrailTargets.id, verrailTargets.workspaceId],
      name: "verrail_graph_revisions_target_workspace_fk",
    }).onDelete("cascade"),
    targetRevisionWorkspaceFk: foreignKey({
      columns: [table.targetRevisionId, table.workspaceId],
      foreignColumns: [verrailTargetRevisions.id, verrailTargetRevisions.workspaceId],
      name: "verrail_graph_revisions_target_revision_workspace_fk",
    }).onDelete("restrict"),
    graphWorkspaceFk: foreignKey({
      columns: [table.workGraphId, table.workspaceId],
      foreignColumns: [verrailWorkGraphs.id, verrailWorkGraphs.workspaceId],
      name: "verrail_graph_revisions_graph_workspace_fk",
    }).onDelete("cascade"),
    statusCheck: check("verrail_graph_revisions_status_check", sql`${table.status} in ('draft', 'active', 'superseded', 'canceled')`),
  }),
);

export const verrailWorkNodes = pgTable(
  "verrail_work_nodes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    graphRevisionId: uuid("graph_revision_id").notNull(),
    nodeKey: text("node_key").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    stageKey: text("stage_key").notNull(),
    status: text("status").notNull().default("pending"),
    responsiblePrincipalType: text("responsible_principal_type"),
    responsiblePrincipalId: text("responsible_principal_id"),
    dependencyNodeKeys: jsonb("dependency_node_keys").$type<string[]>().notNull().default([]),
    completionDefinition: text("completion_definition").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_work_nodes_id_workspace_uq").on(table.id, table.workspaceId),
    graphNodeKeyUq: uniqueIndex("verrail_work_nodes_graph_key_uq").on(table.graphRevisionId, table.nodeKey),
    graphStatusIdx: index("verrail_work_nodes_graph_status_idx").on(table.graphRevisionId, table.status),
    graphWorkspaceFk: foreignKey({
      columns: [table.graphRevisionId, table.workspaceId],
      foreignColumns: [verrailGraphRevisions.id, verrailGraphRevisions.workspaceId],
      name: "verrail_work_nodes_graph_workspace_fk",
    }).onDelete("cascade"),
    kindCheck: check("verrail_work_nodes_kind_check", sql`${table.kind} in ('agent_task', 'human_task', 'integration_task', 'decision_gate', 'review_gate', 'acceptance_gate', 'policy_gate')`),
    stageCheck: check("verrail_work_nodes_stage_check", sql`${table.stageKey} in ('define', 'execute', 'verify', 'accept')`),
    statusCheck: check("verrail_work_nodes_status_check", sql`${table.status} in ('pending', 'ready', 'running', 'completed', 'blocked', 'canceled')`),
  }),
);

export const verrailRuns = pgTable(
  "verrail_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    targetRevisionId: uuid("target_revision_id").notNull(),
    graphRevisionId: uuid("graph_revision_id").notNull(),
    workNodeId: uuid("work_node_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("queued"),
    actorPrincipalType: text("actor_principal_type").notNull(),
    actorPrincipalId: text("actor_principal_id").notNull(),
    actorDisplayName: text("actor_display_name"),
    deploymentRevisionId: uuid("deployment_revision_id"),
    agentVersionId: uuid("agent_version_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_runs_id_workspace_uq").on(table.id, table.workspaceId),
    workspaceIdempotencyUq: uniqueIndex("verrail_runs_workspace_idempotency_uq").on(table.workspaceId, table.idempotencyKey),
    targetCreatedIdx: index("verrail_runs_target_created_idx").on(table.workspaceId, table.targetId, table.createdAt),
    nodeWorkspaceFk: foreignKey({
      columns: [table.workNodeId, table.workspaceId],
      foreignColumns: [verrailWorkNodes.id, verrailWorkNodes.workspaceId],
      name: "verrail_runs_node_workspace_fk",
    }).onDelete("restrict"),
    deploymentRevisionWorkspaceFk: foreignKey({
      columns: [table.deploymentRevisionId, table.workspaceId],
      foreignColumns: [verrailDeploymentRevisions.id, verrailDeploymentRevisions.workspaceId],
      name: "verrail_runs_deployment_revision_workspace_fk",
    }).onDelete("restrict"),
    agentVersionWorkspaceFk: foreignKey({
      columns: [table.agentVersionId, table.workspaceId],
      foreignColumns: [verrailAgentVersions.id, verrailAgentVersions.workspaceId],
      name: "verrail_runs_agent_version_workspace_fk",
    }).onDelete("restrict"),
    kindCheck: check("verrail_runs_kind_check", sql`${table.kind} in ('agent', 'integration')`),
    statusCheck: check("verrail_runs_status_check", sql`${table.status} in ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'canceled')`),
  }),
);
