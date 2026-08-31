import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { cases, issues, projects, type Db } from "@paperclipai/db";
import {
  createTargetSchema,
  registerTargetProjectionSchema,
  targetIdempotencyKeySchema,
  targetListQuerySchema,
  TARGET_PROJECTION_POLICY_VERSION,
  TARGET_READ_MODEL_SCHEMA_VERSION,
  type TargetListQuery,
  type TargetReadModelV1,
} from "@paperclipai/shared";
import { badRequest, HttpError, notFound } from "../errors.js";
import { privateJsonEtag } from "../middleware/private-json-etag.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  createVerrailDomainApiClient,
  logActivity,
  targetReadModelService,
  type VerrailDomainApiClient,
} from "../services/index.js";
import {
  assertBoard,
  assertCompanyAccess,
  assertInstanceAdmin,
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
    projectionPolicyVersion: TARGET_PROJECTION_POLICY_VERSION,
    projectId: query.projectId ?? null,
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
    if (query.projectId && item.project?.id !== query.projectId) return false;
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

export function targetRoutes(
  db: Db,
  options: { domainApiClient?: VerrailDomainApiClient | null } = {},
) {
  const router = Router();
  const svc = targetReadModelService(db);
  const access = accessService(db);
  const domainApi = options.domainApiClient === undefined
    ? createVerrailDomainApiClient()
    : options.domainApiClient;
  const etag = privateJsonEtag(principalKey);

  async function currentSourceProject(item: TargetReadModelV1) {
    if (item.authority.kind === "native") {
      if (!item.project) return null;
      return db
        .select({ projectId: projects.id })
        .from(projects)
        .where(and(
          eq(projects.companyId, item.workspaceId),
          eq(projects.id, item.project.id),
          isNull(projects.archivedAt),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    }
    if (item.source.type === "case") {
      return db
        .select({ projectId: cases.projectId })
        .from(cases)
        .where(and(eq(cases.companyId, item.workspaceId), eq(cases.id, item.source.id)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    }
    return db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(and(
        eq(issues.companyId, item.workspaceId),
        eq(issues.id, item.source.id),
        isNull(issues.hiddenAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function canRead(
    req: Request,
    item: TargetReadModelV1,
    options: { allowMissingSource?: boolean } = {},
  ) {
    if (item.authority.kind === "compatibility" && item.source.type === "case" && req.actor.type === "agent") return false;
    const currentSource = await currentSourceProject(item);
    if (!currentSource && !options.allowMissingSource) return false;
    const projectId = currentSource?.projectId ?? item.project?.id ?? null;
    if (item.authority.kind === "compatibility" && item.source.type === "issue") {
      return access.decide({
        actor: req.actor,
        action: "issue:read",
        resource: {
          type: "issue",
          companyId: item.workspaceId,
          issueId: item.source.id,
          projectId,
        },
      }).then((decision) => decision.allowed);
    }
    if (projectId) {
      return access.decide({
        actor: req.actor,
        action: "project:read",
        resource: { type: "project", companyId: item.workspaceId, projectId },
      }).then((decision) => decision.allowed);
    }
    return req.actor.type === "board";
  }

  router.post(
    "/workspaces/:workspaceId/targets",
    validate(createTargetSchema),
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      assertBoard(req);
      assertCompanyAccess(req, workspaceId);
      const project = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(
          eq(projects.companyId, workspaceId),
          eq(projects.id, req.body.projectId),
          isNull(projects.archivedAt),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Workspace or Project not found");
      const decision = await access.decide({
        actor: req.actor,
        action: "project:read",
        resource: { type: "project", companyId: workspaceId, projectId: project.id },
      });
      if (!decision.allowed) throw notFound("Workspace or Project not found");
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

  async function listForRequest(req: Request, workspaceId: string, projectId?: string) {
    assertWorkspaceRead(req, workspaceId);
    const query = targetListQuerySchema.parse({ ...req.query, ...(projectId ? { projectId } : {}) });
    const principal = principalKey(req);
    const fingerprint = filterFingerprint(query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor && (
      cursor.workspaceId !== workspaceId
      || cursor.principal !== principal
      || cursor.filter !== fingerprint
    )) throw badRequest("Target cursor does not match this query");

    const candidates = applyFilters(await svc.list(workspaceId), query).sort(sortTargets);
    const decisions = await Promise.all(candidates.map((item) => canRead(req, item)));
    const authorized = candidates.filter((_, index) => decisions[index]);
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
      projectionPolicyVersion: TARGET_PROJECTION_POLICY_VERSION,
      asOf: authorized.reduce(
        (latest, item) => item.projectedAt > latest ? item.projectedAt : latest,
        new Date(0).toISOString(),
      ),
      items,
      nextCursor,
    };
  }

  router.get("/workspaces/:workspaceId/targets", etag, async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    res.json(await listForRequest(req, workspaceId));
  });

  router.get("/workspaces/:workspaceId/projects/:projectId/targets", etag, async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const projectId = req.params.projectId as string;
    res.json(await listForRequest(req, workspaceId, projectId));
  });

  router.get("/workspaces/:workspaceId/targets/:targetId", etag, async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const targetId = req.params.targetId as string;
    assertWorkspaceRead(req, workspaceId);
    const model = await svc.getByTargetId(workspaceId, targetId);
    if (!model || !(await canRead(req, model))) throw notFound("Target not found");
    res.json(model);
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
      if (!model || !(await canRead(req, model, { allowMissingSource: true }))) {
        throw notFound("Target revision not found");
      }
      res.json(model);
    },
  );

  router.post(
    "/workspaces/:workspaceId/target-projections",
    validate(registerTargetProjectionSchema),
    async (req, res) => {
      const workspaceId = req.params.workspaceId as string;
      assertInstanceAdmin(req);
      assertCompanyAccess(req, workspaceId);
      const model = await svc.register(workspaceId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: workspaceId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "target.projection_registered",
        entityType: "target",
        entityId: model.targetId,
        details: {
          targetRevisionId: model.activeTargetRevisionId,
          sourceType: model.source.type,
          sourceId: model.source.id,
          eligibilityReason: req.body.eligibilityReason,
        },
      });
      res.status(201).json(model);
    },
  );

  router.post("/workspaces/:workspaceId/targets/:targetId/reconcile", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const targetId = req.params.targetId as string;
    assertInstanceAdmin(req);
    assertCompanyAccess(req, workspaceId);
    const model = await svc.reconcile(workspaceId, targetId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: workspaceId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "target.projection_reconciled",
      entityType: "target",
      entityId: model.targetId,
      details: { targetRevisionId: model.activeTargetRevisionId },
    });
    res.json(model);
  });

  return router;
}
