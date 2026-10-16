import { foreignKey, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { verrailRuns } from "./verrail_delivery.js";
import { verrailArtifactRevisions } from "./verrail_assurance.js";
import { companies } from "./companies.js";

export const verrailRunSources = pgTable("verrail_run_sources", {
  runId: uuid("run_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  repositorySourceRevisionId: uuid("repository_source_revision_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  runWorkspaceFk: foreignKey({ columns: [table.runId, table.workspaceId],
    foreignColumns: [verrailRuns.id, verrailRuns.workspaceId], name: "verrail_run_sources_run_workspace_fk" }).onDelete("restrict"),
  revisionWorkspaceFk: foreignKey({ columns: [table.repositorySourceRevisionId, table.workspaceId],
    foreignColumns: [verrailArtifactRevisions.id, verrailArtifactRevisions.workspaceId], name: "verrail_run_sources_revision_workspace_fk" }).onDelete("restrict"),
}));
