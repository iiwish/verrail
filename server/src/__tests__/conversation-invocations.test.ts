import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, verrailAgentDefinitions, verrailAgentVersions, verrailEvaluationRuns, verrailDeployments, verrailDeploymentRevisions, verrailConversations, verrailConversationMessages } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { conversationInvocationService } from "../services/conversation-invocations.js";
import { createDirectorInvocationTokens, directorInvocationAuthorization } from "../services/director-invocation-auth.js";
import { createConversationInvocationController } from "../services/conversation-invocation-controller.js";
import { HttpError } from "../errors.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("durable conversation invocations", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("verrail-invocation-service-"); db = createDb(database.connectionString); }, 30000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const [workspace] = await db.insert(companies).values({ name: "Invocation", issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: workspace.id, principalType: "user", principalId: "owner", status: "active", membershipRole: "owner" });
    const owner = { createdByPrincipalType: "user", createdByPrincipalId: "owner" };
    const [definition] = await db.insert(verrailAgentDefinitions).values({ id: randomUUID(), workspaceId: workspace.id, name: "Director", ...owner }).returning();
    const [version] = await db.insert(verrailAgentVersions).values({ id: randomUUID(), workspaceId: workspace.id, agentDefinitionId: definition.id, versionNumber: 1, runtime: "opencode", model: "fixture/test", prompt: "Test", contentHash: "fixture", ...owner }).returning();
    const [evaluation] = await db.insert(verrailEvaluationRuns).values({ id: randomUUID(), workspaceId: workspace.id, candidateAgentVersionId: version.id, status: "inconclusive", safetyStatus: "not_run", ...owner }).returning();
    const [deployment] = await db.insert(verrailDeployments).values({ id: randomUUID(), workspaceId: workspace.id, agentDefinitionId: definition.id, name: "Director", ...owner }).returning();
    const [revision] = await db.insert(verrailDeploymentRevisions).values({ id: randomUUID(), workspaceId: workspace.id, deploymentId: deployment.id, revisionNumber: 1, agentVersionId: version.id, evaluationRunId: evaluation.id, state: "active", contentHash: "fixture", ...owner }).returning();
    const [conversation] = await db.insert(verrailConversations).values({ workspaceId: workspace.id, ...owner }).returning();
    const scope = { workspaceId: workspace.id, conversationId: conversation.id, principalId: "owner" };
    const snapshot = { agentVersionId: version.id, deploymentRevisionId: revision.id, assistantAgentId: definition.id, runtime: "opencode" as const, model: "fixture/test", systemPrompt: "Fixture rules" };
    return { scope, snapshot };
  }

  it("binds Director authorization to active persisted invocations and a durable call budget", async () => {
    const { scope, snapshot } = await seed();
    const service = conversationInvocationService(db);
    const { invocation } = await service.begin(scope, { body: "Hello", idempotencyKey: "director" }, snapshot);
    const tokens = createDirectorInvocationTokens("fixture-signing-key-01234567890123456789");
    const token = tokens.issue(invocation.id, scope.workspaceId);
    const authorize = directorInvocationAuthorization(db, tokens);
    expect((await authorize(token)).sourceMessageId).toBe(invocation.sourceMessageId);
    await expect(authorize(tokens.issue(invocation.id, randomUUID()))).rejects.toMatchObject({ status: 403 });
    await expect(authorize(token, "bash")).rejects.toMatchObject({ status: 403 });
    const attempts = await Promise.allSettled(Array.from({ length: 21 }, () => authorize(token, "list_targets")));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(20);
    await expect(directorInvocationAuthorization(db, tokens)(token, "get_target")).rejects.toMatchObject({ status: 403 });
    await service.cancel(scope, invocation.id);
    await expect(authorize(token)).rejects.toMatchObject({ status: 403 });
  });

  it("reconciles remote events into a persisted reply without duplicate dispatch", async () => {
    const { scope, snapshot } = await seed();
    const service = conversationInvocationService(db);
    const { invocation } = await service.begin(scope, { body: "Hello", idempotencyKey: "controller" }, snapshot);
    const events = [
      { cursor: 1, at: new Date().toISOString(), event: { type: "start" as const, data: {} } },
      { cursor: 2, at: new Date().toISOString(), event: { type: "chunk" as const, data: { text: "Reply" } } },
      { cursor: 3, at: new Date().toISOString(), event: { type: "done" as const, data: { status: "succeeded" as const } } },
    ];
    const gateway = {
      read: vi.fn().mockRejectedValueOnce(new HttpError(404, "not found")).mockResolvedValue({ invocationId: invocation.id, status: "succeeded", lastEventCursor: 3, events }),
      submit: vi.fn().mockResolvedValue({ invocationId: invocation.id, replayed: false }), cancel: vi.fn(),
    };
    const tokens = createDirectorInvocationTokens("fixture-signing-key-01234567890123456789");
    const controller = createConversationInvocationController(db, { gateway, tokens });
    await controller.reconcile(scope.workspaceId, invocation.id);
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    const submitted = gateway.submit.mock.calls[0][0];
    expect(submitted.agentVersionId).toBe(snapshot.agentVersionId);
    expect(tokens.verify(submitted.directorToken).invocationId).toBe(invocation.id);
    await controller.reconcile(scope.workspaceId, invocation.id);
    await controller.reconcile(scope.workspaceId, invocation.id);
    expect((await service.read(scope, invocation.id)).invocation).toMatchObject({ status: "succeeded", output: "Reply" });
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    await controller.close();
  });

  it("does not redispatch an unconfirmed request after a transport failure", async () => {
    const { scope, snapshot } = await seed();
    const service = conversationInvocationService(db);
    const { invocation } = await service.begin(scope, { body: "Hello", idempotencyKey: "ambiguous" }, snapshot);
    const gateway = { read: vi.fn().mockRejectedValue(new HttpError(404, "not found")), submit: vi.fn().mockRejectedValue(new Error("connection lost")), cancel: vi.fn() };
    const tokens = createDirectorInvocationTokens("fixture-signing-key-01234567890123456789");
    const controller = createConversationInvocationController(db, { gateway, tokens });
    await expect(controller.reconcile(scope.workspaceId, invocation.id)).rejects.toThrow("connection lost");
    await controller.reconcile(scope.workspaceId, invocation.id);
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    expect((await service.read(scope, invocation.id)).invocation).toMatchObject({ status: "failed", errorCode: "DISPATCH_UNCONFIRMED" });
    await controller.close();
  });

  it("commits one source message for concurrent duplicate submits and persists one final reply", async () => {
    const { scope, snapshot } = await seed();
    const service = conversationInvocationService(db);
    const request = { body: "Hello", idempotencyKey: "turn-1" };
    const results = await Promise.all([service.begin(scope, request, snapshot), service.begin(scope, request, snapshot)]);
    expect(results.filter(result => result.replayed)).toHaveLength(1);
    const id = results[0].invocation.id;
    expect(results[1].invocation.id).toBe(id);
    await expect(service.begin(scope, { ...request, body: "Different" }, snapshot)).rejects.toMatchObject({ status: 409 });
    await expect(service.begin(scope, { ...request, idempotencyKey: "another" }, snapshot)).rejects.toMatchObject({ status: 409 });
    const claimed = await service.claim(scope.workspaceId, id, "controller");
    const lease = { workspaceId: scope.workspaceId, invocationId: id, controllerId: "controller", fencingToken: claimed.fencingToken };
    await service.append(lease, 1, { type: "start", data: {} });
    await service.append(lease, 2, { type: "chunk", data: { text: "Reply" } });
    const done = { type: "done", data: { status: "succeeded" } };
    await service.append(lease, 3, done);
    await service.append(lease, 3, done);
    await expect(service.append(lease, 3, { type: "error", data: { errorCode: "FORGED" } })).rejects.toMatchObject({ status: 409 });
    const messages = await db.select().from(verrailConversationMessages).where(eq(verrailConversationMessages.conversationId, scope.conversationId));
    expect(messages.map(message => message.role)).toEqual(["user", "assistant"]);
    const restored = await conversationInvocationService(db).read(scope, id, 1);
    expect(restored.invocation.status).toBe("succeeded");
    expect(restored.events.map(event => event.cursor)).toEqual([2, 3]);
  });

  it("fences expired controllers and requires acknowledgement after cancellation", async () => {
    const { scope, snapshot } = await seed();
    let clock = new Date();
    const service = conversationInvocationService(db, () => clock);
    const { invocation } = await service.begin(scope, { body: "Hello", idempotencyKey: "one" }, snapshot);
    const first = await service.claim(scope.workspaceId, invocation.id, "old");
    const old = { workspaceId: scope.workspaceId, invocationId: invocation.id, controllerId: "old", fencingToken: first.fencingToken };
    await expect(service.append(old, 2, { type: "start", data: {} })).rejects.toMatchObject({ status: 409 });
    await expect(service.claim(scope.workspaceId, invocation.id, "new")).rejects.toMatchObject({ status: 409 });
    clock = new Date(clock.getTime() + 31000);
    const second = await service.claim(scope.workspaceId, invocation.id, "new");
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    await expect(service.append(old, 1, { type: "start", data: {} })).rejects.toMatchObject({ status: 409 });
    const current = { ...old, controllerId: "new", fencingToken: second.fencingToken };
    await service.cancel(scope, invocation.id);
    expect((await service.read(scope, invocation.id)).invocation).toMatchObject({ status: "cancel_requested", finishedAt: null });
    await service.append(current, 1, { type: "start", data: {} });
    expect((await service.read(scope, invocation.id)).invocation.status).toBe("cancel_requested");
    await service.append(current, 2, { type: "done", data: { status: "canceled" } });
    expect((await service.read(scope, invocation.id)).invocation.finishedAt).not.toBeNull();
  });

  it("rejects revoked members and foreign conversations even for replay", async () => {
    const { scope, snapshot } = await seed();
    const service = conversationInvocationService(db);
    const input = { body: "Hello", idempotencyKey: "one" };
    const { invocation } = await service.begin(scope, input, snapshot);
    await expect(service.read({ ...scope, conversationId: randomUUID() }, invocation.id)).rejects.toMatchObject({ status: 404 });
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, scope.workspaceId), eq(companyMemberships.principalId, "owner")));
    await expect(service.begin(scope, input, snapshot)).rejects.toMatchObject({ status: 403 });
    await expect(service.read(scope, invocation.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.cancel(scope, invocation.id)).rejects.toMatchObject({ status: 403 });
  });
});
