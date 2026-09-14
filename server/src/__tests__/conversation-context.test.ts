import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, companies, companyMemberships, createDb, verrailConversations, verrailConversationContextChanges, verrailTargets, verrailTargetRevisions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { conversationService } from "../services/conversations.js";
import { conversationContextService } from "../services/conversation-context.js";
import { targetCreationDraftService } from "../services/conversation-target-drafts.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("versioned conversation focus", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("verrail-context-"); db = createDb(database.connectionString); }, 30000);
  afterEach(async () => { await db.delete(activityLog); await db.delete(verrailConversations); await db.delete(verrailTargets); await db.delete(companyMemberships); await db.delete(companies); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function seed() {
    const [workspace, other] = await db.insert(companies).values([{ name: "Context", issuePrefix: "CTX" }, { name: "Other", issuePrefix: "OTH" }]).returning();
    await db.insert(companyMemberships).values({ companyId: workspace!.id, principalType: "user", principalId: "owner", membershipRole: "owner" });
    const makeTarget = async (workspaceId: string, title: string) => {
      const id = randomUUID(), revision = randomUUID();
      await db.insert(verrailTargets).values({ id, workspaceId, activeTargetRevisionId: revision, createdByPrincipalType: "user", createdByPrincipalId: "owner" });
      await db.insert(verrailTargetRevisions).values({ id: revision, workspaceId, targetId: id, revisionNumber: 1, title, outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "owner", goal: title, constraints: [], acceptanceCriteria: [], riskLevel: "low", contentHash: "test", createdByPrincipalType: "user", createdByPrincipalId: "owner" });
      return id;
    };
    const a = await makeTarget(workspace!.id, "A"), b = await makeTarget(workspace!.id, "B"), foreign = await makeTarget(other!.id, "Foreign");
    const conversations = conversationService(db);
    const conversation = await conversations.create(workspace!.id, { contextBindings: [] }, { principalType: "user", principalId: "owner" });
    const scope = { workspaceId: workspace!.id, conversationId: conversation.id, principalId: "owner" };
    return { a, b, foreign, scope, conversations, switcher: conversationContextService(db) };
  }
  it("switches, clears and replays without retargeting historical messages or proposals", async () => {
    const { a, b, scope, conversations, switcher } = await seed();
    const input = { targetId: a, expectedContextVersion: 0, idempotencyKey: "a" };
    expect(await switcher.switch(scope, input)).toMatchObject({ currentTargetId: a, contextVersion: 1 });
    const message = await conversations.appendMessage(scope.workspaceId, scope.conversationId, { role: "user", body: "Change its title", actor: { principalType: "user", principalId: "owner" } });
    await conversations.appendMessage(scope.workspaceId, scope.conversationId, { role: "tool", body: "proposal", metadata: { kind: "director_target_proposal", targetId: a, input: { operation: "archive" } } });
    await switcher.switch(scope, { targetId: b, expectedContextVersion: 1, idempotencyKey: "b" });
    expect(await switcher.switch(scope, input)).toMatchObject({ currentTargetId: a, contextVersion: 1, replayed: true });
    const detail = await conversations.get(scope.workspaceId, scope.conversationId);
    expect(detail).toMatchObject({ currentTargetId: b, contextVersion: 2 });
    expect(detail!.messages.find(row => row.id === message!.id)?.metadata?.conversationContext).toEqual({ currentTargetId: a, contextVersion: 1 });
    expect(detail!.messages.find(row => row.body === "proposal")?.metadata?.targetId).toBe(a);
    expect(detail!.contextBindings.filter(row => row.contextType === "target")).toHaveLength(2);
    await expect(switcher.switch(scope, { targetId: null, expectedContextVersion: 1, idempotencyKey: "stale" })).rejects.toMatchObject({ status: 409 });
    await switcher.switch(scope, { targetId: null, expectedContextVersion: 2, idempotencyKey: "clear" });
    expect((await conversations.get(scope.workspaceId, scope.conversationId))?.currentTargetId).toBeNull();
    expect(await conversations.list(scope.workspaceId, { status: "active", targetId: a })).toHaveLength(1);
    expect(await db.select().from(verrailConversationContextChanges)).toHaveLength(3);
    expect(await db.select().from(activityLog)).toHaveLength(3);
  });
  it("rejects cross-workspace targets, revoked/viewer identities and archived conversations", async () => {
    const { a, foreign, scope, switcher, conversations } = await seed();
    const input = { targetId: a, expectedContextVersion: 0, idempotencyKey: "a" };
    await expect(switcher.switch(scope, { ...input, targetId: foreign })).rejects.toMatchObject({ status: 404 });
    await db.update(companyMemberships).set({ membershipRole: "viewer" });
    await expect(switcher.switch(scope, input)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ membershipRole: "owner" });
    await switcher.switch(scope, input);
    await db.update(companyMemberships).set({ status: "inactive" });
    await expect(switcher.switch(scope, input)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ status: "active" });
    await conversations.update(scope.workspaceId, scope.conversationId, { status: "archived" });
    await expect(switcher.switch(scope, { targetId: null, expectedContextVersion: 1, idempotencyKey: "clear" })).rejects.toMatchObject({ status: 409 });
  });
  it("serializes competing switches and detects idempotency key misuse", async () => {
    const { a, b, scope, switcher } = await seed();
    const results = await Promise.allSettled([switcher.switch(scope, { targetId: a, expectedContextVersion: 0, idempotencyKey: "one" }), switcher.switch(scope, { targetId: b, expectedContextVersion: 0, idempotencyKey: "two" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    await expect(switcher.switch(scope, { targetId: null, expectedContextVersion: 0, idempotencyKey: winner === 0 ? "one" : "two" })).rejects.toMatchObject({ status: 409 });
  });
  it("links without changing focus, unlinks atomically and preserves history and targets", async () => {
    const { a, b, scope, switcher, conversations } = await seed();
    await switcher.switch(scope, { targetId: a, expectedContextVersion: 0, idempotencyKey: "focus" });
    const message = await conversations.appendMessage(scope.workspaceId, scope.conversationId, { role: "user", body: "For A", actor: { principalType: "user", principalId: "owner" } });
    const link = { operation: "link" as const, targetId: b, expectedContextVersion: 1, idempotencyKey: "link" };
    expect(await switcher.switch(scope, link)).toMatchObject({ currentTargetId: a, contextVersion: 2 });
    expect(await conversations.list(scope.workspaceId, { status: "active", targetId: b })).toHaveLength(1);
    await expect(switcher.switch(scope, { operation: "unlink", targetId: a, expectedContextVersion: 1, idempotencyKey: "stale" })).rejects.toMatchObject({ status: 409 });
    const unlink = { operation: "unlink" as const, targetId: a, expectedContextVersion: 2, idempotencyKey: "unlink" };
    expect(await switcher.switch(scope, unlink)).toMatchObject({ currentTargetId: null, contextVersion: 3 });
    expect(await switcher.switch(scope, unlink)).toMatchObject({ replayed: true });
    const detail = await conversations.get(scope.workspaceId, scope.conversationId);
    expect(detail!.contextBindings.map(row => row.contextId)).toEqual([b]);
    expect(detail!.messages.find(row => row.id === message!.id)?.metadata?.conversationContext).toEqual({ currentTargetId: a, contextVersion: 1 });
    expect(await conversations.list(scope.workspaceId, { status: "active", targetId: a })).toHaveLength(0);
    await conversations.appendMessage(scope.workspaceId, scope.conversationId, { role: "tool", body: "Late proposal for A", metadata: { kind: "director_target_proposal", targetId: a, sourceMessageId: message!.id } });
    expect(await conversations.list(scope.workspaceId, { status: "active", targetId: a })).toHaveLength(0);
    await conversations.update(scope.workspaceId, scope.conversationId, { status: "archived" });
    expect(await conversations.list(scope.workspaceId, { status: "archived", targetId: b })).toHaveLength(1);
    expect(await db.select().from(verrailTargets).where(eq(verrailTargets.workspaceId, scope.workspaceId))).toHaveLength(2);
  });
  it.each(["link", "unlink"] as const)("enforces scope, membership and archive boundaries for %s", async (operation) => {
    const { a, foreign, scope, switcher, conversations } = await seed();
    const input = { operation, targetId: a, expectedContextVersion: 0, idempotencyKey: "relation" };
    await expect(switcher.switch(scope, { ...input, targetId: foreign })).rejects.toMatchObject({ status: 404 });
    await expect(switcher.switch({ ...scope, principalId: "stranger" }, input)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ membershipRole: "viewer" });
    await expect(switcher.switch(scope, input)).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ membershipRole: "owner" });
    await conversations.update(scope.workspaceId, scope.conversationId, { status: "archived" });
    await expect(switcher.switch(scope, input)).rejects.toMatchObject({ status: 409 });
  });
  it("serializes linking against switching and rejects operation reuse of a receipt", async () => {
    const { a, b, scope, switcher } = await seed();
    const input = { operation: "link" as const, targetId: a, expectedContextVersion: 0, idempotencyKey: "link" };
    await switcher.switch(scope, input);
    await expect(switcher.switch(scope, { ...input, operation: "unlink" })).rejects.toMatchObject({ status: 409 });
    const results = await Promise.allSettled([
      switcher.switch(scope, { targetId: b, expectedContextVersion: 1, idempotencyKey: "switch" }),
      switcher.switch(scope, { operation: "unlink", targetId: a, expectedContextVersion: 1, idempotencyKey: "unlink" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("focuses target-origin conversations without inferring old bindings", async () => {
    const { a, scope, conversations } = await seed();
    const input = { contextBindings: [{ contextType: "target" as const, contextId: a }] };
    const legacy = await conversations.create(scope.workspaceId, input, { principalType: "user", principalId: "owner" }, { trustedContext: true });
    expect(legacy.currentTargetId).toBeNull();
    const focused = await conversations.create(scope.workspaceId, input, { principalType: "user", principalId: "owner" }, { trustedContext: true, initialTargetId: a });
    expect(focused).toMatchObject({ currentTargetId: a, contextVersion: 1, currentTarget: { title: "A" } });
  });
  it.each([false, true])("creation focus preserves concurrent context changes: %s", async (concurrent) => {
    const { a, b, scope, switcher, conversations } = await seed();
    const source = await conversations.appendMessage(scope.workspaceId, scope.conversationId, { role: "user", body: "Create Target", actor: { principalType: "user", principalId: "owner" } });
    const drafts = targetCreationDraftService(db);
    const draft = await drafts.create(scope.workspaceId, scope.conversationId, { sourceMessageId: source!.id, initial: { title: "A", goal: "Goal", outcomeOwner: { principalType: "user", principalId: "owner" }, acceptanceCriteria: [{ title: "Proof" }], riskLevel: "low" }, fieldSources: {} }, { principalType: "user", principalId: "owner" });
    await drafts.prepareConfirmation(scope.workspaceId, scope.conversationId, draft.id, 1, { principalType: "user", principalId: "owner" });
    if (concurrent) { await switcher.switch(scope, { targetId: b, expectedContextVersion: 0, idempotencyKey: "b" }); await switcher.switch(scope, { targetId: null, expectedContextVersion: 1, idempotencyKey: "clear" }); }
    const [target] = await db.select().from(verrailTargets).where(and(eq(verrailTargets.workspaceId, scope.workspaceId), eq(verrailTargets.id, a)));
    const input = { workspaceId: scope.workspaceId, conversationId: scope.conversationId, draftId: draft.id, targetId: a, targetRevisionId: target!.activeTargetRevisionId, title: "A" };
    await drafts.finalizeConfirmation(input);
    expect(await conversations.list(scope.workspaceId, { status: "active", targetId: a })).toEqual(expect.arrayContaining([expect.objectContaining({ id: scope.conversationId, targetRelation: "source" })]));
    expect((await conversations.get(scope.workspaceId, scope.conversationId))?.currentTargetId).toBe(concurrent ? null : a);
    if (!concurrent) await switcher.switch(scope, { targetId: b, expectedContextVersion: 1, idempotencyKey: "b" });
    await drafts.finalizeConfirmation(input);
    expect((await conversations.get(scope.workspaceId, scope.conversationId))?.currentTargetId).toBe(concurrent ? null : b);
  });
});
