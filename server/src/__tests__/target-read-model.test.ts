import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  companies,
  createDb,
  toolApplications,
  toolConnections,
  verrailAcceptances,
  verrailActionApprovals,
  verrailActionRequests,
  verrailArtifactRevisions,
  verrailArtifacts,
  verrailAuditEvents,
  verrailClaims,
  verrailDeliveryReviews,
  verrailEffectReceipts,
  verrailEvidence,
  verrailGithubRepoBindings,
  verrailGraphRevisions,
  verrailHumanWorkResults,
  verrailIntegrationAttempts,
  verrailIntegrationRuns,
  verrailRuns,
  verrailSubmissions,
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
    await db.delete(verrailAuditEvents);
    await db.delete(verrailEffectReceipts);
    await db.delete(verrailActionApprovals);
    await db.delete(verrailActionRequests);
    await db.delete(verrailIntegrationAttempts);
    await db.delete(verrailIntegrationRuns);
    await db.delete(verrailHumanWorkResults);
    await db.delete(verrailGithubRepoBindings);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(verrailAcceptances);
    await db.delete(verrailDeliveryReviews);
    await db.delete(verrailSubmissions);
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
    return { workspace, targetId, targetRevisionId, graphRevisionId, node };
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

  it("keeps historical failures inspectable without blocking a ready replacement graph", async () => {
    const seeded = await seed();
    await db.update(verrailRuns).set({ status: "failed" }).where(eq(verrailRuns.targetId, seeded.targetId));
    const original = await db.select().from(verrailGraphRevisions).where(eq(verrailGraphRevisions.id, seeded.graphRevisionId)).then((rows) => rows[0]!);
    const replacementId = randomUUID();
    const replacementNodeId = randomUUID();
    await db.update(verrailGraphRevisions).set({ status: "superseded" }).where(eq(verrailGraphRevisions.id, seeded.graphRevisionId));
    await db.insert(verrailGraphRevisions).values({ ...original, id: replacementId, revisionNumber: 2 });
    await db.insert(verrailWorkNodes).values({ ...seeded.node, id: replacementNodeId, graphRevisionId: replacementId, status: "ready" });
    await db.update(verrailWorkGraphs).set({ activeGraphRevisionId: replacementId }).where(eq(verrailWorkGraphs.id, original.workGraphId));
    const service = targetReadModelService(db);
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspace = await service.workspace(model!);
    expect(workspace.outcome.controls.find((control) => control.key === "graph_complete")?.state).toBe("required");
    expect(workspace.outcome.state).not.toBe("blocked");
    expect(workspace.runs).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(workspace.availableCommands.find((command) => command.id === "create_run"))
      .toMatchObject({ state: "available", reason: null, resourceId: replacementNodeId });

    for (const status of ["blocked", "canceled"] as const) {
      await db.update(verrailWorkNodes).set({ status }).where(eq(verrailWorkNodes.id, replacementNodeId));
      const blocked = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
      expect(blocked?.outcome.state).toBe("blocked");
    }
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

  it("offers activation only for a non-empty draft graph revision", async () => {
    const seeded = await seed();
    await db.delete(verrailRuns);
    await db.delete(verrailWorkNodes);
    await db.update(verrailGraphRevisions).set({ status: "draft", activatedAt: null })
      .where(eq(verrailGraphRevisions.id, seeded.graphRevisionId));
    await db.update(verrailWorkGraphs).set({ activeGraphRevisionId: null, status: "draft" })
      .where(eq(verrailWorkGraphs.targetId, seeded.targetId));
    const service = targetReadModelService(db);
    const emptyModel = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const emptyWorkspace = await service.workspace(emptyModel!);
    expect(emptyWorkspace.availableCommands.find((command) => command.id === "activate_graph_revision"))
      .toMatchObject({ state: "blocked", resourceId: null });

    await db.insert(verrailWorkNodes).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId,
      graphRevisionId: seeded.graphRevisionId, nodeKey: "implement", kind: "agent_task",
      title: "Implement", stageKey: "execute", status: "pending", dependencyNodeKeys: [],
      completionDefinition: "Return a reviewable result.",
    });
    const readyModel = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const readyWorkspace = await service.workspace(readyModel!);
    expect(readyWorkspace.availableCommands.find((command) => command.id === "activate_graph_revision"))
      .toMatchObject({ state: "available", resourceId: seeded.graphRevisionId });
  });

  it("offers a newer non-empty draft even when a previous graph is active", async () => {
    const seeded = await seed();
    const draftId = randomUUID();
    const original = await db.select().from(verrailGraphRevisions).where(eq(verrailGraphRevisions.id, seeded.graphRevisionId)).then((rows) => rows[0]!);
    await db.insert(verrailGraphRevisions).values({ ...original, id: draftId, revisionNumber: 2, status: "draft", activatedAt: null });
    await db.insert(verrailWorkNodes).values({
      ...seeded.node, id: randomUUID(), graphRevisionId: draftId, status: "pending",
    });
    const service = targetReadModelService(db);
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspace = await service.workspace(model!);
    expect(workspace.availableCommands.find((command) => command.id === "activate_graph_revision"))
      .toMatchObject({ state: "available", resourceId: draftId });
    expect(workspace.graph?.activeGraphRevisionId).toBe(seeded.graphRevisionId);

    await db.update(verrailGraphRevisions).set({ status: "superseded" }).where(eq(verrailGraphRevisions.id, draftId));
    const after = await service.workspace((await service.getByTargetId(seeded.workspace.id, seeded.targetId))!);
    expect(after.availableCommands.find((command) => command.id === "activate_graph_revision"))
      .toMatchObject({ state: "completed", resourceId: seeded.graphRevisionId });
  });

  it("does not trust a stored accepted label without reconstructible closure facts", async () => {
    const seeded = await seed();
    await expect(db.update(verrailTargets).set({ status: "not-a-target-state" }).where(eq(verrailTargets.id, seeded.targetId))).rejects.toThrow();
    await db.update(verrailTargets).set({ status: "accepted" }).where(eq(verrailTargets.id, seeded.targetId));
    const model = await targetReadModelService(db).getByTargetId(seeded.workspace.id, seeded.targetId);
    expect(model?.status).toBe("active");
    expect(model?.outcome.validAcceptanceId).toBe(null);
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
    expect(workspace.submissions).toEqual([]);
    expect(workspace.reviews).toEqual([]);
    expect(workspace.acceptances).toEqual([]);
    expect(workspace.integrationRuns).toEqual([]);
    expect(workspace.humanWorkResults).toEqual([]);
    expect(workspace.actionRequests).toEqual([]);
    expect(workspace.effectReceipts).toEqual([]);
    expect(workspace.workspaceBinding).toEqual(null);
    expect(model!.artifactSummary).toEqual({ count: 0, latestRevisionId: null });
    expect(model!.evidenceSummary).toEqual({ count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" });
  });

  it("derives acceptance validity from the latest submission and the active target revision", async () => {
    const seeded = await seed();
    const submissionA = await db.insert(verrailSubmissions).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      artifactRevisionIds: [randomUUID()],
      verificationResultIds: [],
      commitRef: "git:rev-1",
      environmentSummary: null,
      notes: null,
      submissionHash: "a".repeat(64),
      submittedByPrincipalType: "agent",
      submittedByPrincipalId: "agent-1",
      createdAt: new Date("2026-09-01T10:00:00Z"),
    }).returning().then((rows) => rows[0]!);
    const submissionB = await db.insert(verrailSubmissions).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      artifactRevisionIds: [randomUUID()],
      verificationResultIds: [],
      commitRef: "git:rev-2",
      environmentSummary: null,
      notes: null,
      submissionHash: "b".repeat(64),
      submittedByPrincipalType: "agent",
      submittedByPrincipalId: "agent-1",
      createdAt: new Date("2026-09-01T10:05:00Z"),
    }).returning().then((rows) => rows[0]!);
    const reviewA = await db.insert(verrailDeliveryReviews).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      submissionId: submissionA.id,
      reviewerPrincipalType: "user",
      reviewerPrincipalId: "user-2",
      verdict: "approved",
      risks: null,
      unprovenItems: [],
      comments: null,
      reviewHash: "c".repeat(64),
      createdAt: new Date("2026-09-01T10:06:00Z"),
    }).returning().then((rows) => rows[0]!);
    const reviewB = await db.insert(verrailDeliveryReviews).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      submissionId: submissionB.id,
      reviewerPrincipalType: "user",
      reviewerPrincipalId: "user-2",
      verdict: "approved",
      risks: null,
      unprovenItems: [],
      comments: null,
      reviewHash: "d".repeat(64),
      createdAt: new Date("2026-09-01T10:07:00Z"),
    }).returning().then((rows) => rows[0]!);
    const acceptanceA = await db.insert(verrailAcceptances).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      submissionId: submissionA.id,
      reviewId: reviewA.id,
      authority: "outcome_owner",
      acceptedByPrincipalType: "user",
      acceptedByPrincipalId: "user-1",
      acceptanceHash: "e".repeat(64),
      createdAt: new Date("2026-09-01T10:08:00Z"),
    }).returning().then((rows) => rows[0]!);
    const acceptanceB = await db.insert(verrailAcceptances).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      submissionId: submissionB.id,
      reviewId: reviewB.id,
      authority: "outcome_owner",
      acceptedByPrincipalType: "user",
      acceptedByPrincipalId: "user-1",
      acceptanceHash: "f".repeat(64),
      createdAt: new Date("2026-09-01T10:09:00Z"),
    }).returning().then((rows) => rows[0]!);

    const service = targetReadModelService(db);
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspace = await service.workspace(model!);
    expect(workspace.submissions.map((submission) => submission.id)).toEqual([submissionB.id, submissionA.id]);
    expect(workspace.reviews.map((review) => review.id)).toEqual([reviewB.id, reviewA.id]);
    expect(workspace.acceptances).toEqual([
      expect.objectContaining({
        id: acceptanceB.id,
        submissionId: submissionB.id,
        targetRevisionId: seeded.targetRevisionId,
        authority: "outcome_owner",
        validity: "valid",
        invalidReason: null,
      }),
      expect.objectContaining({
        id: acceptanceA.id,
        submissionId: submissionA.id,
        validity: "invalid",
        invalidReason: "superseded_submission",
      }),
    ]);

    const revisionTwoId = randomUUID();
    await db.insert(verrailTargetRevisions).values({
      id: revisionTwoId,
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      revisionNumber: 2,
      title: "Second revision",
      outcomeOwnerPrincipalType: "user",
      outcomeOwnerPrincipalId: "user-1",
      goal: "Second goal.",
      constraints: [],
      acceptanceCriteria: [{ id: "criterion-1", title: "Native only", description: null }],
      riskLevel: "medium",
      resourceRefs: [],
      contentHash: "target-hash-2",
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    });
    await db.update(verrailTargets).set({ activeTargetRevisionId: revisionTwoId }).where(eq(verrailTargets.id, seeded.targetId));

    const modelTwo = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspaceTwo = await service.workspace(modelTwo!);
    expect(workspaceTwo.acceptances).toEqual([
      expect.objectContaining({
        id: acceptanceB.id,
        validity: "invalid",
        invalidReason: "target_revision_changed",
      }),
      expect.objectContaining({
        id: acceptanceA.id,
        validity: "invalid",
        invalidReason: "superseded_submission",
      }),
    ]);
  });

  it("derives accepted only from complete current facts and invalidates stale content", async () => {
    const seeded = await seed();
    await db.delete(verrailRuns);
    await db.update(verrailWorkNodes).set({ status: "completed" }).where(eq(verrailWorkNodes.id, seeded.node.id));
    const artifact = await db.insert(verrailArtifacts).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId,
      kind: "code_change", title: "Release patch", createdByPrincipalType: "agent", createdByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);
    const artifactRevision = await db.insert(verrailArtifactRevisions).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, artifactId: artifact.id, revisionNumber: 1,
      contentHash: "1".repeat(64), contentRef: "git:one", sourceRunId: null, sourceWorkNodeId: null,
      baseRevisionId: null, createdByPrincipalType: "agent", createdByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);
    const claim = await db.insert(verrailClaims).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId, criterionKey: "criterion-1", title: "Native only",
      status: "supported", createdByPrincipalType: "agent", createdByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);
    const evidence = await db.insert(verrailEvidence).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId, claimId: claim.id,
      kind: "ci_result", producerPrincipalType: "service", producerPrincipalId: "ci",
      objectHash: "2".repeat(64), reference: "ci:green", trustLevel: "high",
      createdByPrincipalType: "service", createdByPrincipalId: "ci",
    }).returning().then((rows) => rows[0]!);
    const verification = await db.insert(verrailVerificationResults).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId, claimId: claim.id,
      verdict: "passed", verifierVersion: "ci.v1", evidenceIds: [evidence.id], waiverReference: null,
      resultHash: "3".repeat(64), createdByPrincipalType: "service", createdByPrincipalId: "ci",
    }).returning().then((rows) => rows[0]!);
    const submission = await db.insert(verrailSubmissions).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId, artifactRevisionIds: [artifactRevision.id],
      verificationResultIds: [verification.id], commitRef: "git:one", environmentSummary: "test",
      notes: null, submissionHash: "4".repeat(64), submittedByPrincipalType: "agent",
      submittedByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);
    const review = await db.insert(verrailDeliveryReviews).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId, submissionId: submission.id,
      reviewerPrincipalType: "user", reviewerPrincipalId: "reviewer", verdict: "approved",
      risks: null, unprovenItems: [], comments: null, reviewHash: "5".repeat(64),
    }).returning().then((rows) => rows[0]!);
    const service = targetReadModelService(db);
    const awaitingAcceptance = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const awaitingAcceptanceWorkspace = await service.workspace(awaitingAcceptance!);
    expect(awaitingAcceptanceWorkspace.availableCommands.find(
      (command) => command.id === "accept_submission",
    )).toMatchObject({ state: "available", resourceId: review.id });
    const acceptance = await db.insert(verrailAcceptances).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId, submissionId: submission.id, reviewId: review.id,
      authority: "outcome_owner", acceptedByPrincipalType: "user", acceptedByPrincipalId: "user-1",
      acceptanceHash: "6".repeat(64),
    }).returning().then((rows) => rows[0]!);
    await db.insert(verrailAuditEvents).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, principalType: "agent", principalId: "agent-1",
      eventType: "adjudication.submission_created.v1", aggregateType: "submission", aggregateId: submission.id,
      idempotencyKey: "target-read-model-timeline", payload: { targetId: seeded.targetId },
    });

    const accepted = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    expect(accepted).toMatchObject({
      status: "accepted",
      outcome: { state: "accepted", latestSubmissionId: submission.id, latestReviewId: review.id, validAcceptanceId: acceptance.id },
      attentionSummary: { total: 0, highestSeverity: null },
    });
    const acceptedWorkspace = await service.workspace(accepted!);
    expect(acceptedWorkspace.availableCommands.find((command) => command.id === "accept_submission")?.state).toBe("completed");
    expect(acceptedWorkspace.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "submission_created", aggregateType: "submission", aggregateId: submission.id }),
    ]));

    await db.insert(verrailArtifactRevisions).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, artifactId: artifact.id, revisionNumber: 2,
      contentHash: "7".repeat(64), contentRef: "git:two", sourceRunId: null, sourceWorkNodeId: null,
      baseRevisionId: artifactRevision.id, createdByPrincipalType: "agent", createdByPrincipalId: "agent-1",
    });
    const invalidated = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    expect(invalidated).toMatchObject({ status: "blocked", outcome: { state: "blocked", validAcceptanceId: null } });
    const invalidatedWorkspace = await service.workspace(invalidated!);
    expect(invalidatedWorkspace.attention).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "invalidated_decision", resourceType: "acceptance", resourceId: acceptance.id }),
    ]));
    expect(invalidatedWorkspace.outcome.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "artifact_revisions_current", state: "invalidated" }),
    ]));
  });

  it("surfaces unknown external effects as critical native attention", async () => {
    const seeded = await seed();
    const submission = await db.insert(verrailSubmissions).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId, artifactRevisionIds: [randomUUID()], verificationResultIds: [],
      commitRef: "git:one", environmentSummary: null, notes: null, submissionHash: "8".repeat(64),
      submittedByPrincipalType: "agent", submittedByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);
    const action = await db.insert(verrailActionRequests).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId, submissionId: submission.id,
      actionType: "create_pull_request", params: { title: "Ship", head: "feat", base: "main" },
      paramsHash: "9".repeat(64), expectedCommitRef: "git:one", status: "unknown_effect",
      providerMarker: "a".repeat(64), executionAttemptCount: 1, executionStartedAt: new Date(),
      lastReconciledAt: new Date(), requestedByPrincipalType: "agent", requestedByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);
    const service = targetReadModelService(db);
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    expect(model).toMatchObject({ status: "blocked", outcome: { state: "blocked" } });
    expect((await service.workspace(model!)).attention).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "unknown_effect", severity: "critical", resourceId: action.id }),
    ]));
  });

  it("projects a pending pull request action as requiring approval", async () => {
    const seeded = await seed();
    const submission = await db.insert(verrailSubmissions).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId, artifactRevisionIds: [randomUUID()], verificationResultIds: [],
      commitRef: "git:one", environmentSummary: null, notes: null, submissionHash: "8".repeat(64),
      submittedByPrincipalType: "agent", submittedByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);
    const action = await db.insert(verrailActionRequests).values({
      id: randomUUID(), workspaceId: seeded.workspace.id, targetId: seeded.targetId, submissionId: submission.id,
      actionType: "create_pull_request", params: { title: "Ship", head: "feat", base: "main" },
      paramsHash: "9".repeat(64), expectedCommitRef: "git:one", status: "pending_approval",
      requestedByPrincipalType: "agent", requestedByPrincipalId: "agent-1",
    }).returning().then((rows) => rows[0]!);

    const service = targetReadModelService(db);
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspace = await service.workspace(model!);
    expect(workspace.attention).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "action_approval_required", resourceId: action.id }),
    ]));
    expect(workspace.availableCommands.find((command) => command.id === "approve_action"))
      .toMatchObject({ state: "available", resourceId: action.id });
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

    const assuranceTables = [
      "verrail_artifacts",
      "verrail_artifact_revisions",
      "verrail_claims",
      "verrail_evidence",
      "verrail_verification_results",
      "verrail_submissions",
      "verrail_delivery_reviews",
      "verrail_acceptances",
      "verrail_integration_runs",
      "verrail_action_requests",
      "verrail_action_approvals",
      "verrail_effect_receipts",
      "verrail_github_repo_bindings",
    ];
    for (const table of assuranceTables) {
      expect(queriedTables, `${table} is queried`).toContain(table);
    }
    expect([...queriedTables].filter((table) => !table.startsWith("verrail_"))).toEqual([]);
  });

  it("renders connector facts from the verrail connector tables only", async () => {
    const seeded = await seed();
    const claim = await db.insert(verrailClaims).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      criterionKey: "criterion-1",
      title: "CI passes",
      status: "supported",
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    }).returning().then((rows) => rows[0]!);
    const evidence = await db.insert(verrailEvidence).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      claimId: claim.id,
      kind: "ci_result",
      producerPrincipalType: "service",
      producerPrincipalId: "integration-run",
      objectHash: "a".repeat(64),
      reference: "ci:job:1",
      trustLevel: "high",
      recordedAt: new Date("2026-09-01T08:00:00Z"),
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    }).returning().then((rows) => rows[0]!);
    const verificationResult = await db.insert(verrailVerificationResults).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      claimId: claim.id,
      verdict: "passed",
      verifierVersion: "integration-run.v1",
      evidenceIds: [evidence.id],
      waiverReference: null,
      resultHash: "b".repeat(64),
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    }).returning().then((rows) => rows[0]!);
    const application = await db.insert(toolApplications).values({
      id: randomUUID(),
      companyId: seeded.workspace.id,
      name: "GitHub",
      type: "mcp_http",
    }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      id: randomUUID(),
      companyId: seeded.workspace.id,
      applicationId: application.id,
      name: "GitHub REST",
      uid: "github-rest",
      transport: "rest_api",
    }).returning().then((rows) => rows[0]!);
    const integrationRun = await db.insert(verrailIntegrationRuns).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      graphRevisionId: seeded.graphRevisionId,
      claimId: claim.id,
      workNodeId: seeded.node.id,
      connectorVersion: "github.v1",
      connectionId: connection.id,
      provider: "github",
      externalRef: "ci:run:1",
      commitRef: "0123456789abcdef",
      criterionKey: "criterion-1",
      environmentRef: "github:owner/repo:main",
      conclusion: "success",
      evidenceId: evidence.id,
      verificationResultId: verificationResult.id,
      providerReceipt: { runId: 1 },
      idempotencyKey: "integration:1",
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
      createdAt: new Date("2026-09-01T08:01:00Z"),
    }).returning().then((rows) => rows[0]!);
    const integrationAttempt = await db.insert(verrailIntegrationAttempts).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      integrationRunId: integrationRun.id,
      attemptNumber: 1,
      connectorVersion: "github.v1",
      connectionId: connection.id,
      providerRef: "ci:run:1",
      idempotencyKey: "integration:1",
      providerReceipt: { runId: 1 },
      status: "succeeded",
      createdAt: new Date("2026-09-01T08:01:00Z"),
    }).returning().then((rows) => rows[0]!);
    const humanNode = await db.insert(verrailWorkNodes).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      graphRevisionId: seeded.graphRevisionId,
      nodeKey: "human-check",
      kind: "human_task",
      title: "Human check",
      stageKey: "verify",
      status: "completed",
      dependencyNodeKeys: [],
      completionDefinition: "Record the human result.",
    }).returning().then((rows) => rows[0]!);
    const humanWorkResult = await db.insert(verrailHumanWorkResults).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      graphRevisionId: seeded.graphRevisionId,
      workNodeId: humanNode.id,
      submittedByPrincipalType: "user",
      submittedByPrincipalId: "user-1",
      inputHash: "f".repeat(64),
      result: { decision: "ready" },
      artifactRevisionId: null,
      attachmentHashes: ["0".repeat(64)],
      resultHash: "1".repeat(64),
      idempotencyKey: "human-result:1",
      createdAt: new Date("2026-09-01T08:02:00Z"),
    }).returning().then((rows) => rows[0]!);
    const submission = await db.insert(verrailSubmissions).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      artifactRevisionIds: [randomUUID()],
      verificationResultIds: [verificationResult.id],
      commitRef: "git:rev-1",
      environmentSummary: null,
      notes: null,
      submissionHash: "c".repeat(64),
      submittedByPrincipalType: "agent",
      submittedByPrincipalId: "agent-1",
      createdAt: new Date("2026-09-01T09:00:00Z"),
    }).returning().then((rows) => rows[0]!);
    const params = { title: "Add connector", head: "feat/connector", base: "main", body: "## Verification\n\n- Passed" };
    const paramsHash = "d".repeat(64);
    const providerMarker = "a".repeat(64);
    const actionRequest = await db.insert(verrailActionRequests).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      submissionId: submission.id,
      actionType: "create_pull_request",
      params,
      paramsHash,
      expectedCommitRef: "git:rev-1",
      status: "executed",
      providerMarker,
      executionAttemptCount: 1,
      executionStartedAt: new Date("2026-09-01T09:09:00Z"),
      lastReconciledAt: new Date("2026-09-01T09:10:00Z"),
      requestedByPrincipalType: "agent",
      requestedByPrincipalId: "agent-1",
      createdAt: new Date("2026-09-01T09:05:00Z"),
      updatedAt: new Date("2026-09-01T09:10:00Z"),
    }).returning().then((rows) => rows[0]!);
    const approval = await db.insert(verrailActionApprovals).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      actionRequestId: actionRequest.id,
      approvedByPrincipalType: "user",
      approvedByPrincipalId: "user-2",
      paramsHash,
      createdAt: new Date("2026-09-01T09:08:00Z"),
    }).returning().then((rows) => rows[0]!);
    const effectReceipt = await db.insert(verrailEffectReceipts).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      targetId: seeded.targetId,
      actionRequestId: actionRequest.id,
      actionType: "create_pull_request",
      provider: "github",
      providerMarker,
      externalObjectId: "42",
      externalUrl: "https://github.com/owner/repo/pull/42",
      effectHash: "e".repeat(64),
      payload: {},
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
      createdAt: new Date("2026-09-01T09:10:00Z"),
    }).returning().then((rows) => rows[0]!);
    await db.insert(verrailGithubRepoBindings).values({
      id: randomUUID(),
      workspaceId: seeded.workspace.id,
      connectionId: connection.id,
      repoOwner: "owner",
      repoName: "repo",
      createdByPrincipalType: "user",
      createdByPrincipalId: "user-1",
    });

    const queriedTables = new Set<string>();
    const service = targetReadModelService(recordingDb(db, queriedTables));
    const model = await service.getByTargetId(seeded.workspace.id, seeded.targetId);
    const workspace = await service.workspace(model!);

    expect(workspace.actionRequests[0]?.params.body).toBe("## Verification\n\n- Passed");

    expect(workspace.integrationRuns).toEqual([expect.objectContaining({
      id: integrationRun.id,
      targetId: seeded.targetId,
      targetRevisionId: seeded.targetRevisionId,
      graphRevisionId: seeded.graphRevisionId,
      claimId: claim.id,
      workNodeId: seeded.node.id,
      connectorVersion: "github.v1",
      connectionId: connection.id,
      provider: "github",
      externalRef: "ci:run:1",
      commitRef: "0123456789abcdef",
      criterionKey: "criterion-1",
      environmentRef: "github:owner/repo:main",
      conclusion: "success",
      evidenceId: evidence.id,
      verificationResultId: verificationResult.id,
      providerReceipt: { runId: 1 },
      attempts: [expect.objectContaining({
        id: integrationAttempt.id,
        attemptNumber: 1,
        connectorVersion: "github.v1",
        connectionId: connection.id,
        providerRef: "ci:run:1",
        status: "succeeded",
      })],
      createdBy: { principalType: "user", principalId: "user-1" },
    })]);
    expect(workspace.humanWorkResults).toEqual([expect.objectContaining({
      id: humanWorkResult.id,
      targetRevisionId: seeded.targetRevisionId,
      graphRevisionId: seeded.graphRevisionId,
      workNodeId: humanNode.id,
      submittedBy: { principalType: "user", principalId: "user-1" },
      inputHash: "f".repeat(64),
      result: { decision: "ready" },
      attachmentHashes: ["0".repeat(64)],
      resultHash: "1".repeat(64),
    })]);
    expect(workspace.actionRequests).toEqual([expect.objectContaining({
      id: actionRequest.id,
      submissionId: submission.id,
      actionType: "create_pull_request",
      params,
      paramsHash,
      expectedCommitRef: "git:rev-1",
      status: "executed",
      providerMarker,
      executionAttemptCount: 1,
      requestedBy: { principalType: "agent", principalId: "agent-1" },
      approvals: {
        count: 1,
        latest: expect.objectContaining({
          id: approval.id,
          approvedBy: { principalType: "user", principalId: "user-2" },
          paramsHash,
        }),
      },
      executedReceipt: expect.objectContaining({
        id: effectReceipt.id,
        effectHash: "e".repeat(64),
        externalObjectId: "42",
        externalUrl: "https://github.com/owner/repo/pull/42",
      }),
    })]);
    expect(workspace.effectReceipts).toEqual([expect.objectContaining({
      id: effectReceipt.id,
      actionRequestId: actionRequest.id,
      actionType: "create_pull_request",
      provider: "github",
      providerMarker,
      externalObjectId: "42",
      effectHash: "e".repeat(64),
      createdBy: { principalType: "user", principalId: "user-1" },
    })]);
    expect(workspace.workspaceBinding).toEqual({ repoOwner: "owner", repoName: "repo" });

    const connectorTables = [
      "verrail_integration_runs",
      "verrail_integration_attempts",
      "verrail_human_work_results",
      "verrail_action_requests",
      "verrail_action_approvals",
      "verrail_effect_receipts",
      "verrail_github_repo_bindings",
    ];
    for (const table of connectorTables) {
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
