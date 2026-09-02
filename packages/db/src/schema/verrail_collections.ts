import { index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const verrailCollections = pgTable(
  "verrail_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idWorkspaceUq: unique("verrail_collections_id_workspace_uq").on(
      table.id,
      table.workspaceId,
    ),
    workspaceNameUq: uniqueIndex("verrail_collections_workspace_name_uq").on(
      table.workspaceId,
      table.name,
    ),
    workspaceUpdatedIdx: index("verrail_collections_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
  }),
);
