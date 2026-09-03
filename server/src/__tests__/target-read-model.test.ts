import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  companies,
  createDb,
  verrailArtifactRevisions,
  verrailArtifacts,
  verrailClaims,
  verrailEvidence,
  verrailGraphRevisions,
  verrailRuns,
  verrailTargetRevisions,
  verrailTargets,
  verrailVerificationResults,
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
    await db.delete(verrailVerificationResults);
    await db.delete(verrailEvidence);
    await db.delete(verrailClaims);
    await db.delete(verrailArtifactRevisions);
    await db.delete(verrailArtifacts);
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

  it("keeps assurance sets honest-empty when no facts exist", async () => {
    const seeded = await seed();
    const service = targetReadModelService(db);
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspace = await service.workspace(model!);
    expect(workspace.artifacts).toEqual([]);
    expect(workspace.claims).toEqual([]);
    expect(workspace.evidence).toEqual([]);
    expect(workspace.verificationResults).toEqual([]);
    expect(model!.artifactSummary).toEqual({ count: 0, latestRevisionId: null });
    expect(model!.evidenceSummary).toEqual({ count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" });
  });

  it("renders assurance facts from the verrail assurance tables only", async () => {
    const seeded = await seed();
    const artifact = await db.insert(verrailArtifacts).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      kind: "code_change",
      title: "Patch",
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    }).returning().then((rows) => rows[0]!);
    const revisionTwo = await db.insert(verrailArtifactRevisions).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      artifactId: artifact.id,
      revisionNumber: 2,
      contentHash: "b".repeat(64),
      contentRef: "git:rev-2",
      sourceRunId: null,
      sourceWorkNodeId: null,
      baseRevisionId: null,
      createdByPrincipalType: "agent",
      createdByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);
    await db.insert(verrailArtifactRevisions).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      artifactId: artifact.id,
      revisionNumber: 1,
      contentHash: "a".repeat(64),
      contentRef: "git:rev-1",
      sourceRunId: null,
      sourceWorkNodeId: null,
      baseRevisionId: null,
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    });
    const claim = await db.insert(verrailClaims).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      criterionKey: "criterion-1",
      title: "Criterion holds",
      status: "supported",
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    }).returning().then((rows) => rows[0]!);
    const firstEvidence = await db.insert(verrailEvidence).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      claimId: claim.id,
      kind: "ci_result",
      producerPrincipalType: "service",
      producerPrincipalId: "ci",
      objectHash: "c".repeat(64),
      reference: "ci:run:1",
      trustLevel: "high",
      recordedAt: new Date("2026-09-01T08:01:00Z"),
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    }).returning().then((rows) => rows[0]!);
    const secondEvidence = await db.insert(verrailEvidence).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      claimId: claim.id,
      kind: "human_review",
      producerPrincipalType: "user",
      producerPrincipalId: "user-1",
      objectHash: "d".repeat(64),
      reference: "review:1",
      trustLevel: "medium",
      recordedAt: new Date("2026-09-01T08:02:00Z"),
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    }).returning().then((rows) => rows[0]!);
    await db.insert(verrailVerificationResults).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      claimId: claim.id,
      verdict: "passed",
      verifierVersion: "verifier@1",
      evidenceIds: [firstEvidence.id, secondEvidence.id],
      waiverReference: null,
      resultHash: "e".repeat(64),
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    });

    const queriedTables = new Set<string>();
    const service = targetReadModelService(recordingDb(db, queriedTables));
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspace = await service.workspace(model!);

    expect(workspace.artifacts).toEqual([expect.objectContaining({
      id: artifact.id,
      targetId: seeded.targetId,
      kind: "code_change",
      title: "Patch",
      createdBy: { principalType: "user", principalId: "user-1" },
      revisions: [
        expect.objectContaining({ revisionNumber: 1, contentRef: "git:rev-1", createdBy: { principalType: "user", principalId: "user-1" } }),
        expect.objectContaining({ revisionNumber: 2, contentRef: "git:rev-2", createdBy: { principalType: "agent", principalId: "agent-1" } }),
      ],
    })]);
    expect(workspace.claims).toEqual([expect.objectContaining({
      id: claim.id,
      criterionKey: "criterion-1",
      status: "supported",
      createdBy: { principalType: "user", principalId: "user-1" },
    })]);
    expect(workspace.evidence).toEqual([
      expect.objectContaining({ id: firstEvidence.id, producer: { principalType: "service", principalId: "ci" }, trustLevel: "high" }),
      expect.objectContaining({ id: secondEvidence.id, producer: { principalType: "user", principalId: "user-1" }, trustLevel: "medium" }),
    ]);
    expect(workspace.verificationResults).toEqual([expect.objectContaining({
      claimId: claim.id,
      verdict: "passed",
      evidenceIds: [firstEvidence.id, secondEvidence.id],
      waiverReference: null,
    })]);
    expect(model!.artifactSummary).toEqual({ count: 1, latestRevisionId: revisionTwo.id });
    expect(model!.evidenceSummary).toEqual({ count: 2, passed: 1, failed: 0, inconclusive: 0, coverage: "complete" });

    const assuranceTables = ["verrail_artifacts", "verrail_artifact_revisions", "verrail_claims", "verrail_evidence", "verrail_verification_results"];
    for (const table of assuranceTables) {
      expect(queriedTables, `${table} is queried`).toContain(table);
    }
    expect([...queriedTables].filter((table) => !table.startsWith("verrail_"))).toEqual([]);
  });
});

function recordingDb(db: ReturnType<typeof createDb>, queriedTables: Set<string>) {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "select") return Reflect.get(target, property, receiver);
      return (...selectArgs: unknown[]) => {
        const builder = (target.select as (...args: unknown[]) => unknown)(...selectArgs);
        return new Proxy(builder, {
          get(builderTarget, builderProperty, builderReceiver) {
            if (builderProperty !== "from") return Reflect.get(builderTarget, builderProperty, builderReceiver);
            return (...fromArgs: unknown[]) => {
              for (const arg of fromArgs) {
                if (arg && typeof arg === "object") queriedTables.add(getTableName(arg as Parameters<typeof getTableName>[0]));
              }
              return (builderTarget.from as (...args: unknown[]) => unknown)(...fromArgs);
            };
          },
        });
      };
    },
  });
}
