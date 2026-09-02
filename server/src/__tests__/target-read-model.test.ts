import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  verrailGraphRevisions,
  verrailRuns,
  verrailTargetRevisions,
  verrailTargets,
  verrailWorkGraphs,
  verrailWorkNodes,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { targetReadModelService } from "../services/target-read-model.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("native TargetReadModel", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-native-target-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(verrailRuns);
    await db.delete(verrailWorkNodes);
    await db.delete(verrailGraphRevisions);
    await db.delete(verrailWorkGraphs);
    await db.delete(verrailTargetRevisions);
    await db.delete(verrailTargets);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const workspace = await db.insert(companies).values({ name: "Native", issuePrefix: "NAT" }).returning().then((rows) => rows[0]!);
    const targetId = randomUUID();
    const targetRevisionId = randomUUID();
    const workGraphId = randomUUID();
    const graphRevisionId = randomUUID();
    await db.insert(verrailTargets).values({
      id: targetId,
      workspaceId: workspace.id,
      activeTargetRevisionId: targetRevisionId,
      status: "active",
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    });
    await db.insert(verrailTargetRevisions).values({
      id: targetRevisionId,
      workspaceId: workspace.id,
      targetId,
      revisionNumber: 1,
      title: "Native delivery",
      outcomeOwnerPrincipalType: "user",
      outcomeOwnerPrincipalId: "user-1",
      goal: "Prove native facts.",
      constraints: [],
      acceptanceCriteria: [{ id: "criterion-1", title: "Native only", description: null }],
      riskLevel: "medium",
      resourceRefs: [],
      contentHash: "target-hash",
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    });
    await db.insert(verrailWorkGraphs).values({ id: workGraphId, workspaceId: workspace.id, targetId, activeGraphRevisionId: graphRevisionId, status: "active" });
    await db.insert(verrailGraphRevisions).values({ id: graphRevisionId, workspaceId: workspace.id, targetId, targetRevisionId, workGraphId, revisionNumber: 1, status: "active", contentHash: "graph-hash", createdByPrincipalType: "user", createdByPrincipalId: "user-1", activatedAt: new Date() });
    const node = await db.insert(verrailWorkNodes).values({ id: randomUUID(), workspaceId: workspace.id, targetId, graphRevisionId, nodeKey: "implement", kind: "agent_task", title: "Implement", stageKey: "execute", status: "running", dependencyNodeKeys: [], completionDefinition: "Return a reviewable result." }).returning().then((rows) => rows[0]!);
    await db.insert(verrailRuns).values({ id: randomUUID(), workspaceId: workspace.id, targetId, targetRevisionId, graphRevisionId, workNodeId: node.id, kind: "agent", status: "queued", actorPrincipalType: "agent", actorPrincipalId: randomUUID(), attemptCount: 1, idempotencyKey: `run:${randomUUID()}` });
    return { workspace, targetId, targetRevisionId };
  }

  it("reads only native Target, graph, WorkNode, and Run facts", async () => {
    const seeded = await seed();
    const service = targetReadModelService(db);
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    expect(model).toMatchObject({
      readModelPolicyVersion: "native.v1",
      targetId: seeded.targetId,
      definition: { goal: "Prove native facts." },
      runSummary: { active: 1, failed: 0 },
    });
    const workspace = await service.workspace(model!);
    expect(workspace.graph).toMatchObject({ status: "active", revisionNumber: 1 });
    expect(workspace.work).toEqual([expect.objectContaining({ nodeKey: "implement", kind: "agent_task" })]);
    expect(workspace.runs).toEqual([expect.objectContaining({ kind: "agent_run", status: "queued" })]);
    expect(workspace.stages.find((stage) => stage.key === "execute")?.state).toBe("current");
  });

  it("represents a missing active graph as native attention instead of compatibility work", async () => {
    const seeded = await seed();
    await db.delete(verrailRuns);
    await db.delete(verrailWorkNodes);
    await db.delete(verrailGraphRevisions);
    await db.delete(verrailWorkGraphs);
    const service = targetReadModelService(db);
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspace = await service.workspace(model!);
    expect(workspace.work).toEqual([]);
    expect(workspace.attention).toEqual([expect.objectContaining({ kind: "draft_graph" })]);
  });
});
