import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetReadModelV1 } from "@paperclipai/shared";
import { HttpError } from "../errors.js";

const mockTargetService = vi.hoisted(() => ({
  list: vi.fn(),
  getByTargetId: vi.fn(),
  getByRevisionId: vi.fn(),
  register: vi.fn(),
  reconcile: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockCurrentSourceRows = vi.hoisted(() => vi.fn());
const mockCreateNativeTarget = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  targetReadModelService: () => mockTargetService,
  accessService: () => mockAccessService,
  createVerrailDomainApiClient: () => null,
  logActivity: mockLogActivity,
}));

const WORKSPACE_ID = "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const TARGET_ID = "b80f266a-87ea-57f0-81bd-c4f04e4d576e";
const REVISION_ID = "0de2d166-850e-5c74-ab63-beb86129b52a";
const SOURCE_ID = "41c96b31-d0d9-420a-84dd-34638354040c";

function model(overrides: Partial<TargetReadModelV1> = {}): TargetReadModelV1 {
  return {
    schemaVersion: 1,
    projectionPolicyVersion: "g1.v1",
    targetId: TARGET_ID,
    activeTargetRevisionId: REVISION_ID,
    workspaceId: WORKSPACE_ID,
    authority: { kind: "compatibility", writer: "typescript-compatibility" },
    project: { id: "f52f936d-c5fb-4457-a023-ad062ef667a5", name: "Project" },
    source: {
      type: "issue",
      id: SOURCE_ID,
      identifier: "VER-1",
      href: "/VER/issues/VER-1",
      updatedAt: "2026-08-26T10:00:00.000Z",
      revisionKey: "2026-08-26T10:00:00.000Z",
    },
    title: "Target",
    summary: null,
    status: "active",
    outcomeOwner: null,
    currentStage: { key: "execute", label: "Execute" },
    risk: { level: "unknown" },
    attentionSummary: { total: 0, highestSeverity: null },
    artifactSummary: { count: 0, latestRevisionId: null },
    evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" },
    runSummary: { active: 0, failed: 0, latestRunId: null, latestRunAt: null },
    definition: null,
    compatibility: { readOnly: true, completionUnverified: false, missingFields: [], warnings: [] },
    createdAt: "2026-08-26T09:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
    projectedAt: "2026-08-26T10:00:01.000Z",
    ...overrides,
  };
}

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js");
  const { targetRoutes } = await vi.importActual<typeof import("../routes/targets.js")>("../routes/targets.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [WORKSPACE_ID],
      memberships: [{ companyId: WORKSPACE_ID, membershipRole: "owner", status: "active" }],
      source: "session",
      isInstanceAdmin: true,
      ...actorOverrides,
    };
    next();
  });
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockCurrentSourceRows()),
        }),
      }),
    }),
  };
  app.use("/api", targetRoutes(db as any, {
    domainApiClient: { createTarget: mockCreateNativeTarget },
  }));
  app.use(errorHandler);
  return app;
}

describe("Target read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTargetService.list.mockResolvedValue([model()]);
    mockTargetService.getByTargetId.mockResolvedValue(model());
    mockTargetService.getByRevisionId.mockResolvedValue(model());
    mockTargetService.register.mockResolvedValue(model());
    mockTargetService.reconcile.mockResolvedValue(model());
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockLogActivity.mockResolvedValue(undefined);
    mockCreateNativeTarget.mockResolvedValue({
      schemaVersion: 1,
      targetId: TARGET_ID,
      targetRevisionId: REVISION_ID,
      workbenchHref: `/targets/${TARGET_ID}/overview`,
      replayed: false,
    });
    mockCurrentSourceRows.mockReturnValue([{ projectId: model().project!.id }]);
  });

  it("lists only authorization-filtered Targets and emits a principal-bound cursor", async () => {
    const second = model({
      targetId: "78a5eefd-e3ef-5b2a-a7ba-7cd1036e71e5",
      activeTargetRevisionId: "a64f2ab0-01d0-5f7f-a7f1-b3260ae00554",
      source: { ...model().source, id: "ee7e3b25-d7f2-4a40-8af0-2c9ac66d3788" },
      updatedAt: "2026-08-26T09:00:00.000Z",
    });
    mockTargetService.list.mockResolvedValue([model(), second]);
    const app = await createApp();

    const first = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/targets?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.summary).toEqual({
      total: 2,
      open: 2,
      attention: 0,
      byProject: {
        [model().project!.id]: { total: 2, open: 2, attention: 0 },
      },
    });
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.headers.etag).toEqual(expect.any(String));

    const unchanged = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/targets?limit=1`)
      .set("If-None-Match", first.headers.etag);
    expect(unchanged.status).toBe(304);

    const next = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/targets?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.items[0].targetId).toBe(second.targetId);

    const differentPrincipal = await createApp({ userId: "user-2" });
    const principalScoped = await request(differentPrincipal)
      .get(`/api/workspaces/${WORKSPACE_ID}/targets?limit=1`);
    expect(principalScoped.headers.etag).not.toBe(first.headers.etag);
    const rejected = await request(differentPrincipal).get(
      `/api/workspaces/${WORKSPACE_ID}/targets?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(rejected.status).toBe(400);
  });

  it("returns 404 rather than leaking a denied Target", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: false });
    const app = await createApp();
    const response = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}`);
    expect(response.status).toBe(404);
  });

  it("returns the stable retryable error when an active projection snapshot is unavailable", async () => {
    mockTargetService.getByTargetId.mockRejectedValue(new HttpError(503, "Target projection unavailable", {
      code: "TARGET_PROJECTION_UNAVAILABLE",
      retryable: true,
    }));
    const app = await createApp();

    const response = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}`);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: "TARGET_PROJECTION_UNAVAILABLE",
      details: { retryable: true },
    });
  });

  it("authorizes stale active reads against the source's current Project", async () => {
    const currentProjectId = "693ba99a-33b5-4e15-9ce2-f138d55b46f1";
    mockCurrentSourceRows.mockReturnValue([{ projectId: currentProjectId }]);
    const app = await createApp();

    const response = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}`);

    expect(response.status).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      resource: expect.objectContaining({ projectId: currentProjectId }),
    }));
  });

  it("uses the immutable snapshot scope when a historical revision source is gone", async () => {
    mockCurrentSourceRows.mockReturnValue([]);
    mockTargetService.getByRevisionId.mockResolvedValue(model({
      compatibility: {
        ...model().compatibility,
        warnings: ["source_missing"],
      },
    }));
    const app = await createApp();

    const response = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}/revisions/${REVISION_ID}`,
    );

    expect(response.status).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      resource: expect.objectContaining({ projectId: model().project!.id }),
    }));
  });

  it("filters authorization before pagination and cursor calculation", async () => {
    const visible = model({
      targetId: "78a5eefd-e3ef-5b2a-a7ba-7cd1036e71e5",
      activeTargetRevisionId: "a64f2ab0-01d0-5f7f-a7f1-b3260ae00554",
      source: { ...model().source, id: "ee7e3b25-d7f2-4a40-8af0-2c9ac66d3788" },
      updatedAt: "2026-08-26T09:00:00.000Z",
    });
    mockTargetService.list.mockResolvedValue([model(), visible]);
    mockAccessService.decide.mockImplementation(async ({ resource }: { resource: { issueId?: string } }) => ({
      allowed: resource.issueId === visible.source.id,
    }));
    const app = await createApp();

    const response = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/targets?limit=1`);
    expect(response.status).toBe(200);
    expect(response.body.items.map((item: TargetReadModelV1) => item.targetId)).toEqual([visible.targetId]);
    expect(response.body.summary).toEqual({
      total: 1,
      open: 1,
      attention: 0,
      byProject: {
        [visible.project!.id]: { total: 1, open: 1, attention: 0 },
      },
    });
    expect(response.body.nextCursor).toBeNull();

    const invalidLimit = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/targets?limit=101`);
    expect(invalidLimit.status).toBe(400);
  });

  it("registers explicit mappings only for an instance administrator and audits the mutation", async () => {
    const app = await createApp();
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/target-projections`)
      .send({ sourceType: "issue", sourceId: SOURCE_ID, eligibilityReason: "operator_mapping" });
    expect(response.status).toBe(201);
    expect(mockTargetService.register).toHaveBeenCalledWith(WORKSPACE_ID, {
      sourceType: "issue",
      sourceId: SOURCE_ID,
      eligibilityReason: "operator_mapping",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "target.projection_registered",
      entityId: TARGET_ID,
    }));

    const memberApp = await createApp({ isInstanceAdmin: false });
    const denied = await request(memberApp)
      .post(`/api/workspaces/${WORKSPACE_ID}/target-projections`)
      .send({ sourceType: "issue", sourceId: SOURCE_ID, eligibilityReason: "operator_mapping" });
    expect(denied.status).toBe(403);
  });

  it("proxies a strict native Target command with principal-bound idempotency", async () => {
    const app = await createApp();
    const input = {
      projectId: model().project!.id,
      title: "Ship governed Target creation",
      outcomeOwner: { principalType: "user", principalId: "user-1" },
      goal: "Create a durable Target fact.",
      constraints: ["Keep Go as the sole writer."],
      acceptanceCriteria: [{ title: "Creation is idempotent" }],
      riskLevel: "high",
    };
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/targets`)
      .set("Idempotency-Key", "target:create:route-test")
      .send(input);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ targetId: TARGET_ID, targetRevisionId: REVISION_ID });
    expect(mockCreateNativeTarget).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      principalType: "user",
      principalId: "user-1",
      idempotencyKey: "target:create:route-test",
      input,
    });

    mockCreateNativeTarget.mockResolvedValueOnce({ ...response.body, replayed: true });
    const replay = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/targets`)
      .set("Idempotency-Key", "target:create:route-test")
      .send(input);
    expect(replay.status).toBe(200);
  });

  it("fails native creation closed for invalid command keys and denied Projects", async () => {
    const input = {
      projectId: model().project!.id,
      title: "Target",
      outcomeOwner: { principalType: "user", principalId: "user-1" },
      goal: "Outcome",
      constraints: [],
      acceptanceCriteria: [{ title: "Accepted" }],
      riskLevel: "medium",
    };
    const app = await createApp();
    const invalidKey = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/targets`)
      .set("Idempotency-Key", "short")
      .send(input);
    expect(invalidKey.status).toBe(400);
    expect(mockCreateNativeTarget).not.toHaveBeenCalled();

    mockAccessService.decide.mockResolvedValueOnce({ allowed: false });
    const denied = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/targets`)
      .set("Idempotency-Key", "target:create:denied")
      .send(input);
    expect(denied.status).toBe(404);
    expect(mockCreateNativeTarget).not.toHaveBeenCalled();
  });
});
