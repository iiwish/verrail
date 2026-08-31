import { plugins, type Db } from "@paperclipai/db";
import { VERRAIL_NAVIGATION_ROUTE_ROOTS } from "@paperclipai/shared";
import { asc, eq } from "drizzle-orm";
import { conflict } from "../errors.js";

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
