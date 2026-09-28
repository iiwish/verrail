import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { companies, verrailAgentDefinitions, verrailAgentVersions, verrailEvaluationRuns, verrailDeployments, verrailDeploymentRevisions, verrailConversations, verrailConversationMessages, verrailConversationInvocations, verrailConversationInvocationEvents } from "./schema/index.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("conversation invocation migration and constraints", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("verrail-chat-invocations-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const [workspace] = await db.insert(companies).values({ name: "Invocation test", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const owner = { createdByPrincipalType: "user", createdByPrincipalId: "owner" };
    const [definition] = await db.insert(verrailAgentDefinitions).values({ id: randomUUID(), workspaceId: workspace.id, name: "Director", ...owner }).returning();
    const [version] = await db.insert(verrailAgentVersions).values({ id: randomUUID(), workspaceId: workspace.id, agentDefinitionId: definition.id, versionNumber: 1, runtime: "opencode", model: "fixture/test", prompt: "Test", contentHash: "fixture", ...owner }).returning();
    const [evaluation] = await db.insert(verrailEvaluationRuns).values({ id: randomUUID(), workspaceId: workspace.id, candidateAgentVersionId: version.id, status: "inconclusive", safetyStatus: "not_run", ...owner }).returning();
    const [deployment] = await db.insert(verrailDeployments).values({ id: randomUUID(), workspaceId: workspace.id, agentDefinitionId: definition.id, name: "Director", ...owner }).returning();
    const [revision] = await db.insert(verrailDeploymentRevisions).values({ id: randomUUID(), workspaceId: workspace.id, deploymentId: deployment.id, revisionNumber: 1, agentVersionId: version.id, evaluationRunId: evaluation.id, state: "active", contentHash: "fixture", ...owner }).returning();
    const [conversation] = await db.insert(verrailConversations).values({ workspaceId: workspace.id, ...owner }).returning();
    const [message] = await db.insert(verrailConversationMessages).values({ workspaceId: workspace.id, conversationId: conversation.id, role: "user", body: "Hello" }).returning();
    const input = { workspaceId: workspace.id, conversationId: conversation.id, sourceMessageId: message.id, principalId: "owner", agentVersionId: version.id, deploymentRevisionId: revision.id, idempotencyKey: randomUUID(), requestHash: "fixture", input: {} };
    return { input, conversation, workspace };
  }

  it("prevents simultaneous active invocations, then allows a new turn after terminal completion", async () => {
    const { input } = await seed();
    const [first] = await db.insert(verrailConversationInvocations).values(input).returning();
    const [message] = await db.insert(verrailConversationMessages).values({ workspaceId: input.workspaceId, conversationId: input.conversationId, role: "user", body: "Next" }).returning();
    const next = { ...input, sourceMessageId: message.id, idempotencyKey: randomUUID() };
    await expect(db.insert(verrailConversationInvocations).values(next)).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(db.update(verrailConversationInvocations).set({ status: "succeeded" }).where(eq(verrailConversationInvocations.id, first.id))).rejects.toMatchObject({ cause: { code: "23514" } });
    await db.update(verrailConversationInvocations).set({ status: "succeeded", finishedAt: new Date() }).where(eq(verrailConversationInvocations.id, first.id));
    await db.insert(verrailConversationInvocations).values(next);
  });

  it("rejects cross-workspace/version bindings and duplicate event cursors", async () => {
    const { input } = await seed();
    const { input: foreign } = await seed();
    await expect(db.insert(verrailConversationInvocations).values({ ...input, agentVersionId: foreign.agentVersionId })).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(db.insert(verrailConversationInvocations).values({ ...input, sourceMessageId: foreign.sourceMessageId })).rejects.toMatchObject({ cause: { code: "23503" } });
    const [invocation] = await db.insert(verrailConversationInvocations).values(input).returning();
    const event = { workspaceId: input.workspaceId, invocationId: invocation.id, cursor: 1, type: "start", data: {} };
    await expect(db.insert(verrailConversationInvocationEvents).values({ ...event, workspaceId: foreign.workspaceId })).rejects.toMatchObject({ cause: { code: "23503" } });
    await db.insert(verrailConversationInvocationEvents).values(event);
    await expect(db.insert(verrailConversationInvocationEvents).values(event)).rejects.toMatchObject({ cause: { code: "23505" } });
  });
});
