import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  caseIssueLinks,
  cases,
  companyMemberships,
  companies,
  createDb,
  issues,
  projects,
  targetProjectionRevisions,
  targetProjectionSources,
  verrailTargetRevisions,
  verrailTargets,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { targetProjectionUuidV5, targetReadModelService } from "../services/target-read-model.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("targetProjectionUuidV5", () => {
  it("matches the cross-language UUIDv5 contract", () => {
    expect(targetProjectionUuidV5(
      "91552506-d624-4f00-97cc-e5b6f4dff680",
      "00000000-0000-4000-8000-000000000001\nissue\n00000000-0000-4000-8000-000000000002",
    )).toBe("6335ad12-b200-54a5-a618-2e01c6cfe8e7");
  });
});

describeEmbeddedPostgres("TargetReadModel projection persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let counter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-target-projection-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(verrailTargetRevisions);
    await db.delete(verrailTargets);
    await db.delete(targetProjectionRevisions);
    await db.delete(targetProjectionSources);
    await db.delete(caseIssueLinks);
    await db.delete(cases);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWorkspace() {
    counter += 1;
    const [workspace] = await db.insert(companies).values({
      name: `Projection ${counter}`,
      issuePrefix: `TRM${counter}`,
    }).returning();
    const [project] = await db.insert(projects).values({
      companyId: workspace.id,
      name: "Control plane",
    }).returning();
    return { workspace, project };
  }

  it("registers an eligible root Issue idempotently and preserves immutable revisions", async () => {
    const { workspace, project } = await seedWorkspace();
    const [issue] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      title: "Ship governed delivery",
      description: "Produce a reviewable result",
      status: "in_progress",
      issueNumber: 1,
      identifier: `${workspace.issuePrefix}-1`,
      responsibleUserId: "user-1",
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: workspace.id,
      principalType: "user",
      principalId: "user-1",
      status: "active",
    });
    const service = targetReadModelService(db);

    const first = await service.register(workspace.id, {
      sourceType: "issue",
      sourceId: issue.id,
      eligibilityReason: "operator_mapping",
    });
    const repeated = await service.register(workspace.id, {
      sourceType: "issue",
      sourceId: issue.id,
      eligibilityReason: "operator_mapping",
    });

    expect(repeated.targetId).toBe(first.targetId);
    expect(repeated.activeTargetRevisionId).toBe(first.activeTargetRevisionId);
    expect(repeated).toEqual(first);
    expect(first.status).toBe("active");
    expect(first.currentStage?.key).toBe("execute");
    expect(first.outcomeOwner?.principalId).toBe("user-1");
    expect(first.compatibility.readOnly).toBe(true);
    expect(await service.list(workspace.id)).toHaveLength(1);
    expect(await db.select().from(targetProjectionRevisions)).toHaveLength(1);

    const nextUpdatedAt = new Date(issue.updatedAt.getTime() + 1_000);
    await db.update(issues).set({ status: "done", updatedAt: nextUpdatedAt }).where(eq(issues.id, issue.id));
    const stale = await service.getByTargetId(workspace.id, first.targetId);
    expect(stale?.compatibility.warnings).toContain("projection_stale");

    const reconciled = await service.reconcile(workspace.id, first.targetId);
    expect(reconciled.activeTargetRevisionId).not.toBe(first.activeTargetRevisionId);
    expect(reconciled.status).toBe("awaiting_acceptance");
    expect(reconciled.compatibility.completionUnverified).toBe(true);
    expect((await service.getByRevisionId(
      workspace.id,
      first.targetId,
      first.activeTargetRevisionId,
    ))?.status).toBe("active");

    await db.delete(issues).where(eq(issues.id, issue.id));
    expect(await service.list(workspace.id)).toEqual([]);
    expect(await service.getByTargetId(workspace.id, first.targetId)).toBeNull();
    expect((await service.getByRevisionId(
      workspace.id,
      first.targetId,
      first.activeTargetRevisionId,
    ))?.compatibility.warnings).toContain("source_missing");
  });

  it("normalizes the bounded legacy snapshot and reconciles it to the canonical shape", async () => {
    const { workspace, project } = await seedWorkspace();
    const [issue] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      title: "Upgrade the persisted projection",
      status: "in_progress",
      issueNumber: 1,
      identifier: `${workspace.issuePrefix}-1`,
      responsibleUserId: "owner-1",
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: workspace.id,
      principalType: "user",
      principalId: "owner-1",
      status: "active",
    });
    const service = targetReadModelService(db);
    const current = await service.register(workspace.id, {
      sourceType: "issue",
      sourceId: issue.id,
      eligibilityReason: "operator_mapping",
    });
    const legacyRevisionId = "7f57b7ee-040f-5c8b-b221-761dc2e0088d";
    const legacyProjection = { ...current } as Record<string, unknown>;
    delete legacyProjection.authority;
    delete legacyProjection.definition;
    legacyProjection.activeTargetRevisionId = legacyRevisionId;
    await db.delete(targetProjectionRevisions).where(eq(
      targetProjectionRevisions.targetRevisionId,
      current.activeTargetRevisionId,
    ));
    await db.insert(targetProjectionRevisions).values({
      workspaceId: workspace.id,
      targetId: current.targetId,
      targetRevisionId: legacyRevisionId,
      projectionPolicyVersion: current.projectionPolicyVersion,
      sourceRevisionKey: current.source.revisionKey,
      sourceSnapshotHash: "legacy-pre-contract-shape",
      schemaVersion: "1",
      projection: legacyProjection as never,
    });
    await db.update(targetProjectionSources).set({
      activeTargetRevisionId: legacyRevisionId,
      sourceSnapshotHash: "legacy-pre-contract-shape",
    }).where(eq(targetProjectionSources.targetId, current.targetId));

    const upgraded = await service.getByTargetId(workspace.id, current.targetId);
    expect(upgraded).toMatchObject({
      targetId: current.targetId,
      activeTargetRevisionId: legacyRevisionId,
      authority: { kind: "compatibility", writer: "typescript-compatibility" },
      definition: null,
      compatibility: { warnings: ["projection_schema_upgraded"] },
    });
    expect((await service.list(workspace.id))[0]).toMatchObject({
      targetId: current.targetId,
      compatibility: { warnings: ["projection_schema_upgraded"] },
    });

    const reconciled = await service.reconcile(workspace.id, current.targetId);
    expect(reconciled.targetId).toBe(current.targetId);
    expect(reconciled.activeTargetRevisionId).not.toBe(legacyRevisionId);
    expect(reconciled.compatibility.warnings).not.toContain("projection_schema_upgraded");
    const activeSource = await db.select().from(targetProjectionSources)
      .where(eq(targetProjectionSources.targetId, current.targetId))
      .then((rows) => rows[0]);
    expect(activeSource.activeTargetRevisionId).toBe(reconciled.activeTargetRevisionId);
    const canonicalSnapshot = await db.select().from(targetProjectionRevisions)
      .where(eq(targetProjectionRevisions.targetRevisionId, reconciled.activeTargetRevisionId))
      .then((rows) => rows[0]?.projection);
    expect(canonicalSnapshot).toMatchObject({
      authority: { kind: "compatibility", writer: "typescript-compatibility" },
      definition: null,
    });
  });

  it("isolates a corrupt snapshot while keeping valid Targets discoverable", async () => {
    const { workspace, project } = await seedWorkspace();
    await db.insert(companyMemberships).values({
      companyId: workspace.id,
      principalType: "user",
      principalId: "owner-1",
      status: "active",
    });
    const [validIssue, corruptIssue] = await db.insert(issues).values([
      {
        companyId: workspace.id,
        projectId: project.id,
        title: "Valid Target",
        identifier: `${workspace.issuePrefix}-1`,
        responsibleUserId: "owner-1",
      },
      {
        companyId: workspace.id,
        projectId: project.id,
        title: "Corrupt Target",
        identifier: `${workspace.issuePrefix}-2`,
        responsibleUserId: "owner-1",
      },
    ]).returning();
    const service = targetReadModelService(db);
    const valid = await service.register(workspace.id, {
      sourceType: "issue",
      sourceId: validIssue.id,
      eligibilityReason: "operator_mapping",
    });
    const corrupt = await service.register(workspace.id, {
      sourceType: "issue",
      sourceId: corruptIssue.id,
      eligibilityReason: "operator_mapping",
    });
    await db.update(targetProjectionRevisions).set({
      projection: { schemaVersion: 1 } as never,
    }).where(eq(targetProjectionRevisions.targetRevisionId, corrupt.activeTargetRevisionId));

    expect((await service.list(workspace.id)).map((item) => item.targetId)).toEqual([valid.targetId]);
    await expect(service.getByTargetId(workspace.id, corrupt.targetId)).rejects.toMatchObject({
      status: 503,
      details: expect.objectContaining({
        code: "TARGET_PROJECTION_UNAVAILABLE",
        reason: "snapshot_schema_or_identity_invalid",
      }),
    });
  });

  it("rejects a historical snapshot whose source identity conflicts with its mapping", async () => {
    const { workspace, project } = await seedWorkspace();
    await db.insert(companyMemberships).values({
      companyId: workspace.id,
      principalType: "user",
      principalId: "owner-1",
      status: "active",
    });
    const [issue] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      title: "Historical source identity",
      identifier: `${workspace.issuePrefix}-1`,
      responsibleUserId: "owner-1",
    }).returning();
    const service = targetReadModelService(db);
    const model = await service.register(workspace.id, {
      sourceType: "issue",
      sourceId: issue.id,
      eligibilityReason: "operator_mapping",
    });
    const [stored] = await db.select({ projection: targetProjectionRevisions.projection })
      .from(targetProjectionRevisions)
      .where(eq(targetProjectionRevisions.targetRevisionId, model.activeTargetRevisionId));
    await db.update(targetProjectionRevisions).set({
      projection: {
        ...(stored.projection as Record<string, unknown>),
        source: {
          ...(model.source as Record<string, unknown>),
          id: "00000000-0000-4000-8000-000000000099",
        },
      },
    }).where(eq(targetProjectionRevisions.targetRevisionId, model.activeTargetRevisionId));

    await expect(service.getByRevisionId(
      workspace.id,
      model.targetId,
      model.activeTargetRevisionId,
    )).rejects.toMatchObject({
      status: 503,
      details: expect.objectContaining({
        code: "TARGET_PROJECTION_UNAVAILABLE",
        reason: "snapshot_schema_or_identity_invalid",
      }),
    });
  });

  it("projects an explicitly mapped Case without inventing missing assurance facts", async () => {
    const { workspace, project } = await seedWorkspace();
    const [source] = await db.insert(cases).values({
      companyId: workspace.id,
      projectId: project.id,
      caseNumber: 1,
      identifier: `${workspace.issuePrefix}-C1`,
      caseType: "delivery",
      title: "Release candidate",
      status: "approved",
      fields: { riskLevel: "high", outcomeOwner: { principalType: "user", principalId: "owner-1" } },
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: workspace.id,
      principalType: "user",
      principalId: "owner-1",
      status: "active",
    });

    const model = await targetReadModelService(db).register(workspace.id, {
      sourceType: "case",
      sourceId: source.id,
      eligibilityReason: "approved_backfill",
    });

    expect(model.status).toBe("awaiting_acceptance");
    expect(model.compatibility.completionUnverified).toBe(false);
    expect(model.risk.level).toBe("high");
    expect(model.outcomeOwner?.principalId).toBe("owner-1");
    expect(model.evidenceSummary.coverage).toBe("unknown");
    expect(model.compatibility.missingFields).toContain("acceptanceCriteria");
  });

  it("rejects child, system-derived, and Case-owned Issues", async () => {
    const { workspace, project } = await seedWorkspace();
    const [parent] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      title: "Parent",
      identifier: `${workspace.issuePrefix}-1`,
    }).returning();
    const [child] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      parentId: parent.id,
      title: "Child",
      identifier: `${workspace.issuePrefix}-2`,
    }).returning();
    const [system] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      title: "Watchdog",
      identifier: `${workspace.issuePrefix}-3`,
      originKind: "task_watchdog",
    }).returning();
    const [pluginOperation] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      title: "Plugin operation",
      identifier: `${workspace.issuePrefix}-4`,
      originKind: "plugin:verrail.example:operation",
    }).returning();
    const [sourceCase] = await db.insert(cases).values({
      companyId: workspace.id,
      projectId: project.id,
      caseNumber: 1,
      identifier: `${workspace.issuePrefix}-C1`,
      caseType: "delivery",
      title: "Case",
    }).returning();
    await db.insert(caseIssueLinks).values({
      companyId: workspace.id,
      caseId: sourceCase.id,
      issueId: parent.id,
      role: "work",
    });
    const service = targetReadModelService(db);

    await expect(service.register(workspace.id, {
      sourceType: "issue",
      sourceId: child.id,
      eligibilityReason: "operator_mapping",
    })).rejects.toThrow("child Issue");
    await expect(service.register(workspace.id, {
      sourceType: "issue",
      sourceId: system.id,
      eligibilityReason: "operator_mapping",
    })).rejects.toThrow("system-derived Issue");
    await expect(service.register(workspace.id, {
      sourceType: "issue",
      sourceId: pluginOperation.id,
      eligibilityReason: "operator_mapping",
    })).rejects.toThrow("plugin operation Issue");
    await expect(service.register(workspace.id, {
      sourceType: "issue",
      sourceId: parent.id,
      eligibilityReason: "operator_mapping",
    })).rejects.toThrow("belongs to a Case Target");
  });

  it("requires explicit Project and outcome owner semantics for an independent Issue", async () => {
    const { workspace, project } = await seedWorkspace();
    const [withoutProject] = await db.insert(issues).values({
      companyId: workspace.id,
      title: "Unscoped outcome",
      identifier: `${workspace.issuePrefix}-1`,
      responsibleUserId: "owner-1",
    }).returning();
    const [withoutOwner] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      title: "Unowned outcome",
      identifier: `${workspace.issuePrefix}-2`,
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: workspace.id,
      principalType: "user",
      principalId: "owner-1",
      status: "active",
    });
    const service = targetReadModelService(db);

    await expect(service.register(workspace.id, {
      sourceType: "issue",
      sourceId: withoutProject.id,
      eligibilityReason: "operator_mapping",
    })).rejects.toThrow("explicit Project");
    await expect(service.register(workspace.id, {
      sourceType: "issue",
      sourceId: withoutOwner.id,
      eligibilityReason: "operator_mapping",
    })).rejects.toThrow("outcome owner");
  });

  it("rejects an outcome owner outside the source Workspace", async () => {
    const { workspace, project } = await seedWorkspace();
    const [issue] = await db.insert(issues).values({
      companyId: workspace.id,
      projectId: project.id,
      title: "Cross-workspace owner",
      identifier: `${workspace.issuePrefix}-1`,
      responsibleUserId: "missing-owner",
    }).returning();

    await expect(targetReadModelService(db).register(workspace.id, {
      sourceType: "issue",
      sourceId: issue.id,
      eligibilityReason: "operator_mapping",
    })).rejects.toThrow("does not belong to the source Workspace");
  });

  it("isolates a missing active snapshot from lists and reports detail as temporarily unavailable", async () => {
    const { workspace } = await seedWorkspace();
    const targetId = "b80f266a-87ea-57f0-81bd-c4f04e4d576e";
    await db.insert(targetProjectionSources).values({
      workspaceId: workspace.id,
      targetId,
      sourceType: "issue",
      sourceId: "41c96b31-d0d9-420a-84dd-34638354040c",
      projectionPolicyVersion: "g1.v1",
      eligibilityReason: "operator_mapping",
      activeTargetRevisionId: "0de2d166-850e-5c74-ab63-beb86129b52a",
      sourceRevisionKey: "2026-08-26T10:00:00.000Z",
      sourceSnapshotHash: "missing",
      lastProjectedAt: new Date("2026-08-26T10:00:01.000Z"),
    });
    const service = targetReadModelService(db);

    await expect(service.getByTargetId(workspace.id, targetId)).rejects.toMatchObject({
      status: 503,
      details: expect.objectContaining({ code: "TARGET_PROJECTION_UNAVAILABLE" }),
    });
    expect(await service.list(workspace.id)).toEqual([]);
  });

  it("reads Go-owned native Target facts without a Case or Issue surrogate", async () => {
    const { workspace, project } = await seedWorkspace();
    const targetId = "a898d928-6904-42c3-a343-c5ea9399acb9";
    const revisionId = "c1501865-e139-401c-82d7-cd2c11e8ef7f";
    await db.insert(verrailTargets).values({
      id: targetId,
      workspaceId: workspace.id,
      projectId: project.id,
      activeTargetRevisionId: revisionId,
      status: "draft",
      createdByPrincipalType: "user",
      createdByPrincipalId: "owner-1",
    });
    await db.insert(verrailTargetRevisions).values({
      id: revisionId,
      workspaceId: workspace.id,
      targetId,
      revisionNumber: 1,
      title: "Native Target",
      summary: "Created by the Go Domain API",
      outcomeOwnerPrincipalType: "user",
      outcomeOwnerPrincipalId: "owner-1",
      outcomeOwnerDisplayName: "Owner",
      goal: "Prove the native vertical slice.",
      constraints: ["No surrogate Issue"],
      acceptanceCriteria: [{ id: "criterion-1", title: "One writer", description: null }],
      riskLevel: "medium",
      deadline: "2026-09-30",
      policySummary: "Governed creation",
      contentHash: "hash",
      createdByPrincipalType: "user",
      createdByPrincipalId: "owner-1",
    });

    const service = targetReadModelService(db);
    const active = await service.getByTargetId(workspace.id, targetId);
    expect(active).toMatchObject({
      targetId,
      activeTargetRevisionId: revisionId,
      authority: { kind: "native", writer: "go-domain-api" },
      source: { type: "native", id: targetId },
      definition: {
        goal: "Prove the native vertical slice.",
        constraints: ["No surrogate Issue"],
        deadline: "2026-09-30",
      },
      compatibility: null,
    });
    expect((await service.getByRevisionId(workspace.id, targetId, revisionId))?.title).toBe("Native Target");
    expect((await service.list(workspace.id)).map((item) => item.targetId)).toEqual([targetId]);
  });
});
