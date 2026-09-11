import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, companyMemberships, verrailConversations, verrailConversationMessages, verrailProviderConversationBindings,
  verrailTargetCreationDrafts, verrailTargetCreationDraftRevisions, verrailTargets, verrailTargetRevisions, verrailCommandReceipts,
  verrailAuditEvents, verrailChannelEvents, verrailChannelTargetReplies } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { channelTargetReplyService } from "./channel-target-reply.js";
import { conversationRoutes } from "../routes/conversations.js";
import { deliveryContextRoutes } from "../routes/delivery-context.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("confirmed Target reply application integration (synthetic Provider)", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("verrail-created-reply-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const workspaceId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), draftId = randomUUID();
    const draftRevisionId = randomUUID(), targetId = randomUUID(), targetRevisionId = randomUUID(), channelEventId = randomUUID(), pluginId = randomUUID();
    const actor = "local-human", hash = "a".repeat(64), at = new Date(), key = `target-draft:${draftId}:v1`;
    const author = { createdByPrincipalType: "user", createdByPrincipalId: actor };
    const definition = { collectionId: null, title: "Private title", summary: null, outcomeOwner: { principalType: "user" as const, principalId: actor },
      goal: "Private goal", constraints: [], acceptanceCriteria: [{ title: "Done" }], riskLevel: "low" as const, deadline: null, policySummary: null, resourceRefs: [] };
    await db.insert(companies).values({ id: workspaceId, name: "Synthetic reply", issuePrefix: `RP${workspaceId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId: workspaceId, principalType: "user", principalId: actor, status: "active", membershipRole: "owner" });
    await db.insert(verrailConversations).values({ id: conversationId, workspaceId, ...author });
    await db.insert(verrailConversationMessages).values({ id: messageId, workspaceId, conversationId, role: "user", body: "Private source",
      authorPrincipalType: "user", authorPrincipalId: actor, metadata: { channelConnector: "feishu", providerEventId: "evt", providerMessageId: "om_source" } });
    await db.insert(verrailProviderConversationBindings).values({ workspaceId, conversationId, providerKey: "feishu", connectionId: "connection",
      externalConversationType: "direct", externalConversationId: "chat", ...author });
    await db.insert(verrailTargetCreationDrafts).values({ id: draftId, workspaceId, conversationId, sourceMessageId: messageId, initiatedByPrincipalType: "user",
      initiatedByPrincipalId: actor, status: "converted", activeRevisionId: draftRevisionId, activeRevisionNumber: 1,
      convertedTargetId: targetId, convertedTargetRevisionId: targetRevisionId, confirmedByPrincipalType: "user", confirmedByPrincipalId: actor, confirmedAt: at, conversionIdempotencyKey: key });
    await db.insert(verrailTargetCreationDraftRevisions).values({ id: draftRevisionId, workspaceId, draftId, revisionNumber: 1, definition, missingFields: [], contentHash: hash, ...author });
    await db.insert(verrailTargets).values({ id: targetId, workspaceId, activeTargetRevisionId: targetRevisionId, createdAt: at, ...author });
    await db.insert(verrailTargetRevisions).values({ id: targetRevisionId, workspaceId, targetId, revisionNumber: 1, title: definition.title,
      goal: definition.goal, outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: actor, constraints: [],
      acceptanceCriteria: [{ id: randomUUID(), title: "Done", description: null }], riskLevel: "low", contentHash: hash, createdAt: at, ...author });
    const result = { schemaVersion: 1, targetId, targetRevisionId, workGraphId: randomUUID(), graphRevisionId: randomUUID(), workbenchHref: `/targets/${targetId}/overview`, replayed: false };
    await db.insert(verrailCommandReceipts).values({ id: randomUUID(), workspaceId, principalType: "user", principalId: actor, commandType: "target.create.v1", idempotencyKey: key,
      requestHash: hash, targetId, targetRevisionId, response: result, createdAt: at });
    await db.insert(verrailAuditEvents).values({ id: randomUUID(), workspaceId, principalType: "user", principalId: actor, aggregateType: "target", aggregateId: targetId,
      eventType: "target.created", idempotencyKey: key, occurredAt: at, payload: { schemaVersion: 1, targetId, targetRevisionId, workGraphId: result.workGraphId, graphRevisionId: result.graphRevisionId, requestHash: hash } });
    await db.insert(verrailChannelEvents).values({ id: channelEventId, workspaceId, connectorKey: "feishu", connectionId: "connection", providerEventId: "evt",
      providerUserId: "provider-human", externalConversationType: "direct", externalConversationId: "chat", conversationId, messageId, draftId, receivedAt: at });
    const configuration = { channelConnections: [{ contractVersion: 1, connectorKey: "feishu", connectionId: "connection",
      authorizedUsers: [{ providerUserId: "provider-human", userId: actor }], appSecretRef: "SECRET_REF_NOT_FOR_OUTPUT" }] };
    const registry = { list: vi.fn().mockResolvedValue([{ id: pluginId, status: "ready", manifestJson: { channelConnectors: [{ contractVersion: 1, connectorKey: "feishu" }] } }]),
      getConfig: vi.fn().mockResolvedValue({ configJson: configuration }) };
    const call = vi.fn().mockResolvedValue({ contractVersion: 1, providerMessageId: "om_created" });
    const input = { workspaceId, conversationId, draftId, principalId: actor };
    const service = channelTargetReplyService(db, { workerManager: { call } as never, registry: registry as never, publicBaseUrl: "https://verrail.example" });
    return { input, service, call, registry, targetId, targetRevisionId, channelEventId, draftRevisionId, configuration, result };
  }

  it.each(["succeeded", "unknown"])("integrates HTTP first confirmation, replay, database finalization and reply readback: %s", async status => {
    const s = await seed();
    if (status === "unknown") s.call.mockRejectedValue(new Error("Synthetic timeout"));
    await db.update(verrailTargetCreationDrafts).set({ status: "ready_for_confirmation", confirmedByPrincipalType: null,
      confirmedByPrincipalId: null, confirmedAt: null, conversionIdempotencyKey: null, convertedTargetId: null, convertedTargetRevisionId: null })
      .where(eq(verrailTargetCreationDrafts.id, s.input.draftId));
    let created = false;
    // The native Domain API is simulated; TypeScript confirmation, finalization,
    // notification and readback use the real services and temporary database.
    const createTarget = vi.fn().mockImplementation(async () => {
      if (created) return { ...s.result, replayed: true };
      const [prepared] = await db.select().from(verrailTargetCreationDrafts).where(eq(verrailTargetCreationDrafts.id, s.input.draftId));
      expect(prepared?.status).toBe("converting");
      const at = new Date();
      await db.update(verrailTargets).set({ createdAt: at }).where(eq(verrailTargets.id, s.targetId));
      await db.update(verrailCommandReceipts).set({ createdAt: at }).where(eq(verrailCommandReceipts.targetId, s.targetId));
      await db.update(verrailAuditEvents).set({ occurredAt: at }).where(eq(verrailAuditEvents.aggregateId, s.targetId));
      created = true;
      return s.result;
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: s.input.principalId, companyIds: [s.input.workspaceId] } as never;
      next();
    });
    app.use(conversationRoutes(db, { deploymentMode: "authenticated", domainApiClient: { createTarget } as never, targetReplies: s.service }));
    app.use(deliveryContextRoutes(db));
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: "request_failed" }));
    const base = `/workspaces/${s.input.workspaceId}/conversations/${s.input.conversationId}/target-drafts/${s.input.draftId}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app).post(`${base}/confirm`).send({ expectedRevisionNumber: 1 });
      expect(response.status).toBe(attempt === 0 ? 201 : 200);
      expect(response.body.target.targetId).toBe(s.targetId);
      expect(response.body.draft.status).toBe("converted");
      expect(response.body.channelReply.status).toBe(status);
    }
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(createTarget.mock.calls[0]![0].idempotencyKey).toBe(createTarget.mock.calls[1]![0].idempotencyKey);
    const readback = await request(app).get(`${base}/channel-reply`);
    expect(readback.status).toBe(200);
    expect(readback.headers["cache-control"]).toBe("no-store");
    expect(readback.body).toEqual(await s.service.read(s.input));
    expect(JSON.stringify(readback.body)).not.toMatch(/om_created|SECRET|Private/);
    const context = await request(app).get(`/workspaces/${s.input.workspaceId}/delivery-context/channel`).query({
      channelEventId: s.channelEventId, draftRevisionId: s.draftRevisionId, createdTargetId: s.targetId, createdTargetRevisionId: s.targetRevisionId,
    });
    expect(context.status).toBe(200);
    expect(context.body.assurance).toBe("database_context_only");
    expect(context.body.unverified).toContain("target_creation_reply");
    expect((await request(app).get(base.replace(s.input.workspaceId, randomUUID()) + "/channel-reply")).status).toBe(403);
    expect((await request(app).post(`${base}/confirm`).send({ expectedRevisionNumber: 2 })).status).toBe(409);
    expect(createTarget).toHaveBeenCalledTimes(2);
    expect(s.call).toHaveBeenCalledTimes(1);
  });

  it("sends the confirmed Target reference exactly once across concurrent confirmations", async () => {
    const s = await seed();
    const results = await Promise.all([s.service.deliver(s.input), s.service.deliver(s.input)]);
    expect(results.some(r => r.status === "succeeded")).toBe(true);
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(s.call).toHaveBeenCalledWith(expect.any(String), "handleChannelReply", expect.objectContaining({
      replyContext: { providerMessageId: "om_source" }, idempotencyKey: `vtc:${s.input.draftId}`,
      text: expect.stringContaining(`https://verrail.example/targets/${s.targetId}/overview`),
    }), 10_000);
    expect((await s.service.deliver(s.input)).status).toBe("succeeded");
    expect(s.call).toHaveBeenCalledTimes(1);
    const [receipt] = await db.select().from(verrailChannelTargetReplies).where(eq(verrailChannelTargetReplies.draftId, s.input.draftId));
    expect(receipt).toMatchObject({ targetId: s.targetId, targetRevisionId: s.targetRevisionId, status: "succeeded", providerMessageId: "om_created" });
    expect(JSON.stringify(results)).not.toMatch(/om_created|SECRET|Private title/);
  });

  it("retains uncertain delivery without retrying or undoing Target creation", async () => {
    const s = await seed(); s.call.mockRejectedValue(new Error("SECRET raw Provider error"));
    const result = await s.service.deliver(s.input);
    expect(result.status).toBe("unknown");
    expect((await s.service.deliver(s.input)).status).toBe("unknown");
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(await s.service.read(s.input)).toEqual(result);
    expect(await s.service.read({ ...s.input, conversationId: randomUUID() })).toEqual({ status: "blocked", receiptId: null });
    expect(await s.service.read({ ...s.input, workspaceId: randomUUID() })).toEqual({ status: "blocked", receiptId: null });
    expect(s.call).toHaveBeenCalledTimes(1);
    const [draft] = await db.select().from(verrailTargetCreationDrafts).where(eq(verrailTargetCreationDrafts.id, s.input.draftId));
    expect(draft?.status).toBe("converted");
  });

  it("reconciles an unknown reply through Provider readback and never resends", async () => {
    const s = await seed(); s.call.mockRejectedValueOnce(new Error("Synthetic timeout"));
    const pending = await s.service.deliver(s.input);
    const [receipt] = await db.select().from(verrailChannelTargetReplies).where(eq(verrailChannelTargetReplies.id, pending.receiptId!));
    s.call.mockResolvedValue({ contractVersion: 1, providerMessageId: "om_created", parentProviderMessageId: "om_source",
      externalConversationId: "chat", bodySha256: receipt!.bodySha256, createdAt: receipt!.startedAt.toISOString() });
    const result = await s.service.reconcile({ ...s.input, providerMessageId: "om_created" });
    expect(result).toEqual({ status: "succeeded", receiptId: pending.receiptId });
    expect(s.call).toHaveBeenLastCalledWith(expect.any(String), "handleChannelReplyRead", expect.objectContaining({ providerMessageId: "om_created" }), 10_000);
    expect(await s.service.reconcile({ ...s.input, providerMessageId: "om_created" })).toEqual(result);
    expect(s.call).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/om_created|Private|SECRET/);
  });

  it.each(["body", "parent", "conversation", "time", "message", "config", "actor", "membership", "missing-reader", "changed-during-read", "membership-during-read"])("keeps unknown delivery when reconciliation is unsafe: %s", async change => {
    const s = await seed(); s.call.mockRejectedValueOnce(new Error("Synthetic timeout"));
    const pending = await s.service.deliver(s.input);
    const [receipt] = await db.select().from(verrailChannelTargetReplies).where(eq(verrailChannelTargetReplies.id, pending.receiptId!));
    const observation = { contractVersion: 1, providerMessageId: "om_created", parentProviderMessageId: "om_source",
      externalConversationId: "chat", bodySha256: receipt!.bodySha256, createdAt: receipt!.startedAt.toISOString() };
    if (change === "body") observation.bodySha256 = "e".repeat(64);
    if (change === "parent") observation.parentProviderMessageId = "other";
    if (change === "conversation") observation.externalConversationId = "other";
    if (change === "message") observation.providerMessageId = "other";
    if (change === "time") observation.createdAt = new Date(receipt!.startedAt.getTime() - 60000).toISOString();
    if (change === "config") s.configuration.channelConnections[0]!.appSecretRef = "different";
    if (change === "actor") s.input.principalId = "other";
    if (change === "membership") await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, s.input.workspaceId));
    s.call.mockImplementation(async () => {
      if (change === "missing-reader") throw new Error("METHOD_NOT_IMPLEMENTED");
      if (change === "changed-during-read") s.configuration.channelConnections[0]!.appSecretRef = "changed";
      if (change === "membership-during-read") await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, s.input.workspaceId));
      return observation;
    });
    expect((await s.service.reconcile({ ...s.input, providerMessageId: "om_created" })).status).not.toBe("succeeded");
    const [after] = await db.select().from(verrailChannelTargetReplies).where(eq(verrailChannelTargetReplies.id, pending.receiptId!));
    expect(after!.status).toBe("unknown");
    expect(s.call.mock.calls.filter(call => call[1] === "handleChannelReply")).toHaveLength(1);
  });

  it("exposes authorized reconciliation through HTTP with closed input and no Provider IDs in its response", async () => {
    const s = await seed(); s.call.mockRejectedValueOnce(new Error("Synthetic timeout"));
    const pending = await s.service.deliver(s.input);
    const [receipt] = await db.select().from(verrailChannelTargetReplies).where(eq(verrailChannelTargetReplies.id, pending.receiptId!));
    s.call.mockResolvedValue({ contractVersion: 1, providerMessageId: "om_created", parentProviderMessageId: "om_source",
      externalConversationId: "chat", bodySha256: receipt!.bodySha256, createdAt: receipt!.startedAt.toISOString() });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId: s.input.principalId, companyIds: [s.input.workspaceId] } as never; next(); });
    app.use(conversationRoutes(db, { deploymentMode: "authenticated", targetReplies: s.service }));
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: "request_failed" }));
    const url = `/workspaces/${s.input.workspaceId}/conversations/${s.input.conversationId}/target-drafts/${s.input.draftId}/channel-reply/reconcile`;
    expect((await request(app).post(url).send({ providerMessageId: "om_created", verified: true })).status).toBe(400);
    expect((await request(app).post(url.replace(s.input.workspaceId, randomUUID())).send({ providerMessageId: "om_created" })).status).toBe(403);
    const response = await request(app).post(url).send({ providerMessageId: "om_created" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "succeeded", receiptId: receipt!.id });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(s.call).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response.body)).not.toMatch(/om_created|SECRET|Private/);
  });

  it("waits for an active sender but can reconcile a stale sending reservation without resending", async () => {
    const s = await seed(); s.call.mockRejectedValueOnce(new Error("Synthetic timeout"));
    const pending = await s.service.deliver(s.input);
    await db.update(verrailChannelTargetReplies).set({ status: "sending", completedAt: null }).where(eq(verrailChannelTargetReplies.id, pending.receiptId!));
    expect((await s.service.reconcile({ ...s.input, providerMessageId: "om_created" })).status).toBe("sending");
    expect(s.call).toHaveBeenCalledTimes(1);
    const startedAt = new Date(Date.now() - 120_000);
    await db.update(verrailChannelTargetReplies).set({ startedAt }).where(eq(verrailChannelTargetReplies.id, pending.receiptId!));
    const [receipt] = await db.select().from(verrailChannelTargetReplies).where(eq(verrailChannelTargetReplies.id, pending.receiptId!));
    s.call.mockResolvedValue({ contractVersion: 1, providerMessageId: "om_created", parentProviderMessageId: "om_source",
      externalConversationId: "chat", bodySha256: receipt!.bodySha256, createdAt: startedAt.toISOString() });
    expect((await s.service.reconcile({ ...s.input, providerMessageId: "om_created" })).status).toBe("succeeded");
    expect(s.call).toHaveBeenCalledTimes(2);
  });

  it.each(["actor", "workspace", "membership", "mapping", "plugin", "definition", "duplicate_plugin"])("refuses unsafe dispatch: %s", async change => {
    const s = await seed();
    if (change === "actor") s.input.principalId = "other";
    if (change === "workspace") s.input.workspaceId = randomUUID();
    if (change === "membership") await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, s.input.workspaceId));
    if (change === "mapping") s.configuration.channelConnections[0]!.authorizedUsers[0]!.userId = "other";
    if (change === "plugin") s.registry.list.mockResolvedValue([]);
    if (change === "duplicate_plugin") s.registry.list.mockResolvedValue([...(await s.registry.list()), ...(await s.registry.list())]);
    if (change === "definition") await db.update(verrailTargetRevisions).set({ goal: "changed" }).where(eq(verrailTargetRevisions.id, s.targetRevisionId));
    expect((await s.service.deliver(s.input)).status).toBe("blocked");
    expect(s.call).not.toHaveBeenCalled();
  });

  it("does not send for Web-only drafts", async () => {
    const s = await seed();
    await db.delete(verrailChannelEvents).where(eq(verrailChannelEvents.id, s.channelEventId));
    await db.update(verrailConversationMessages).set({ metadata: null }).where(eq(verrailConversationMessages.conversationId, s.input.conversationId));
    await db.delete(verrailProviderConversationBindings).where(eq(verrailProviderConversationBindings.conversationId, s.input.conversationId));
    expect((await s.service.deliver(s.input)).status).toBe("not_applicable");
    expect(s.call).not.toHaveBeenCalled();
  });
});
