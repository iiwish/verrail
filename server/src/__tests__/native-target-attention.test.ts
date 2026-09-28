import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  verrailTargetRevisions,
  verrailTargets,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("native Target Home attention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-target-attention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => tempDb?.cleanup());

  it("surfaces Target facts directly without an Issue or Heartbeat shadow", async () => {
    const workspace = await db.insert(companies).values({ name: "Native Home", issuePrefix: "NTH" }).returning().then((rows) => rows[0]!);
    const targetId = randomUUID();
    const targetRevisionId = randomUUID();
    await db.insert(verrailTargets).values({
      id: targetId,
      workspaceId: workspace.id,
      activeTargetRevisionId: targetRevisionId,
      status: "draft",
      createdByPrincipalType: "user",
      createdByPrincipalId: "owner",
    });
    await db.insert(verrailTargetRevisions).values({
      id: targetRevisionId,
      workspaceId: workspace.id,
      targetId,
      revisionNumber: 1,
      title: "Native attention target",
      outcomeOwnerPrincipalType: "user",
      outcomeOwnerPrincipalId: "owner",
      goal: "Appear on Home from native facts.",
      constraints: [],
      acceptanceCriteria: [{ id: "criterion-1", title: "Visible", description: null }],
      riskLevel: "medium",
      resourceRefs: [],
      contentHash: "1".repeat(64),
      createdByPrincipalType: "user",
      createdByPrincipalId: "owner",
    });

    const feed = await attentionService(db).list(workspace.id, { userId: "owner" });
    expect(feed.countsBySourceKind.target).toBe(1);
    expect(feed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKind: "target",
        whyNow: "Work graph needs activation",
        subject: expect.objectContaining({
          kind: "target",
          id: targetId,
          status: "draft",
          href: `/NTH/targets/${targetId}/overview`,
          metadata: expect.objectContaining({ attentionKind: "draft_graph", targetRevisionId }),
        }),
      }),
    ]));
  });
});
