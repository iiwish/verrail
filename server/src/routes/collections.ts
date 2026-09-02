import { Router } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { verrailCollections, type Db } from "@paperclipai/db";
import { createCollectionSchema, type Collection } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { logActivity, targetReadModelService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function collectionRoutes(db: Db) {
  const router = Router();
  const targets = targetReadModelService(db);

  router.get("/workspaces/:workspaceId/collections", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);

    const [rows, targetRows] = await Promise.all([
      db.select().from(verrailCollections).where(and(
        eq(verrailCollections.workspaceId, workspaceId),
        isNull(verrailCollections.archivedAt),
      )).orderBy(asc(verrailCollections.name)),
      targets.list(workspaceId),
    ]);
    const counts = new Map<string, Pick<Collection, "targetCount" | "openTargetCount" | "attentionTargetCount">>();
    for (const target of targetRows) {
      if (!target.collection) continue;
      const count = counts.get(target.collection.id) ?? {
        targetCount: 0,
        openTargetCount: 0,
        attentionTargetCount: 0,
      };
      count.targetCount += 1;
      if (target.status !== "accepted" && target.status !== "canceled") count.openTargetCount += 1;
      if (target.attentionSummary.total > 0) count.attentionTargetCount += 1;
      counts.set(target.collection.id, count);
    }

    res.json(rows.map((row): Collection => ({
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      description: row.description,
      ...(counts.get(row.id) ?? { targetCount: 0, openTargetCount: 0, attentionTargetCount: 0 }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })));
  });

  router.post("/workspaces/:workspaceId/collections", async (req, res) => {
    assertBoard(req);
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, workspaceId);
    const input = createCollectionSchema.parse(req.body);
    const duplicate = await db.select({ id: verrailCollections.id })
      .from(verrailCollections)
      .where(and(
        eq(verrailCollections.workspaceId, workspaceId),
        eq(verrailCollections.name, input.name),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (duplicate) throw conflict("Collection name already exists in this Workspace");

    const created = await db.insert(verrailCollections).values({
      workspaceId,
      name: input.name,
      description: input.description ?? null,
    }).returning().then((rows) => rows[0]!);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: workspaceId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "collection.created",
      entityType: "collection",
      entityId: created.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: { name: created.name },
    });
    res.status(201).json({
      id: created.id,
      workspaceId: created.workspaceId,
      name: created.name,
      description: created.description,
      targetCount: 0,
      openTargetCount: 0,
      attentionTargetCount: 0,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    } satisfies Collection);
  });

  return router;
}
