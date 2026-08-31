import { companies, plugins, type Db } from "@paperclipai/db";
import { VERRAIL_NAVIGATION_ROUTE_ROOTS } from "@paperclipai/shared";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { conflict } from "../errors.js";

const VERRAIL_NAVIGATION_ROUTE_OWNERSHIP_LOCK = "verrail:navigation-route-ownership";

export interface VerrailNavigationRouteConflict {
  pluginKey: string;
  routePath: string;
  slotId: string;
  slotType: string;
}

interface PersistedPluginManifestRecord {
  pluginKey: string;
  manifestJson: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function lockVerrailNavigationRouteOwnership(
  db: Pick<Db, "execute">,
): Promise<void> {
  await db.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${VERRAIL_NAVIGATION_ROUTE_OWNERSHIP_LOCK}, 0)
    )
  `);
}

export function findVerrailNavigationRouteConflicts(
  plugins: PersistedPluginManifestRecord[],
): VerrailNavigationRouteConflict[] {
  const reservedRoots = new Set<string>(VERRAIL_NAVIGATION_ROUTE_ROOTS);
  const conflicts: VerrailNavigationRouteConflict[] = [];

  for (const plugin of plugins) {
    if (!isRecord(plugin.manifestJson)) continue;
    const ui = plugin.manifestJson.ui;
    if (!isRecord(ui) || !Array.isArray(ui.slots)) continue;

    for (const slot of ui.slots) {
      if (!isRecord(slot)) continue;
      const routePath = typeof slot.routePath === "string" ? slot.routePath : null;
      if (!routePath || !reservedRoots.has(routePath)) continue;
      conflicts.push({
        pluginKey: plugin.pluginKey,
        routePath,
        slotId: typeof slot.id === "string" ? slot.id : "unknown",
        slotType: typeof slot.type === "string" ? slot.type : "unknown",
      });
    }
  }

  return conflicts.sort((left, right) =>
    left.pluginKey.localeCompare(right.pluginKey)
    || left.routePath.localeCompare(right.routePath)
    || left.slotId.localeCompare(right.slotId),
  );
}

export async function assertVerrailNavigationCanEnable(
  db: Pick<Db, "select">,
): Promise<void> {
  const activePlugins = await db
    .select({ pluginKey: plugins.pluginKey, manifestJson: plugins.manifestJson })
    .from(plugins)
    .where(eq(plugins.status, "ready"))
    .orderBy(asc(plugins.installOrder));
  const conflicts = findVerrailNavigationRouteConflicts(activePlugins);
  if (conflicts.length === 0) return;

  throw conflict(
    "Verrail navigation cannot be enabled while active plugins claim reserved route roots",
    {
      code: "VERRAIL_NAVIGATION_ROUTE_CONFLICT",
      conflicts,
    },
  );
}

export async function assertPluginCanActivateWithVerrailNavigation(
  db: Pick<Db, "select">,
  plugin: PersistedPluginManifestRecord,
): Promise<void> {
  const conflicts = findVerrailNavigationRouteConflicts([plugin]);
  if (conflicts.length === 0) return;

  const enabledWorkspace = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(
      eq(companies.enableVerrailNavigation, true),
      ne(companies.status, "archived"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!enabledWorkspace) return;

  throw conflict(
    "Plugin cannot be activated while Verrail navigation owns a reserved route root",
    {
      code: "VERRAIL_NAVIGATION_ROUTE_CONFLICT",
      conflicts,
      workspaceId: enabledWorkspace.id,
    },
  );
}
