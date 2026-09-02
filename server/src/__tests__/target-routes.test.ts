import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetReadModelV1, TargetWorkspaceV1 } from "@paperclipai/shared";

const targetService = vi.hoisted(() => ({ list: vi.fn(), getByTargetId: vi.fn(), getByRevisionId: vi.fn(), workspace: vi.fn() }));
const conversationService = vi.hoisted(() => ({ create: vi.fn() }));
const logActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  targetReadModelService: () => targetService,
  conversationService: () => conversationService,
  createVerrailDomainApiClient: () => null,
  logActivity,
}));

const WORKSPACE_ID = "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const TARGET_ID = "b80f266a-87ea-47f0-81bd-c4f04e4d576e";
const REVISION_ID = "0de2d166-850e-4c74-ab63-beb86129b52a";
const GRAPH_ID = "2de2d166-850e-4c74-ab63-beb86129b52a";
const GRAPH_REVISION_ID = "3de2d166-850e-4c74-ab63-beb86129b52a";
const NODE_ID = "4de2d166-850e-4c74-ab63-beb86129b52a";

function model(): TargetReadModelV1 {
  return {
    schemaVersion: 1,
    readModelPolicyVersion: "native.v1",
    targetId: TARGET_ID,
    activeTargetRevisionId: REVISION_ID,
    workspaceId: WORKSPACE_ID,
    collection: null,
    title: "Native Target",
    summary: null,
    status: "draft",
    outcomeOwner: { principalType: "user", principalId: "user-1", displayName: "Owner" },
    currentStage: { key: "define", label: "Define" },
    risk: { level: "medium" },
    attentionSummary: { total: 1, highestSeverity: "info" },
    artifactSummary: { count: 0, latestRevisionId: null },
    evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" },
    runSummary: { active: 0, failed: 0, latestRunId: null, latestRunAt: null },
    definition: { goal: "Deliver", constraints: [], acceptanceCriteria: [{ id: "criterion-1", title: "Done", description: null }], deadline: null, policySummary: null, resourceRefs: [] },
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    projectedAt: "2026-09-01T08:00:01.000Z",
  };
}

function workspace(): TargetWorkspaceV1 {
  return { schemaVersion: 1, targetId: TARGET_ID, targetRevisionId: REVISION_ID, workspaceId: WORKSPACE_ID, generatedAt: "2026-09-01T08:00:01.000Z", graph: null, stages: [], work: [], attention: [], submissions: [], artifacts: [], evidence: [], runs: [], timeline: [] };
}

async function createApp(domainApi: any) {
  const [{ targetRoutes }, { errorHandler }] = await Promise.all([import("../routes/targets.js"), import("../middleware/index.js")]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "user-1", companyIds: [WORKSPACE_ID], memberships: [{ companyId: WORKSPACE_ID, membershipRole: "owner", status: "active" }], source: "session", isInstanceAdmin: true };
    next();
  });
  app.use("/api", targetRoutes({} as any, { domainApiClient: domainApi }));
  app.use(errorHandler);
  return app;
}

describe("native Target routes", () => {
  const domainApi = {
    createTarget: vi.fn(),
    createGraphRevision: vi.fn(),
    activateGraphRevision: vi.fn(),
    createRun: vi.fn(),
    createRunAttempt: vi.fn(),
    reportRunEvent: vi.fn(),
    requestRunCancellation: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    targetService.list.mockResolvedValue([model()]);
    targetService.getByTargetId.mockResolvedValue(model());
    targetService.getByRevisionId.mockResolvedValue(model());
    targetService.workspace.mockResolvedValue(workspace());
    domainApi.createTarget.mockResolvedValue({ schemaVersion: 1, targetId: TARGET_ID, targetRevisionId: REVISION_ID, workGraphId: GRAPH_ID, graphRevisionId: GRAPH_REVISION_ID, workbenchHref: `/targets/${TARGET_ID}/overview`, replayed: false });
    domainApi.createGraphRevision.mockResolvedValue({ schemaVersion: 1, targetId: TARGET_ID, targetRevisionId: REVISION_ID, workGraphId: GRAPH_ID, graphRevisionId: GRAPH_REVISION_ID, revisionNumber: 2, replayed: false });
    domainApi.activateGraphRevision.mockResolvedValue({ schemaVersion: 1, targetId: TARGET_ID, targetRevisionId: REVISION_ID, workGraphId: GRAPH_ID, graphRevisionId: GRAPH_REVISION_ID, revisionNumber: 2, replayed: false, activatedAt: "2026-09-01T08:00:00Z" });
    domainApi.createRun.mockResolvedValue({ schemaVersion: 1, runId: "5de2d166-850e-4c74-ab63-beb86129b52a", targetId: TARGET_ID, targetRevisionId: REVISION_ID, graphRevisionId: GRAPH_REVISION_ID, workNodeId: NODE_ID, status: "queued", replayed: false });
    domainApi.createRunAttempt.mockResolvedValue({ schemaVersion: 1, runId: "5de2d166-850e-4c74-ab63-beb86129b52a", runAttemptId: "6de2d166-850e-4c74-ab63-beb86129b52a", leaseId: "7de2d166-850e-4c74-ab63-beb86129b52a", attemptNumber: 1, fencingToken: 1, status: "pending", leaseStatus: "offered", expiresAt: "2026-09-01T08:02:00Z", replayed: false });
    domainApi.requestRunCancellation.mockResolvedValue({ schemaVersion: 1, runId: "5de2d166-850e-4c74-ab63-beb86129b52a", runAttemptId: "6de2d166-850e-4c74-ab63-beb86129b52a", runStatus: "cancel_requested", attemptStatus: "cancel_requested", replayed: false });
  });

  it("lists and reads only native Targets", async () => {
    const app = await createApp(domainApi);
    const listed = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/targets`);
    expect(listed.status).toBe(200);
    expect(listed.body.readModelPolicyVersion).toBe("native.v1");
    expect(listed.body.items).toEqual([expect.objectContaining({ targetId: TARGET_ID })]);
    expect((await request(app).get(`/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}/workspace`)).body).toEqual(workspace());
  });

  it("proxies human Target creation and returns its initial graph identities", async () => {
    const app = await createApp(domainApi);
    const response = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/targets`).set("Idempotency-Key", "target:create:native").send({ title: "Native Target", outcomeOwner: { principalType: "user", principalId: "user-1" }, goal: "Deliver", constraints: [], acceptanceCriteria: [{ title: "Done" }], riskLevel: "medium" });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ workGraphId: GRAPH_ID, graphRevisionId: GRAPH_REVISION_ID });
    expect(domainApi.createTarget).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ resourceRefs: [] }) }));
  });

  it("creates, activates, and dispatches native graph facts", async () => {
    const app = await createApp(domainApi);
    const graph = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}/graph-revisions`).set("Idempotency-Key", "graph:create:native").send({ expectedTargetRevisionId: REVISION_ID, nodes: [{ nodeKey: "implement", kind: "agent_task", stage: "execute", title: "Implement", completionDefinition: "Return a result" }] });
    expect(graph.status).toBe(201);
    const activated = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}/graph-revisions/${GRAPH_REVISION_ID}/activate`).set("Idempotency-Key", "graph:activate:native").send({});
    expect(activated.status).toBe(200);
    const run = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}/graph-revisions/${GRAPH_REVISION_ID}/nodes/${NODE_ID}/runs`).set("Idempotency-Key", "run:create:native").send({ kind: "agent_run", actor: { principalType: "agent", principalId: "agent-1" } });
    expect(run.status).toBe(201);
    expect(domainApi.createRun).toHaveBeenCalledWith(expect.objectContaining({ workNodeId: NODE_ID }));
  });

  it("starts and cancels a recoverable native Run attempt", async () => {
    const app = await createApp(domainApi);
    const runId = "5de2d166-850e-4c74-ab63-beb86129b52a";
    const attempt = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/runs/${runId}/attempts`)
      .set("Idempotency-Key", "attempt:create:native")
      .send({ runtimeProfile: "host_trusted", executor: { principalType: "service", principalId: "host-trusted-local" } });
    expect(attempt.status).toBe(201);
    expect(domainApi.createRunAttempt).toHaveBeenCalledWith(expect.objectContaining({ runId }));

    const canceled = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/runs/${runId}/cancel`)
      .set("Idempotency-Key", "run:cancel:native")
      .send({});
    expect(canceled.status).toBe(200);
    expect(domainApi.requestRunCancellation).toHaveBeenCalledWith(expect.objectContaining({ runId }));
  });

  it("does not expose compatibility projection mutation routes", async () => {
    const app = await createApp(domainApi);
    expect((await request(app).post(`/api/workspaces/${WORKSPACE_ID}/target-projections`).send({})).status).toBe(404);
    expect((await request(app).post(`/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}/reconcile`).send({})).status).toBe(404);
  });
});
