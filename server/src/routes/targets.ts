import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { verrailCollections, type Db } from "@paperclipai/db";
import {
  createTargetSchema,
  createGraphRevisionSchema,
  createRunSchema,
  createRunAttemptSchema,
  reportRunEventSchema,
  targetIdempotencyKeySchema,
  targetListQuerySchema,
  TARGET_READ_MODEL_POLICY_VERSION,
  TARGET_READ_MODEL_SCHEMA_VERSION,
  type TargetListQuery,
  type TargetReadModelV1,
} from "@paperclipai/shared";
import { badRequest, HttpError, notFound } from "../errors.js";
import { privateJsonEtag } from "../middleware/private-json-etag.js";
import { validate } from "../middleware/validate.js";
import {
  conversationService,
  createVerrailDomainApiClient,
  logActivity,
  targetReadModelService,
  type VerrailDomainApiClient,
} from "../services/index.js";
import {
  assertBoard,
  assertCompanyAccess,
  getActorInfo,
  hasCompanyAccess,
} from "./authz.js";

type CursorPayload = {
  v: 1;
  workspaceId: string;
  principal: string;
  filter: string;
  updatedAt: string;
  targetId: string;
};

function principalKey(req: Request) {
  const actor = getActorInfo(req);
  return `${actor.actorType}:${actor.actorId}`;
}

function filterFingerprint(query: TargetListQuery) {
  return createHash("sha256").update(JSON.stringify({
    readModelPolicyVersion: TARGET_READ_MODEL_POLICY_VERSION,
    collectionId: query.collectionId ?? null,
    status: query.status ?? null,
    ownerId: query.ownerId ?? null,
    attention: query.attention ?? null,
    sort: query.sort,
  })).digest("base64url").slice(0, 20);
}

function encodeCursor(payload: CursorPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      parsed.v !== 1
      || typeof parsed.workspaceId !== "string"
      || typeof parsed.principal !== "string"
      || typeof parsed.filter !== "string"
      || typeof parsed.updatedAt !== "string"
      || typeof parsed.targetId !== "string"
      || !Number.isFinite(new Date(parsed.updatedAt).getTime())
    ) throw new Error("invalid cursor");
    return parsed as CursorPayload;
  } catch {
    throw badRequest("Invalid Target cursor");
  }
}

function assertWorkspaceRead(req: Request, workspaceId: string) {
  if (!hasCompanyAccess(req, workspaceId)) throw notFound("Workspace not found");
  assertCompanyAccess(req, workspaceId);
}

function sortTargets(left: TargetReadModelV1, right: TargetReadModelV1) {
  const updated = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  return updated !== 0 ? updated : left.targetId.localeCompare(right.targetId);
}

function applyFilters(items: TargetReadModelV1[], query: TargetListQuery) {
  return items.filter((item) => {
    if (query.collectionId && item.collection?.id !== query.collectionId) return false;
    if (query.status && item.status !== query.status) return false;
    if (query.ownerId && item.outcomeOwner?.principalId !== query.ownerId) return false;
    if (query.attention === "true" && item.attentionSummary.total === 0) return false;
    if (query.attention === "false" && item.attentionSummary.total > 0) return false;
    return true;
  });
}

function afterCursor(items: TargetReadModelV1[], cursor: CursorPayload | null) {
  if (!cursor) return items;
  const cursorTime = new Date(cursor.updatedAt).getTime();
  return items.filter((item) => {
    const itemTime = new Date(item.updatedAt).getTime();
    return itemTime < cursorTime || (itemTime === cursorTime && item.targetId > cursor.targetId);
  });
}

function summarizeTargets(items: TargetReadModelV1[]) {
  const summary = {
    total: 0,
    open: 0,
    attention: 0,
    byCollection: {} as Record<string, { total: number; open: number; attention: number }>,
  };

  for (const item of items) {
    const isOpen = item.status !== "accepted" && item.status !== "canceled";
    const needsAttention = item.attentionSummary.total > 0;
    summary.total += 1;
    if (isOpen) summary.open += 1;
    if (needsAttention) summary.attention += 1;

    const collectionId = item.collection?.id;
    if (!collectionId) continue;
    const collection = summary.byCollection[collectionId] ?? { total: 0, open: 0, attention: 0 };
    collection.total += 1;
    if (isOpen) collection.open += 1;
    if (needsAttention) collection.attention += 1;
    summary.byCollection[collectionId] = collection;
  }

  return summary;
}

export function targetRoutes(
  db: Db,
  options: { domainApiClient?: VerrailDomainApiClient | null } = {},
) {
  const router = Router();
  const svc = targetReadModelService(db);
  const conversations = conversationService(db);
  const domainApi = options.domainApiClient === undefined
    ? createVerrailDomainApiClient()
    : options.domainApiClient;
  const etag = privateJsonEtag(principalKey);

  router.post(
    "/workspaces/:workspaceId/targets",
    validate(createTargetSchema),
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      assertBoard(req);
      assertCompanyAccess(req, workspaceId);
      if (req.body.collectionId) {
        const collection = await db
          .select({ id: verrailCollections.id })
          .from(verrailCollections)
          .where(and(
            eq(verrailCollections.workspaceId, workspaceId),
            eq(verrailCollections.id, req.body.collectionId),
            isNull(verrailCollections.archivedAt),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!collection) throw notFound("Workspace or Collection not found");
      }
      if (!domainApi) {
        throw new HttpError(503, "Verrail Domain API is unavailable", {
          code: "TARGET_DOMAIN_API_UNAVAILABLE",
          retryable: true,
        });
      }
      const actor = getActorInfo(req);
      if (actor.actorType !== "user") {
        throw new HttpError(403, "A human Workspace member is required", {
          code: "TARGET_CREATE_FORBIDDEN",
        });
      }
      const idempotencyKey = targetIdempotencyKeySchema.parse(req.header("Idempotency-Key"));
      const result = await domainApi.createTarget({
        workspaceId,
        principalType: "user",
        principalId: actor.actorId,
        idempotencyKey,
        input: req.body,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.post(
    "/workspaces/:workspaceId/runs/:runId/attempts",
    validate(createRunAttemptSchema),
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      assertBoard(req);
      assertCompanyAccess(req, workspaceId);
      if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "TARGET_DOMAIN_API_UNAVAILABLE", retryable: true });
      const actor = getActorInfo(req);
      const result = await domainApi.createRunAttempt({
        workspaceId,
        runId: req.params.runId as string,
        principalType: "user",
        principalId: actor.actorId,
        idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")),
        input: req.body,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.post(
    "/workspaces/:workspaceId/runs/:runId/attempts/:runAttemptId/events",
    validate(reportRunEventSchema),
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      assertBoard(req);
      assertCompanyAccess(req, workspaceId);
      if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "TARGET_DOMAIN_API_UNAVAILABLE", retryable: true });
      const executorPrincipalId = req.header("X-Verrail-Executor-Id")?.trim();
      if (!executorPrincipalId) throw badRequest("X-Verrail-Executor-Id is required");
      const result = await domainApi.reportRunEvent({
        workspaceId,
        runId: req.params.runId as string,
        runAttemptId: req.params.runAttemptId as string,
        principalType: "service",
        principalId: executorPrincipalId,
        idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")),
        input: req.body,
      });
      res.status(result.replayed ? 200 : result.authoritative ? 201 : 202).json(result);
    },
  );

  router.post(
    "/workspaces/:workspaceId/runs/:runId/cancel",
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      assertBoard(req);
      assertCompanyAccess(req, workspaceId);
      if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "TARGET_DOMAIN_API_UNAVAILABLE", retryable: true });
      const actor = getActorInfo(req);
      const result = await domainApi.requestRunCancellation({
        workspaceId,
        runId: req.params.runId as string,
        principalType: "user",
        principalId: actor.actorId,
        idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")),
      });
      res.json(result);
    },
  );

  router.post(
    "/workspaces/:workspaceId/targets/:targetId/graph-revisions",
    validate(createGraphRevisionSchema),
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      const targetId = req.params.targetId as string;
      assertBoard(req);
      assertCompanyAccess(req, workspaceId);
      if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "TARGET_DOMAIN_API_UNAVAILABLE", retryable: true });
      if (!await svc.getByTargetId(workspaceId, targetId)) throw notFound("Target not found");
      const actor = getActorInfo(req);
      const idempotencyKey = targetIdempotencyKeySchema.parse(req.header("Idempotency-Key"));
      const result = await domainApi.createGraphRevision({
        workspaceId,
        targetId,
        principalType: "user",
        principalId: actor.actorId,
        idempotencyKey,
        input: req.body,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  router.post(
    "/workspaces/:workspaceId/targets/:targetId/graph-revisions/:graphRevisionId/activate",
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      const targetId = req.params.targetId as string;
      assertBoard(req);
      assertCompanyAccess(req, workspaceId);
      if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "TARGET_DOMAIN_API_UNAVAILABLE", retryable: true });
      if (!await svc.getByTargetId(workspaceId, targetId)) throw notFound("Target not found");
      const actor = getActorInfo(req);
      const result = await domainApi.activateGraphRevision({
        workspaceId,
        targetId,
        graphRevisionId: req.params.graphRevisionId as string,
        principalType: "user",
        principalId: actor.actorId,
        idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")),
      });
      res.json(result);
    },
  );

  router.post(
    "/workspaces/:workspaceId/targets/:targetId/graph-revisions/:graphRevisionId/nodes/:workNodeId/runs",
    validate(createRunSchema),
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      const targetId = req.params.targetId as string;
      assertBoard(req);
      assertCompanyAccess(req, workspaceId);
      if (!domainApi) throw new HttpError(503, "Verrail Domain API is unavailable", { code: "TARGET_DOMAIN_API_UNAVAILABLE", retryable: true });
      if (!await svc.getByTargetId(workspaceId, targetId)) throw notFound("Target not found");
      const actor = getActorInfo(req);
      const result = await domainApi.createRun({
        workspaceId,
        targetId,
        graphRevisionId: req.params.graphRevisionId as string,
        workNodeId: req.params.workNodeId as string,
        principalType: "user",
        principalId: actor.actorId,
        idempotencyKey: targetIdempotencyKeySchema.parse(req.header("Idempotency-Key")),
        input: req.body,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  async function listForRequest(req: Request, workspaceId: string, collectionId?: string) {
    assertWorkspaceRead(req, workspaceId);
    const query = targetListQuerySchema.parse({ ...req.query, ...(collectionId ? { collectionId } : {}) });
    const principal = principalKey(req);
    const fingerprint = filterFingerprint(query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor && (
      cursor.workspaceId !== workspaceId
      || cursor.principal !== principal
      || cursor.filter !== fingerprint
    )) throw badRequest("Target cursor does not match this query");

    const authorized = applyFilters(await svc.list(workspaceId), query).sort(sortTargets);
    const visible = afterCursor(authorized, cursor);
    const items = visible.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor = visible.length > query.limit && last
      ? encodeCursor({
        v: 1,
        workspaceId,
        principal,
        filter: fingerprint,
        updatedAt: last.updatedAt,
        targetId: last.targetId,
      })
      : null;
    return {
      schemaVersion: TARGET_READ_MODEL_SCHEMA_VERSION,
      readModelPolicyVersion: TARGET_READ_MODEL_POLICY_VERSION,
      asOf: authorized.reduce(
        (latest, item) => item.projectedAt > latest ? item.projectedAt : latest,
        new Date(0).toISOString(),
      ),
      items,
      summary: summarizeTargets(authorized),
      nextCursor,
    };
  }

  router.get("/workspaces/:workspaceId/targets", etag, async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    res.json(await listForRequest(req, workspaceId));
  });

  router.get("/workspaces/:workspaceId/collections/:collectionId/targets", etag, async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const collectionId = req.params.collectionId as string;
    res.json(await listForRequest(req, workspaceId, collectionId));
  });

  router.get("/workspaces/:workspaceId/targets/:targetId", etag, async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const targetId = req.params.targetId as string;
    assertWorkspaceRead(req, workspaceId);
    const model = await svc.getByTargetId(workspaceId, targetId);
    if (!model) throw notFound("Target not found");
    res.json(model);
  });

  router.get("/workspaces/:workspaceId/targets/:targetId/workspace", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const targetId = req.params.targetId as string;
    assertWorkspaceRead(req, workspaceId);
    const model = await svc.getByTargetId(workspaceId, targetId);
    if (!model) throw notFound("Target not found");
    res.json(await svc.workspace(model));
  });

  router.post("/workspaces/:workspaceId/targets/:targetId/conversation", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const targetId = req.params.targetId as string;
    assertBoard(req);
    assertCompanyAccess(req, workspaceId);
    const model = await svc.getByTargetId(workspaceId, targetId);
    if (!model) throw notFound("Target not found");
    const actor = getActorInfo(req);
    const contextBindings = [
      ...(model.collection ? [{
        contextType: "collection" as const,
        contextId: model.collection.id,
        label: model.collection.name,
        href: "/collections",
      }] : []),
      {
        contextType: "target" as const,
        contextId: model.targetId,
        label: model.title,
        href: `/targets/${model.targetId}/overview`,
      },
      {
        contextType: "target_revision" as const,
        contextId: model.activeTargetRevisionId,
        label: `Target revision ${model.activeTargetRevisionId.slice(0, 8)}`,
        href: `/targets/${model.targetId}/revisions/${model.activeTargetRevisionId}`,
      },
    ];
    const created = await conversations.create(workspaceId, {
      title: model.title,
      contextBindings,
    }, {
      principalType: actor.actorType,
      principalId: actor.actorId,
    }, { trustedContext: true });
    await logActivity(db, {
      companyId: workspaceId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "target.conversation_created",
      entityType: "target",
      entityId: model.targetId,
      details: {
        conversationId: created.id,
        targetRevisionId: model.activeTargetRevisionId,
      },
    });
    res.status(201).json(created);
  });

  router.get(
    "/workspaces/:workspaceId/targets/:targetId/revisions/:targetRevisionId",
    etag,
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      const targetId = req.params.targetId as string;
      const targetRevisionId = req.params.targetRevisionId as string;
      assertWorkspaceRead(req, workspaceId);
      const model = await svc.getByRevisionId(workspaceId, targetId, targetRevisionId);
      if (!model) {
        throw notFound("Target revision not found");
      }
      res.json(model);
    },
  );

  return router;
}
