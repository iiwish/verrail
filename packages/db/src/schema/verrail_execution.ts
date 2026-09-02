import { sql } from "drizzle-orm";
import {
  bigint,
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
import { verrailAgentVersions, verrailDeploymentRevisions } from "./verrail_agents.js";
import { verrailRuns } from "./verrail_delivery.js";

export const verrailRunAttempts = pgTable(
  "verrail_run_attempts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    deploymentRevisionId: uuid("deployment_revision_id").notNull(),
    agentVersionId: uuid("agent_version_id").notNull(),
    runtimeProfile: text("runtime_profile").notNull(),
    executorPrincipalType: text("executor_principal_type").notNull(),
    executorPrincipalId: text("executor_principal_id").notNull(),
    fencingToken: bigint("fencing_token", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    lastEventCursor: bigint("last_event_cursor", { mode: "number" }).notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_run_attempts_id_workspace_uq").on(table.id, table.workspaceId),
    idRunWorkspaceUq: unique("verrail_run_attempts_id_run_workspace_uq").on(table.id, table.runId, table.workspaceId),
    runAttemptUq: uniqueIndex("verrail_run_attempts_run_number_uq").on(table.runId, table.attemptNumber),
    runFenceUq: uniqueIndex("verrail_run_attempts_run_fence_uq").on(table.runId, table.fencingToken),
    runIdempotencyUq: uniqueIndex("verrail_run_attempts_run_idempotency_uq").on(table.runId, table.idempotencyKey),
    runWorkspaceFk: foreignKey({
      columns: [table.runId, table.workspaceId],
      foreignColumns: [verrailRuns.id, verrailRuns.workspaceId],
      name: "verrail_run_attempts_run_workspace_fk",
    }).onDelete("cascade"),
    deploymentRevisionWorkspaceFk: foreignKey({
      columns: [table.deploymentRevisionId, table.workspaceId],
      foreignColumns: [verrailDeploymentRevisions.id, verrailDeploymentRevisions.workspaceId],
      name: "verrail_run_attempts_deployment_revision_workspace_fk",
    }).onDelete("restrict"),
    agentVersionWorkspaceFk: foreignKey({
      columns: [table.agentVersionId, table.workspaceId],
      foreignColumns: [verrailAgentVersions.id, verrailAgentVersions.workspaceId],
      name: "verrail_run_attempts_agent_version_workspace_fk",
    }).onDelete("restrict"),
    statusCheck: check("verrail_run_attempts_status_check", sql`${table.status} in ('pending', 'running', 'cancel_requested', 'cancel_acknowledged', 'succeeded', 'failed', 'canceled', 'superseded')`),
    runtimeProfileCheck: check("verrail_run_attempts_runtime_profile_check", sql`${table.runtimeProfile} in ('host_trusted')`),
    executorTypeCheck: check("verrail_run_attempts_executor_type_check", sql`${table.executorPrincipalType} in ('service')`),
    positiveAttemptCheck: check("verrail_run_attempts_positive_attempt_check", sql`${table.attemptNumber} > 0 and ${table.fencingToken} > 0`),
  }),
);

export const verrailExecutionLeases = pgTable(
  "verrail_execution_leases",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    runAttemptId: uuid("run_attempt_id").notNull(),
    executorPrincipalId: text("executor_principal_id").notNull(),
    runtimeProfile: text("runtime_profile").notNull(),
    fencingToken: bigint("fencing_token", { mode: "number" }).notNull(),
    status: text("status").notNull().default("offered"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    graceExpiresAt: timestamp("grace_expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_execution_leases_id_workspace_uq").on(table.id, table.workspaceId),
    attemptUq: uniqueIndex("verrail_execution_leases_attempt_uq").on(table.runAttemptId),
    activeRunUq: uniqueIndex("verrail_execution_leases_active_run_uq").on(table.runId).where(sql`${table.status} in ('offered', 'active', 'suspect')`),
    attemptRunWorkspaceFk: foreignKey({
      columns: [table.runAttemptId, table.runId, table.workspaceId],
      foreignColumns: [verrailRunAttempts.id, verrailRunAttempts.runId, verrailRunAttempts.workspaceId],
      name: "verrail_execution_leases_attempt_run_workspace_fk",
    }).onDelete("cascade"),
    statusCheck: check("verrail_execution_leases_status_check", sql`${table.status} in ('offered', 'active', 'suspect', 'expired', 'released', 'revoked')`),
    runtimeProfileCheck: check("verrail_execution_leases_runtime_profile_check", sql`${table.runtimeProfile} in ('host_trusted')`),
    positiveFenceCheck: check("verrail_execution_leases_positive_fence_check", sql`${table.fencingToken} > 0`),
  }),
);

export const verrailRunEvents = pgTable(
  "verrail_run_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    runAttemptId: uuid("run_attempt_id").notNull(),
    cursor: bigint("cursor", { mode: "number" }).notNull(),
    fencingToken: bigint("fencing_token", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text("content_hash").notNull(),
    emittedAt: timestamp("emitted_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_run_events_id_workspace_uq").on(table.id, table.workspaceId),
    attemptCursorUq: uniqueIndex("verrail_run_events_attempt_cursor_uq").on(table.runAttemptId, table.cursor),
    runReceivedIdx: index("verrail_run_events_run_received_idx").on(table.workspaceId, table.runId, table.receivedAt),
    attemptRunWorkspaceFk: foreignKey({
      columns: [table.runAttemptId, table.runId, table.workspaceId],
      foreignColumns: [verrailRunAttempts.id, verrailRunAttempts.runId, verrailRunAttempts.workspaceId],
      name: "verrail_run_events_attempt_run_workspace_fk",
    }).onDelete("cascade"),
    typeCheck: check("verrail_run_events_type_check", sql`${table.eventType} in ('claimed', 'heartbeat', 'started', 'progress', 'succeeded', 'failed', 'cancel_acknowledged', 'terminated')`),
    positiveCursorCheck: check("verrail_run_events_positive_cursor_check", sql`${table.cursor} > 0 and ${table.fencingToken} > 0`),
  }),
);

export const verrailExecutionCommandReceipts = pgTable(
  "verrail_execution_command_receipts",
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
    commandKeyUq: uniqueIndex("verrail_execution_command_receipts_key_uq").on(
      table.workspaceId,
      table.principalType,
      table.principalId,
      table.commandType,
      table.idempotencyKey,
    ),
  }),
);
