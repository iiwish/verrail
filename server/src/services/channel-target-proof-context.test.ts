import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb, companies, verrailChannelEvents, verrailConversations, verrailConversationMessages,
  verrailProviderConversationBindings, verrailTargetCreationDrafts, verrailTargetCreationDraftRevisions,
  verrailTargets, verrailTargetRevisions, verrailCommandReceipts, verrailAuditEvents, verrailChannelTargetReplies,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { loadChannelTargetProofContext } from "./channel-target-proof-context.js";
import { observeChannelTargetProvider } from "./channel-target-provider-observation.js";
import { provisionDeliveryProofReader, removeDeliveryProofReader, assertDeliveryProofReader } from "./delivery-proof-reader-access.js";

const hash = "a".repeat(64);
const receivedAt = new Date("2026-09-09T00:00:00Z");
const confirmedAt = new Date("2026-09-09T00:01:00Z");
const createdAt = new Date("2026-09-09T00:02:00Z");
const author = { createdByPrincipalType: "user", createdByPrincipalId: "confirming-human" };
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("channel Target proof database context (synthetic, not live proof)", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("verrail-channel-proof-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const [workspace] = await db.insert(companies).values({ name: "Synthetic channel proof", issuePrefix: `CP${randomUUID().slice(0, 6)}` }).returning();
    const workspaceId = workspace!.id;
    const channelEventId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), bindingId = randomUUID();
    const draftId = randomUUID(), draftRevisionId = randomUUID(), createdTargetId = randomUUID(), createdTargetRevisionId = randomUUID();
    const receiptId = randomUUID(), auditId = randomUUID(), workGraphId = randomUUID(), graphRevisionId = randomUUID();
    const conversionIdempotencyKey = `target-draft:${draftId}:v2`;
    const definition = { collectionId: null, title: "PRIVATE TITLE", summary: "PRIVATE SUMMARY", goal: "PRIVATE GOAL",
      outcomeOwner: { principalType: "user" as const, principalId: "owner" }, constraints: ["Private constraint 1", "Private constraint 2"],
      acceptanceCriteria: [{ title: "Private criterion 1", description: "Private description" }, { title: "Private criterion 2" }],
      riskLevel: "low" as const, deadline: "2026-10-01", policySummary: "PRIVATE POLICY",
      resourceRefs: [{ kind: "document", id: "private-resource", label: "Private resource", href: "https://private.invalid", contentHash: "private-resource-hash" }] };
    const criteria = definition.acceptanceCriteria.map(c => ({ id: randomUUID(), title: c.title, description: c.description ?? null }));
    const response = { schemaVersion: 1, targetId: createdTargetId, targetRevisionId: createdTargetRevisionId, workGraphId, graphRevisionId,
      workbenchHref: `/targets/${createdTargetId}/overview`, replayed: false };
    const auditPayload = { schemaVersion: 1, targetId: createdTargetId, targetRevisionId: createdTargetRevisionId, workGraphId, graphRevisionId, requestHash: hash };
    await db.insert(verrailConversations).values({ id: conversationId, workspaceId, ...author });
    await db.insert(verrailConversationMessages).values({ id: messageId, workspaceId, conversationId, role: "user", status: "complete",
      body: "PRIVATE MESSAGE MUST NOT LEAVE DATABASE", authorPrincipalType: "user", authorPrincipalId: "initiating-human",
      metadata: { channelConnector: "feishu", providerEventId: "private-event", providerMessageId: "private-message", extra: "PRIVATE METADATA" } });
    await db.insert(verrailProviderConversationBindings).values({ id: bindingId, workspaceId, conversationId, providerKey: "feishu",
      connectionId: "private-connection", externalConversationType: "group", externalConversationId: "private-conversation", ...author });
    await db.insert(verrailTargetCreationDrafts).values({ id: draftId, workspaceId, conversationId, sourceMessageId: messageId,
      initiatedByPrincipalType: "user", initiatedByPrincipalId: "initiating-human", status: "converted", activeRevisionId: draftRevisionId,
      activeRevisionNumber: 2, confirmedByPrincipalType: "user", confirmedByPrincipalId: author.createdByPrincipalId, confirmedAt,
      conversionIdempotencyKey, convertedTargetId: createdTargetId, convertedTargetRevisionId: createdTargetRevisionId });
    await db.insert(verrailTargetCreationDraftRevisions).values({ id: draftRevisionId, workspaceId, draftId, revisionNumber: 2,
      definition,
      missingFields: [], contentHash: hash, ...author });
    await db.insert(verrailTargets).values({ id: createdTargetId, workspaceId, activeTargetRevisionId: createdTargetRevisionId, createdAt, ...author });
    await db.insert(verrailTargetRevisions).values({ id: createdTargetRevisionId, workspaceId, targetId: createdTargetId, revisionNumber: 1,
      title: definition.title, summary: definition.summary, goal: definition.goal, outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "owner",
      constraints: definition.constraints, acceptanceCriteria: criteria, riskLevel: "low", deadline: definition.deadline, policySummary: definition.policySummary,
      resourceRefs: definition.resourceRefs.map(({ kind, id, label }) => ({ kind, id, label })), contentHash: hash, createdAt, ...author });
    await db.insert(verrailCommandReceipts).values({ id: receiptId, workspaceId, principalType: "user", principalId: author.createdByPrincipalId,
      commandType: "target.create.v1", idempotencyKey: conversionIdempotencyKey, requestHash: hash, targetId: createdTargetId, targetRevisionId: createdTargetRevisionId, response, createdAt });
    await db.insert(verrailAuditEvents).values({ id: auditId, workspaceId, principalType: "user", principalId: author.createdByPrincipalId,
      eventType: "target.created", aggregateType: "target", aggregateId: createdTargetId, idempotencyKey: conversionIdempotencyKey, payload: auditPayload, occurredAt: createdAt });
    await db.insert(verrailChannelEvents).values({ id: channelEventId, workspaceId, connectorKey: "feishu", connectionId: "private-connection",
      providerEventId: "private-event", providerUserId: "private-provider-user", externalConversationType: "group", externalConversationId: "private-conversation",
      conversationId, messageId, draftId, replyProviderMessageId: "private-draft-reply", receivedAt });
    const input = { workspaceId, channelEventId, draftRevisionId, createdTargetId, createdTargetRevisionId };
    return { input, conversationId, messageId, bindingId, draftId, receiptId, auditId, response, auditPayload, definition, criteria,
      load: () => loadChannelTargetProofContext(db, input) };
  }

  it("correlates exact stored identities without treating a draft reply as creation proof", async () => {
    const s = await seed(), context = await s.load();
    expect(context).toMatchObject({ schemaVersion: 1, kind: "verrail.channel-target-database-context", assurance: "database_context_only",
      workspaceId: s.input.workspaceId, channelEventId: s.input.channelEventId,
      draft: { id: s.draftId, revisionId: s.input.draftRevisionId, revisionNumber: 2 },
      createdTarget: { id: s.input.createdTargetId, revisionId: s.input.createdTargetRevisionId, commandReceiptId: s.receiptId, auditEventId: s.auditId },
      definitionEquivalence: { policy: "verrail/confirmed-target-definition/v1", scope: "target_create_projection", status: "matched" },
      unverified: ["provider_authenticity_and_user_mapping", "stored_content_hash_preimages", "target_creation_reply", "candidate_runtime_binding"] });
    expect(context.definitionEquivalence.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(context.contextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(context.providerReferences.draftReplySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await s.load()).toEqual(context);
    const serialized = JSON.stringify(context);
    for (const secret of ["private-", "PRIVATE", "initiating-human", "confirming-human", "owner"]) expect(serialized).not.toContain(secret);
    expect(context).not.toHaveProperty("passed");
    expect(context).not.toHaveProperty("criterionProof");
  });

  it("loads the same channel context through a dedicated scoped database login", async () => {
    const s = await seed();
    const access = await provisionDeliveryProofReader(db, { workspaceId: s.input.workspaceId,
      roleName: `verrail_proof_ro_${randomUUID().replaceAll("-", "").slice(0, 12)}`, databaseUrl: database.connectionString });
    const reader = createDb(access.databaseUrl, { maxConnections: 1 });
    try {
      await assertDeliveryProofReader(reader, access);
      expect(await loadChannelTargetProofContext(reader, s.input)).toEqual(await s.load());
    } finally { await reader.$client.end(); await removeDeliveryProofReader(db, access); }
  });

  async function providerFixture() {
    const s = await seed(), context = await s.load();
    const replyText = `Verrail: Target created.\nhttps://verrail.example/targets/${s.input.createdTargetId}/overview\nTargetRevision: ${s.input.createdTargetRevisionId}`;
    await db.insert(verrailChannelTargetReplies).values({ workspaceId: s.input.workspaceId, draftId: s.draftId,
      draftRevisionId: s.input.draftRevisionId, channelEventId: s.input.channelEventId, targetId: s.input.createdTargetId,
      targetRevisionId: s.input.createdTargetRevisionId, pluginId: randomUUID(), confirmedByPrincipalId: author.createdByPrincipalId,
      configurationSha256: hash, contextSha256: context.contextSha256, bodySha256: createHash("sha256").update(replyText).digest("hex"),
      idempotencyKey: `vtc:${s.draftId}`, status: "succeeded", providerMessageId: "private-created-reply",
      startedAt: createdAt, completedAt: new Date(createdAt.getTime() + 1000) });
    const inbound = { message_id: "private-message", msg_type: "text", deleted: false, updated: false,
      chat_id: "private-conversation", create_time: String(receivedAt.getTime()),
      sender: { id: "private-provider-user", id_type: "open_id", sender_type: "user" },
      body: { content: JSON.stringify({ text: "  PRIVATE MESSAGE MUST NOT LEAVE DATABASE  " }) } };
    const reply = { ...inbound, message_id: "private-created-reply", parent_id: "private-message", create_time: String(createdAt.getTime()),
      sender: { id: "private-app", id_type: "app_id", sender_type: "app" }, body: { content: JSON.stringify({ text: replyText }) } };
    const config = { schemaVersion: 1 as const, workspaceId: s.input.workspaceId, connectionId: "private-connection", appId: "private-app",
      appSecret: "PRIVATE APP SECRET", publicBaseUrl: "https://verrail.example", authorizedUsers: [{ providerUserId: "private-provider-user", userId: "initiating-human" }] };
    const fetcher = vi.fn(async (url: string | URL | Request) => Response.json(String(url).includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "PRIVATE ACCESS TOKEN" }
      : { code: 0, data: { items: [String(url).endsWith("private-message") ? inbound : reply] } }));
    const access = await provisionDeliveryProofReader(db, { workspaceId: s.input.workspaceId,
      roleName: `verrail_proof_ro_${randomUUID().replaceAll("-", "").slice(0, 12)}`, databaseUrl: database.connectionString, schemaVersion: 2 });
    const reader = createDb(access.databaseUrl, { maxConnections: 1 });
    return { ...s, inbound, reply, config, fetcher, observe: async () => {
      try { return await observeChannelTargetProvider(reader, s.input, config, { access, fetch: fetcher }); }
      finally { await reader.$client.end(); await removeDeliveryProofReader(db, access); }
    } };
  }

  it("independently reads actual message and creation reply instead of accepting plugin claims", async () => {
    const s = await providerFixture(), result = await s.observe();
    expect(result).toMatchObject({ kind: "verrail.channel-target-provider-observation", workspaceId: s.input.workspaceId,
      channelEventId: s.input.channelEventId, assurance: "provider_message_and_reply_readback" });
    expect(s.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/messages/private-message",
      "https://open.feishu.cn/open-apis/im/v1/messages/private-created-reply",
    ]);
    for (const privateValue of ["PRIVATE", "private-", "initiating-human", "confirming-human", "verrail.example"])
      expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(result).not.toHaveProperty("criterionProof");
  });

  it.each(["sender", "user_mapping", "body", "updated", "deleted", "chat", "parent", "reply_sender", "reply_body", "reply_time", "unknown", "scope", "provider_failure", "db_changed"])("refuses Provider mismatch %s", async change => {
    const s = await providerFixture();
    if (change === "sender") s.inbound.sender.id = "other";
    if (change === "user_mapping") s.config.authorizedUsers[0]!.userId = "other";
    if (change === "body") s.inbound.body.content = JSON.stringify({ text: "other" });
    if (change === "updated") s.inbound.updated = true;
    if (change === "deleted") s.reply.deleted = true;
    if (change === "chat") s.reply.chat_id = "other";
    if (change === "parent") s.reply.parent_id = "other";
    if (change === "reply_sender") s.reply.sender.id = "other";
    if (change === "reply_body") s.reply.body.content = JSON.stringify({ text: "Verrail: Target created." });
    if (change === "reply_time") s.reply.create_time = String(confirmedAt.getTime());
    if (change === "unknown") await db.update(verrailChannelTargetReplies).set({ status: "unknown", providerMessageId: null }).where(eq(verrailChannelTargetReplies.draftId, s.draftId));
    if (change === "scope") s.config.workspaceId = randomUUID();
    if (change === "provider_failure") s.fetcher.mockRejectedValue(new Error("PRIVATE SECRET NETWORK ERROR"));
    if (change === "db_changed") s.fetcher.mockImplementationOnce(async () => {
      await db.update(verrailChannelTargetReplies).set({ bodySha256: "b".repeat(64) }).where(eq(verrailChannelTargetReplies.draftId, s.draftId));
      return Response.json({ code: 0, tenant_access_token: "PRIVATE ACCESS TOKEN" });
    });
    await expect(s.observe()).rejects.toThrow(/^CHANNEL_PROVIDER_OBSERVATION_UNAVAILABLE$/);
  });

  it.each(["title", "summary", "goal", "outcomeOwnerPrincipalType", "outcomeOwnerPrincipalId", "constraints", "acceptanceCriteria", "riskLevel", "deadline", "policySummary", "resourceRefs"] as const)("rejects changed created definition field %s even with matching stored hashes", async field => {
    const s = await seed();
    const changes = { title: "other", summary: null, goal: "other", outcomeOwnerPrincipalType: "agent", outcomeOwnerPrincipalId: "other",
      constraints: [...s.definition.constraints].reverse(), acceptanceCriteria: [...s.criteria].reverse(), riskLevel: "high", deadline: "2026-10-02", policySummary: null,
      resourceRefs: [{ kind: "document", id: "other", label: "Private resource" }] };
    await db.update(verrailTargetRevisions).set({ [field]: changes[field] }).where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });

  it.each(["collection", "title", "owner", "missing", "unknown", "empty_criteria", "unknown_criterion", "unknown_resource", "invalid_date"])("rejects malformed or changed confirmed definition: %s", async change => {
    const s = await seed();
    const definition: Record<string, unknown> = structuredClone(s.definition);
    if (change === "collection") definition.collectionId = randomUUID();
    if (change === "title") definition.title = "other";
    if (change === "owner") definition.outcomeOwner = null;
    if (change === "missing") delete definition.constraints;
    if (change === "unknown") definition.unconfirmedInstruction = "PRIVATE";
    if (change === "empty_criteria") definition.acceptanceCriteria = [];
    if (change === "unknown_criterion") definition.acceptanceCriteria = [{ title: "Private criterion 1", proofContract: {} }];
    if (change === "unknown_resource") definition.resourceRefs = [{ ...s.definition.resourceRefs[0], unexpected: true }];
    if (change === "invalid_date") definition.deadline = "2026-02-30";
    await db.update(verrailTargetCreationDraftRevisions).set({ definition: definition as never }).where(eq(verrailTargetCreationDraftRevisions.id, s.input.draftRevisionId));
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });

  it.each(["bad_id", "duplicate_id", "description", "proof_contract", "missing_description", "extra_resource"])("rejects created definition structural mismatch: %s", async change => {
    const s = await seed();
    const criteria: Record<string, unknown>[] = structuredClone(s.criteria);
    if (change === "bad_id") criteria[0]!.id = "not-generated-uuid";
    if (change === "duplicate_id") criteria[1]!.id = criteria[0]!.id;
    if (change === "description") criteria[0]!.description = null;
    if (change === "proof_contract") criteria[0]!.proofContract = {};
    if (change === "missing_description") delete criteria[1]!.description;
    await db.update(verrailTargetRevisions).set(change === "extra_resource"
      ? { resourceRefs: s.definition.resourceRefs }
      : { acceptanceCriteria: criteria as never }).where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });

  it("matches Go whitespace normalization without normalizing the stored Target a second time", async () => {
    const s = await seed();
    const wrap = (value: string) => `\u0085${value}\u0085`;
    const definition = { ...s.definition, title: wrap(s.definition.title), summary: wrap(s.definition.summary), goal: wrap(s.definition.goal),
      outcomeOwner: { ...s.definition.outcomeOwner, principalId: wrap("owner") }, constraints: s.definition.constraints.map(wrap),
      acceptanceCriteria: s.definition.acceptanceCriteria.map(c => ({ title: wrap(c.title), description: c.description ? wrap(c.description) : null })),
      policySummary: wrap(s.definition.policySummary),
      resourceRefs: s.definition.resourceRefs.map(ref => ({ ...ref, kind: wrap(ref.kind), id: wrap(ref.id), label: wrap(ref.label) })) };
    await db.update(verrailTargetCreationDraftRevisions).set({ definition }).where(eq(verrailTargetCreationDraftRevisions.id, s.input.draftRevisionId));
    expect((await s.load()).definitionEquivalence.status).toBe("matched");
    await db.update(verrailTargetRevisions).set({ title: wrap(s.definition.title) }).where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });

  it("supports null optional fields, empty constraints and an omitted resource label", async () => {
    const s = await seed();
    const definition = { ...s.definition, summary: null, deadline: null, policySummary: null, constraints: [],
      acceptanceCriteria: [{ title: "Private criterion 1", description: null }], resourceRefs: [{ kind: "document", id: "private-resource" }] };
    await db.update(verrailTargetCreationDraftRevisions).set({ definition }).where(eq(verrailTargetCreationDraftRevisions.id, s.input.draftRevisionId));
    await db.update(verrailTargetRevisions).set({ summary: null, deadline: null, policySummary: null, constraints: [],
      acceptanceCriteria: [{ ...s.criteria[0]!, description: null }], resourceRefs: [{ kind: "document", id: "private-resource", label: null }] })
      .where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    expect((await s.load()).definitionEquivalence.status).toBe("matched");
  });

  it("fingerprints source-only resource metadata without pretending it was persisted to the Target", async () => {
    const s = await seed(), before = await s.load();
    const definition = { ...s.definition, resourceRefs: [{ ...s.definition.resourceRefs[0]!, href: "https://private-changed.invalid", contentHash: "private-changed-hash" }] };
    await db.update(verrailTargetCreationDraftRevisions).set({ definition }).where(eq(verrailTargetCreationDraftRevisions.id, s.input.draftRevisionId));
    const after = await s.load();
    expect(after.definitionEquivalence).toEqual(before.definitionEquivalence);
    expect(after.contextSha256).not.toBe(before.contextSha256);
    expect(JSON.stringify(after)).not.toContain("private-changed");
  });

  it("distinguishes content equality from verification of stored hash preimages", async () => {
    const s = await seed(), before = await s.load();
    const title = "Private <&> Chinese 中文 \u2028 \u2029 title";
    await db.update(verrailTargetCreationDraftRevisions).set({ definition: { ...s.definition, title } }).where(eq(verrailTargetCreationDraftRevisions.id, s.input.draftRevisionId));
    await db.update(verrailTargetRevisions).set({ title }).where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    const after = await s.load();
    expect(after.definitionEquivalence.contentSha256).not.toBe(before.definitionEquivalence.contentSha256);
    expect(after.unverified).toContain("stored_content_hash_preimages");
    expect(after.createdTarget.storedContentHash).toBe(before.createdTarget.storedContentHash);
    expect(JSON.stringify(after)).not.toContain(title);
  });

  it.each(["\u0085", "\uFEFFPRIVATE TITLE\uFEFF"])("refuses empty-after-Go-normalization or unnormalized draft text", async title => {
    const s = await seed();
    await db.update(verrailTargetCreationDraftRevisions).set({ definition: { ...s.definition, title } }).where(eq(verrailTargetCreationDraftRevisions.id, s.input.draftRevisionId));
    await db.update(verrailTargetRevisions).set({ title: title === "\u0085" ? "" : "PRIVATE TITLE" }).where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });

  it.each(["workspaceId", "channelEventId", "draftRevisionId", "createdTargetId", "createdTargetRevisionId"] as const)("rejects foreign or stale %s", async key => {
    const s = await seed();
    await expect(loadChannelTargetProofContext(db, { ...s.input, [key]: randomUUID() })).rejects.toMatchObject({ status: 409 });
  });

  it.each(["workspace", "connector", "binding", "binding_type", "message_event", "message_connector", "message_role", "message_author", "message_status",
    "draft_source", "draft_conversation", "draft_status", "draft_number", "draft_revision_owner", "draft_incomplete", "confirmation_actor", "confirmation_missing", "confirmation_time",
    "idempotency", "target_creator", "revision_creator", "revision_number", "revision_hash", "receipt_missing", "receipt_principal", "receipt_type", "receipt_response", "receipt_time",
    "audit_missing", "audit_principal", "audit_payload", "audit_duplicate"])("rejects %s mismatch", async change => {
    const s = await seed();
    if (change === "workspace") await db.update(companies).set({ status: "archived" }).where(eq(companies.id, s.input.workspaceId));
    if (change === "connector") await db.update(verrailChannelEvents).set({ connectorKey: "untrusted" }).where(eq(verrailChannelEvents.id, s.input.channelEventId));
    if (change === "binding") await db.update(verrailProviderConversationBindings).set({ connectionId: "other" }).where(eq(verrailProviderConversationBindings.id, s.bindingId));
    if (change === "binding_type") await db.update(verrailProviderConversationBindings).set({ externalConversationType: "direct" }).where(eq(verrailProviderConversationBindings.id, s.bindingId));
    if (change === "message_event" || change === "message_connector") await db.update(verrailConversationMessages).set({ metadata: {
      channelConnector: change === "message_connector" ? "other" : "feishu", providerEventId: change === "message_event" ? "other" : "private-event", providerMessageId: "private-message",
    } }).where(eq(verrailConversationMessages.id, s.messageId));
    if (change === "message_role") await db.update(verrailConversationMessages).set({ role: "assistant" }).where(eq(verrailConversationMessages.id, s.messageId));
    if (change === "message_author") await db.update(verrailConversationMessages).set({ authorPrincipalId: "other" }).where(eq(verrailConversationMessages.id, s.messageId));
    if (change === "message_status") await db.update(verrailConversationMessages).set({ status: "failed" }).where(eq(verrailConversationMessages.id, s.messageId));
    if (change === "draft_source") {
      const id = randomUUID();
      await db.insert(verrailConversationMessages).values({ id, workspaceId: s.input.workspaceId, conversationId: s.conversationId, role: "user", body: "other" });
      await db.update(verrailTargetCreationDrafts).set({ sourceMessageId: id }).where(eq(verrailTargetCreationDrafts.id, s.draftId));
    }
    if (change === "draft_conversation") {
      const id = randomUUID();
      await db.insert(verrailConversations).values({ id, workspaceId: s.input.workspaceId, ...author });
      await db.update(verrailTargetCreationDrafts).set({ conversationId: id }).where(eq(verrailTargetCreationDrafts.id, s.draftId));
    }
    if (change === "draft_status") await db.update(verrailTargetCreationDrafts).set({ status: "converting" }).where(eq(verrailTargetCreationDrafts.id, s.draftId));
    if (change === "draft_number") await db.update(verrailTargetCreationDrafts).set({ activeRevisionNumber: 3 }).where(eq(verrailTargetCreationDrafts.id, s.draftId));
    if (change === "draft_revision_owner") {
      const other = await seed();
      await db.delete(verrailTargetCreationDraftRevisions).where(eq(verrailTargetCreationDraftRevisions.id, other.input.draftRevisionId));
      await db.update(verrailTargetCreationDraftRevisions).set({ draftId: other.draftId, workspaceId: other.input.workspaceId }).where(eq(verrailTargetCreationDraftRevisions.id, s.input.draftRevisionId));
    }
    if (change === "draft_incomplete") await db.update(verrailTargetCreationDraftRevisions).set({ missingFields: ["goal"] }).where(eq(verrailTargetCreationDraftRevisions.id, s.input.draftRevisionId));
    if (change === "confirmation_actor") await db.update(verrailTargetCreationDrafts).set({ confirmedByPrincipalType: "agent" }).where(eq(verrailTargetCreationDrafts.id, s.draftId));
    if (change === "confirmation_missing") await db.update(verrailTargetCreationDrafts).set({ confirmedAt: null }).where(eq(verrailTargetCreationDrafts.id, s.draftId));
    if (change === "confirmation_time") await db.update(verrailTargetCreationDrafts).set({ confirmedAt: new Date(receivedAt.getTime() - 1) }).where(eq(verrailTargetCreationDrafts.id, s.draftId));
    if (change === "idempotency") await db.update(verrailTargetCreationDrafts).set({ conversionIdempotencyKey: "other" }).where(eq(verrailTargetCreationDrafts.id, s.draftId));
    if (change === "target_creator") await db.update(verrailTargets).set({ createdByPrincipalId: "other" }).where(eq(verrailTargets.id, s.input.createdTargetId));
    if (change === "revision_creator") await db.update(verrailTargetRevisions).set({ createdByPrincipalId: "other" }).where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    if (change === "revision_number") await db.update(verrailTargetRevisions).set({ revisionNumber: 2 }).where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    if (change === "revision_hash") await db.update(verrailTargetRevisions).set({ contentHash: "b".repeat(64) }).where(eq(verrailTargetRevisions.id, s.input.createdTargetRevisionId));
    if (change === "receipt_missing") await db.delete(verrailCommandReceipts).where(eq(verrailCommandReceipts.id, s.receiptId));
    if (change === "receipt_principal") await db.update(verrailCommandReceipts).set({ principalId: "other" }).where(eq(verrailCommandReceipts.id, s.receiptId));
    if (change === "receipt_type") await db.update(verrailCommandReceipts).set({ commandType: "target.revise.v1" }).where(eq(verrailCommandReceipts.id, s.receiptId));
    if (change === "receipt_response") await db.update(verrailCommandReceipts).set({ response: { ...s.response, targetRevisionId: randomUUID() } }).where(eq(verrailCommandReceipts.id, s.receiptId));
    if (change === "receipt_time") await db.update(verrailCommandReceipts).set({ createdAt: receivedAt }).where(eq(verrailCommandReceipts.id, s.receiptId));
    if (change === "audit_missing") await db.delete(verrailAuditEvents).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "audit_principal") await db.update(verrailAuditEvents).set({ principalType: "agent" }).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "audit_payload") await db.update(verrailAuditEvents).set({ payload: { ...s.auditPayload, requestHash: "b".repeat(64) } }).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "audit_duplicate") {
      const [audit] = await db.select().from(verrailAuditEvents).where(eq(verrailAuditEvents.id, s.auditId));
      await db.insert(verrailAuditEvents).values({ ...audit!, id: randomUUID() });
    }
    await expect(s.load()).rejects.toMatchObject({ status: 409, message: "Channel Target proof context unavailable or changed" });
  });

  it("does not require or upgrade the optional draft reply and fingerprints changed references", async () => {
    const s = await seed(), before = await s.load();
    await db.update(verrailChannelEvents).set({ replyProviderMessageId: null }).where(eq(verrailChannelEvents.id, s.input.channelEventId));
    const after = await s.load();
    expect(after.providerReferences.draftReplySha256).toBeNull();
    expect(after.contextSha256).not.toBe(before.contextSha256);
    expect(after.unverified).toEqual(before.unverified);
  });

  it("uses a read-only repeatable snapshot and never writes to the database", async () => {
    const s = await seed();
    const spy = vi.spyOn(db, "transaction");
    try {
      await s.load();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
    } finally { spy.mockRestore(); }
  });
});

describe("channel proof context input and error boundaries", () => {
  const input = { workspaceId: randomUUID(), channelEventId: randomUUID(), draftRevisionId: randomUUID(), createdTargetId: randomUUID(), createdTargetRevisionId: randomUUID() };
  it("rejects caller-supplied observations before reading the database", async () => {
    const transaction = vi.fn();
    await expect(loadChannelTargetProofContext({ transaction } as never, { ...input, passed: true } as never)).rejects.toMatchObject({ status: 409 });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("does not expose database diagnostics or query parameters", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("postgres://secret:password@host PRIVATE QUERY"));
    await expect(loadChannelTargetProofContext({ transaction } as never, input)).rejects.toMatchObject({ status: 503, message: "Channel Target proof context unavailable" });
  });
});
