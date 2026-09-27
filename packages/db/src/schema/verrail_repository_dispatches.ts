import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { verrailRunAttempts, verrailExecutionLeases } from "./verrail_execution.js";

// Execution transport state only; this table does not own Run transitions.
export const verrailRepositoryDispatches = pgTable("verrail_repository_dispatches", {
  runAttemptId: uuid("run_attempt_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  runId: uuid("run_id").notNull(),
  leaseId: uuid("lease_id").notNull(),
  fencingToken: integer("fencing_token").notNull(),
  controllerId: uuid("controller_id").notNull(),
  requestHash: text("request_hash").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("dispatched"),
  toolCalls: integer("tool_calls").notNull().default(0),
  result: jsonb("result").$type<Record<string, unknown>>(),
  errorCode: text("error_code"),
  controllerExpiresAt: timestamp("controller_expires_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  attemptFk: foreignKey({ name: "verrail_repository_dispatch_attempt_fk",
    columns: [table.runAttemptId, table.runId, table.workspaceId],
    foreignColumns: [verrailRunAttempts.id, verrailRunAttempts.runId, verrailRunAttempts.workspaceId],
  }).onDelete("cascade"),
  leaseFk: foreignKey({ name: "verrail_repository_dispatch_lease_fk",
    columns: [table.leaseId, table.workspaceId],
    foreignColumns: [verrailExecutionLeases.id, verrailExecutionLeases.workspaceId],
  }).onDelete("restrict"),
  recoveryIdx: index("verrail_repository_dispatch_recovery_idx").on(table.status, table.controllerExpiresAt),
  statusCheck: check("verrail_repository_dispatch_status_check", sql`${table.status} in ('dispatched', 'succeeded', 'failed', 'canceled', 'interrupted')`),
  terminalCheck: check("verrail_repository_dispatch_terminal_check", sql`(${table.status} <> 'dispatched') = (${table.finishedAt} is not null)`),
  budgetCheck: check("verrail_repository_dispatch_budget_check", sql`${table.toolCalls} between 0 and 20 and ${table.fencingToken} > 0`),
  hashCheck: check("verrail_repository_dispatch_hash_check", sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`),
}));
