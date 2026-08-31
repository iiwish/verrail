import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  verrailConversations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { conversationService } from "../services/conversations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres conversation service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("conversationService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-conversation-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(verrailConversations);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps conversations workspace-scoped and persists a complete turn", async () => {
    const [workspace, otherWorkspace] = await db
      .insert(companies)
      .values([
        { name: "Conversation Workspace", issuePrefix: "CVR" },
        { name: "Other Workspace", issuePrefix: "OTH" },
      ])
      .returning();
    const service = conversationService(db);

    const created = await service.create(
      workspace!.id,
      {
        title: "Delivery decision",
        contextBindings: [{
          contextType: "target",
          contextId: "target-1",
          label: "Ship the release",
          href: "/targets/target-1/overview",
        }],
      },
      { principalType: "user", principalId: "user-1" },
    );

    expect(created).toMatchObject({
      workspaceId: workspace!.id,
      title: "Delivery decision",
      status: "active",
      contextBindings: [{ contextType: "target", contextId: "target-1" }],
      messages: [],
    });
    expect(await service.list(otherWorkspace!.id, { status: "active" })).toEqual([]);
    expect(await service.get(otherWorkspace!.id, created.id)).toBeNull();

    await service.appendMessage(workspace!.id, created.id, {
      role: "user",
      body: "What blocks acceptance?",
      actor: { principalType: "user", principalId: "user-1" },
    });
    await service.appendMessage(workspace!.id, created.id, {
      role: "assistant",
      body: "The evidence set is incomplete.",
    });

    const detail = await service.get(workspace!.id, created.id);
    expect(detail?.messages.map((message) => [message.role, message.body])).toEqual([
      ["user", "What blocks acceptance?"],
      ["assistant", "The evidence set is incomplete."],
    ]);
    expect(detail?.lastMessageAt).toBeInstanceOf(Date);
  });

  it("derives a first-turn title and requires archived conversations to be restored", async () => {
    const [workspace] = await db
      .insert(companies)
      .values({ name: "Lifecycle Workspace", issuePrefix: "LCW" })
      .returning();
    const service = conversationService(db);
    const created = await service.create(
      workspace!.id,
      { contextBindings: [] },
      { principalType: "user", principalId: "user-1" },
    );

    await service.appendMessage(workspace!.id, created.id, {
      role: "user",
      body: "Plan the next governed delivery milestone",
      actor: { principalType: "user", principalId: "user-1" },
    });
    const titled = await service.get(workspace!.id, created.id);
    expect(titled?.title).toBe("Plan the next governed delivery milestone");

    await service.update(workspace!.id, created.id, { pinned: true, status: "archived" });
    await expect(service.appendMessage(workspace!.id, created.id, {
      role: "user",
      body: "This must not be appended",
      actor: { principalType: "user", principalId: "user-1" },
    })).rejects.toMatchObject({
      status: 409,
      details: { code: "CONVERSATION_ARCHIVED" },
    });

    expect(await service.list(workspace!.id, { status: "active" })).toEqual([]);
    expect(await service.list(workspace!.id, { status: "archived" })).toEqual([
      expect.objectContaining({ id: created.id, pinnedAt: expect.any(Date) }),
    ]);

    await service.update(workspace!.id, created.id, { status: "active" });
    await expect(service.appendMessage(workspace!.id, created.id, {
      role: "user",
      body: "Continue after restore",
      actor: { principalType: "user", principalId: "user-1" },
    })).resolves.toMatchObject({ body: "Continue after restore" });
  });
});
