import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  verrailConversationContextBindings,
  verrailConversationMessages,
  verrailConversations,
  verrailTargetCreationDraftRevisions,
  verrailTargetCreationDrafts,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { targetCreationDraftService } from "../services/conversation-target-drafts.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("TargetCreationDraft", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-target-draft-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(verrailConversationContextBindings);
    await db.delete(verrailTargetCreationDraftRevisions);
    await db.delete(verrailTargetCreationDrafts);
    await db.delete(verrailConversationMessages);
    await db.delete(verrailConversations);
    await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const workspace = await db.insert(companies).values({ name: "Drafts", issuePrefix: "DRF" }).returning().then((rows) => rows[0]!);
    const conversation = await db.insert(verrailConversations).values({ workspaceId: workspace.id, title: "Create delivery", createdByPrincipalType: "user", createdByPrincipalId: "user-1" }).returning().then((rows) => rows[0]!);
    const message = await db.insert(verrailConversationMessages).values({ workspaceId: workspace.id, conversationId: conversation.id, role: "user", body: "Create a Target", authorPrincipalType: "user", authorPrincipalId: "user-1" }).returning().then((rows) => rows[0]!);
    return { workspace, conversation, message };
  }

  it("persists immutable revisions and requires explicit human confirmation", async () => {
    const seeded = await seed();
    const service = targetCreationDraftService(db);
    const actor = { principalType: "user" as const, principalId: "user-1" };
    const collecting = await service.create(seeded.workspace.id, seeded.conversation.id, {
      sourceMessageId: seeded.message.id,
      initial: { title: "Governed delivery" },
      fieldSources: {},
    }, actor);
    expect(collecting.status).toBe("collecting");
    expect(collecting.activeRevision.missingFields).toEqual(expect.arrayContaining(["goal", "outcomeOwner", "acceptanceCriteria", "riskLevel"]));

    const ready = await service.update(seeded.workspace.id, seeded.conversation.id, collecting.id, {
      expectedRevisionNumber: 1,
      patch: {
        goal: "Deliver a native result.",
        outcomeOwner: { principalType: "user", principalId: "user-1" },
        acceptanceCriteria: [{ title: "Result is reviewable" }],
        riskLevel: "medium",
      },
      fieldSources: {},
    }, actor);
    expect(ready.status).toBe("ready_for_confirmation");
    expect(ready.activeRevisionNumber).toBe(2);
    expect(await db.select().from(verrailTargetCreationDraftRevisions)).toHaveLength(2);

    const prepared = await service.prepareConfirmation(seeded.workspace.id, seeded.conversation.id, ready.id, 2, actor);
    expect(prepared.draft.status).toBe("converting");
    expect(prepared.draft.conversionIdempotencyKey).toBe(`target-draft:${ready.id}:v2`);
    const retried = await service.prepareConfirmation(seeded.workspace.id, seeded.conversation.id, ready.id, 2, actor);
    expect(retried.draft.conversionIdempotencyKey).toBe(prepared.draft.conversionIdempotencyKey);

    await service.finalizeConfirmation({
      workspaceId: seeded.workspace.id,
      conversationId: seeded.conversation.id,
      draftId: ready.id,
      targetId: "5f6b02f9-b0b3-40b9-8f36-66a9d5eb4ff4",
      targetRevisionId: "3824d9b5-f950-4a31-8252-fd161227953b",
      title: "Governed delivery",
    });
    const convertedReplay = await service.prepareConfirmation(
      seeded.workspace.id,
      seeded.conversation.id,
      ready.id,
      2,
      actor,
    );
    expect(convertedReplay.replayed).toBe(true);
    expect(convertedReplay.draft.conversionIdempotencyKey).toBe(prepared.draft.conversionIdempotencyKey);
    await expect(service.prepareConfirmation(
      seeded.workspace.id,
      seeded.conversation.id,
      ready.id,
      2,
      { principalType: "user", principalId: "user-2" },
    )).rejects.toMatchObject({ status: 409 });
  });
});
