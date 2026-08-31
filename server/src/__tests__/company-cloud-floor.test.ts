import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => ({}),
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => ({}),
  companyPortabilityService: () => ({}),
  companyService: () => mockCompanyService,
  feedbackService: () => ({}),
  logActivity: mockLogActivity,
  workTimelineService: () => ({}),
}));

const companyRouteModulesPromise = Promise.all([
  import("../routes/companies.js"),
  import("../middleware/index.js"),
]);

const createdCompany = {
  id: "company-new",
  name: "New Company",
  budgetMonthlyCents: 0,
};

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await companyRouteModulesPromise;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies Cloud floor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
    mockCompanyService.create.mockResolvedValue(createdCompany);
    mockCompanyService.list.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
  });

  it("returns 403 cloud_managed before creating a second company on Cloud", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-secret";
    const app = await createApp({
      type: "board",
      source: "cloud_tenant",
      userId: "cloud-user",
      isInstanceAdmin: true,
    });

    const res = await request(app).post("/api/companies").send({ name: "Second Company" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "cloud_managed" });
    expect(mockCompanyService.create).not.toHaveBeenCalled();
    expect(mockAccessService.ensureMembership).not.toHaveBeenCalled();
  });

  it("applies the Cloud floor before request-body validation", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-secret";
    const app = await createApp({
      type: "board",
      source: "cloud_tenant",
      userId: "cloud-user",
      isInstanceAdmin: true,
    });

    const res = await request(app).post("/api/companies").send({ name: "" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "cloud_managed" });
    expect(mockCompanyService.create).not.toHaveBeenCalled();
  });

  it("preserves self-hosted company creation", async () => {
    const app = await createApp({
      type: "board",
      source: "local_implicit",
      userId: "local-user",
      isInstanceAdmin: true,
    });

    const res = await request(app).post("/api/companies").send({ name: "New Company" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(createdCompany);
    expect(mockCompanyService.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "New Company",
      defaultResponsibleUserId: "local-user",
    }));
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      "company-new",
      "user",
      "local-user",
      "owner",
      "active",
    );
  });

  it("provisions one default Verrail workspace for a trusted empty local instance", async () => {
    const app = await createApp({
      type: "board",
      source: "local_implicit",
      userId: "local-user",
      isInstanceAdmin: true,
    });

    const res = await request(app).get("/api/companies");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([createdCompany]);
    expect(mockCompanyService.create).toHaveBeenCalledWith({
      name: "My Workspace",
      description: "",
      defaultResponsibleUserId: "local-user",
      enableVerrailNavigation: true,
    });
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      "company-new",
      "user",
      "local-user",
      "owner",
      "active",
    );
    expect(mockAccessService.ensureRoleDefaultGrants).toHaveBeenCalledWith(
      "company-new",
      "local-user",
      "owner",
      "local-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "workspace.default_created",
      entityId: "company-new",
    }));
  });
});
