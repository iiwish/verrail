import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, verrailCollections } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTargetService = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return { ...actual, targetReadModelService: () => mockTargetService };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Collection routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-collections-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(verrailCollections);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => tempDb?.cleanup());

  async function appFor(workspaceId: string) {
    const { collectionRoutes } = await import("../routes/collections.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "owner-1",
        companyIds: [workspaceId],
        memberships: [{ companyId: workspaceId, membershipRole: "owner", status: "active" }],
        source: "session",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", collectionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("creates and lists Workspace-owned Collections", async () => {
    const [workspace] = await db.insert(companies).values({ name: "Workspace", issuePrefix: "COL" }).returning();
    mockTargetService.list.mockResolvedValue([]);
    const app = await appFor(workspace.id);

    const created = await request(app)
      .post(`/api/workspaces/${workspace.id}/collections`)
      .send({ name: "Release work", description: "September Targets" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Release work", targetCount: 0 });

    const listed = await request(app).get(`/api/workspaces/${workspace.id}/collections`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([expect.objectContaining({ id: created.body.id, name: "Release work" })]);
  });
});
