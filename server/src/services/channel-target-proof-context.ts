import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type Db, companies, verrailChannelEvents, verrailConversations, verrailConversationMessages,
  verrailProviderConversationBindings, verrailTargetCreationDrafts, verrailTargetCreationDraftRevisions,
  verrailTargets, verrailTargetRevisions, verrailCommandReceipts, verrailAuditEvents,
} from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { createTargetSchema, targetDraftDefinitionPatchSchema } from "@paperclipai/shared";
import { HttpError, conflict } from "../errors.js";

const inputSchema = z.object({
  workspaceId: z.string().uuid(), channelEventId: z.string().uuid(), draftRevisionId: z.string().uuid(),
  createdTargetId: z.string().uuid(), createdTargetRevisionId: z.string().uuid(),
}).strict();
export type ChannelTargetProofContextInput = z.infer<typeof inputSchema>;
export const channelTargetProofContextInputSchema = inputSchema;
const commandResponseSchema = z.object({
  schemaVersion: z.literal(1), targetId: z.string().uuid(), targetRevisionId: z.string().uuid(),
  workGraphId: z.string().uuid(), graphRevisionId: z.string().uuid(), workbenchHref: z.string().max(256), replayed: z.literal(false),
}).strict();
const hashPattern = /^[a-f0-9]{64}$/;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function unavailable(): never { throw conflict("Channel Target proof context unavailable or changed"); }

const confirmedDefinitionSchema = targetDraftDefinitionPatchSchema.required();
const createdCriteriaSchema = z.array(z.object({
  id: z.string().uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
  title: z.string(), description: z.string().nullable(),
}).strict()).min(1).max(20);
// Go strings.TrimSpace uses Unicode White_Space (includes U+0085, excludes U+FEFF).
const trimGo = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const trimNullable = (value: string | null | undefined) => value == null ? null : trimGo(value);

function confirmedCreationProjection(raw: unknown) {
  const parsed = confirmedDefinitionSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(raw) !== canonicalJson(parsed.data)) unavailable();
  const definition = parsed.data;
  if (!definition.title || !definition.goal || !definition.outcomeOwner || !definition.riskLevel) unavailable();
  // Match conversations.ts confirmation and target.ValidateCommand, not raw JSON
  // hashes: Go request encoding and the draft writer have different hash preimages.
  const expected = {
    collectionId: definition.collectionId, title: trimGo(definition.title), summary: trimNullable(definition.summary),
    outcomeOwner: { principalType: definition.outcomeOwner.principalType, principalId: trimGo(definition.outcomeOwner.principalId) },
    goal: trimGo(definition.goal), constraints: definition.constraints.map(trimGo),
    acceptanceCriteria: definition.acceptanceCriteria.map(criterion => ({ title: trimGo(criterion.title), description: trimNullable(criterion.description) })),
    riskLevel: definition.riskLevel, deadline: definition.deadline, policySummary: trimNullable(definition.policySummary),
    resourceRefs: definition.resourceRefs.map(ref => ({ kind: trimGo(ref.kind), id: trimGo(ref.id), label: trimNullable(ref.label) })),
  };
  const validated = createTargetSchema.safeParse(expected);
  if (!validated.success || canonicalJson(expected) !== canonicalJson(validated.data)) unavailable();
  return expected;
}

/**
 * Internal verifier input, not authorization or CriterionProof admission. The caller
 * must establish its own read authority. No public route accepts these observations.
 * Stored references cannot attest to Provider authenticity or the running candidate.
 */
export async function loadChannelTargetProofContext(db: Db, raw: ChannelTargetProofContextInput) {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) unavailable();
  const input = parsed.data;
  const { workspaceId } = input;
  try {
    return await db.transaction(async tx => {
      const rows = await tx.select({
        eventId: verrailChannelEvents.id, connectionId: verrailChannelEvents.connectionId,
        providerEventId: verrailChannelEvents.providerEventId, providerUserId: verrailChannelEvents.providerUserId,
        externalConversationId: verrailChannelEvents.externalConversationId,
        externalConversationType: verrailChannelEvents.externalConversationType,
        draftReplyId: verrailChannelEvents.replyProviderMessageId, receivedAt: verrailChannelEvents.receivedAt,
        conversationId: verrailConversations.id, messageId: verrailConversationMessages.id,
        messageAuthor: verrailConversationMessages.authorPrincipalId,
        messageConnector: sql<unknown>`${verrailConversationMessages.metadata}->>'channelConnector'`,
        messageProviderEventId: sql<unknown>`${verrailConversationMessages.metadata}->>'providerEventId'`,
        messageProviderMessageId: sql<unknown>`${verrailConversationMessages.metadata}->>'providerMessageId'`,
        bindingId: verrailProviderConversationBindings.id, bindingUpdatedAt: verrailProviderConversationBindings.updatedAt,
        draftId: verrailTargetCreationDrafts.id, draftInitiator: verrailTargetCreationDrafts.initiatedByPrincipalId,
        confirmedBy: verrailTargetCreationDrafts.confirmedByPrincipalId, confirmedAt: verrailTargetCreationDrafts.confirmedAt,
        idempotencyKey: verrailTargetCreationDrafts.conversionIdempotencyKey,
        draftRevisionId: verrailTargetCreationDraftRevisions.id, draftRevisionNumber: verrailTargetCreationDraftRevisions.revisionNumber,
        draftHash: verrailTargetCreationDraftRevisions.contentHash, missingFields: verrailTargetCreationDraftRevisions.missingFields,
        draftDefinition: verrailTargetCreationDraftRevisions.definition,
        targetId: verrailTargets.id, targetCreatedAt: verrailTargets.createdAt,
        collectionId: verrailTargets.collectionId,
        targetCreatorType: verrailTargets.createdByPrincipalType, targetCreator: verrailTargets.createdByPrincipalId,
        targetRevisionId: verrailTargetRevisions.id, targetHash: verrailTargetRevisions.contentHash,
        title: verrailTargetRevisions.title, summary: verrailTargetRevisions.summary, goal: verrailTargetRevisions.goal,
        ownerType: verrailTargetRevisions.outcomeOwnerPrincipalType, ownerId: verrailTargetRevisions.outcomeOwnerPrincipalId,
        constraints: verrailTargetRevisions.constraints, acceptanceCriteria: verrailTargetRevisions.acceptanceCriteria,
        riskLevel: verrailTargetRevisions.riskLevel, deadline: verrailTargetRevisions.deadline,
        policySummary: verrailTargetRevisions.policySummary, resourceRefs: verrailTargetRevisions.resourceRefs,
        revisionCreatorType: verrailTargetRevisions.createdByPrincipalType, revisionCreator: verrailTargetRevisions.createdByPrincipalId,
      }).from(verrailChannelEvents)
        .innerJoin(companies, and(eq(companies.id, workspaceId), eq(companies.status, "active")))
        .innerJoin(verrailConversations, and(
          eq(verrailConversations.id, verrailChannelEvents.conversationId), eq(verrailConversations.workspaceId, workspaceId),
        ))
        .innerJoin(verrailConversationMessages, and(
          eq(verrailConversationMessages.id, verrailChannelEvents.messageId), eq(verrailConversationMessages.workspaceId, workspaceId),
          eq(verrailConversationMessages.conversationId, verrailConversations.id), eq(verrailConversationMessages.role, "user"),
          eq(verrailConversationMessages.status, "complete"), eq(verrailConversationMessages.authorPrincipalType, "user"),
        ))
        .innerJoin(verrailProviderConversationBindings, and(
          eq(verrailProviderConversationBindings.workspaceId, workspaceId), eq(verrailProviderConversationBindings.conversationId, verrailConversations.id),
          eq(verrailProviderConversationBindings.providerKey, "feishu"), eq(verrailProviderConversationBindings.connectionId, verrailChannelEvents.connectionId),
          eq(verrailProviderConversationBindings.externalConversationId, verrailChannelEvents.externalConversationId),
          eq(verrailProviderConversationBindings.externalConversationType, verrailChannelEvents.externalConversationType),
        ))
        .innerJoin(verrailTargetCreationDrafts, and(
          eq(verrailTargetCreationDrafts.id, verrailChannelEvents.draftId), eq(verrailTargetCreationDrafts.workspaceId, workspaceId),
          eq(verrailTargetCreationDrafts.conversationId, verrailConversations.id), eq(verrailTargetCreationDrafts.sourceMessageId, verrailConversationMessages.id),
          eq(verrailTargetCreationDrafts.status, "converted"), eq(verrailTargetCreationDrafts.initiatedByPrincipalType, "user"),
          eq(verrailTargetCreationDrafts.confirmedByPrincipalType, "user"),
        ))
        .innerJoin(verrailTargetCreationDraftRevisions, and(
          eq(verrailTargetCreationDraftRevisions.id, input.draftRevisionId), eq(verrailTargetCreationDraftRevisions.workspaceId, workspaceId),
          eq(verrailTargetCreationDraftRevisions.id, verrailTargetCreationDrafts.activeRevisionId),
          eq(verrailTargetCreationDraftRevisions.draftId, verrailTargetCreationDrafts.id),
          eq(verrailTargetCreationDraftRevisions.revisionNumber, verrailTargetCreationDrafts.activeRevisionNumber),
        ))
        .innerJoin(verrailTargets, and(
          eq(verrailTargets.id, input.createdTargetId), eq(verrailTargets.workspaceId, workspaceId),
          eq(verrailTargets.id, verrailTargetCreationDrafts.convertedTargetId),
        ))
        .innerJoin(verrailTargetRevisions, and(
          eq(verrailTargetRevisions.id, input.createdTargetRevisionId), eq(verrailTargetRevisions.workspaceId, workspaceId),
          eq(verrailTargetRevisions.id, verrailTargetCreationDrafts.convertedTargetRevisionId),
          eq(verrailTargetRevisions.targetId, verrailTargets.id), eq(verrailTargetRevisions.revisionNumber, 1),
        ))
        .where(and(eq(verrailChannelEvents.workspaceId, workspaceId), eq(verrailChannelEvents.id, input.channelEventId), eq(verrailChannelEvents.connectorKey, "feishu")))
        .limit(2);
      const row = rows[0];
      if (rows.length !== 1 || !row || !row.confirmedAt || !nonempty(row.confirmedBy) || !nonempty(row.draftInitiator)
        || row.messageAuthor !== row.draftInitiator || row.messageConnector !== "feishu" || row.messageProviderEventId !== row.providerEventId
        || ![row.connectionId, row.providerEventId, row.providerUserId, row.externalConversationId, row.messageProviderMessageId].every(nonempty)
        || (row.draftReplyId !== null && !nonempty(row.draftReplyId))
        || row.targetCreatorType !== "user" || row.targetCreator !== row.confirmedBy
        || row.revisionCreatorType !== "user" || row.revisionCreator !== row.confirmedBy
        || !Number.isSafeInteger(row.draftRevisionNumber) || row.draftRevisionNumber < 1
        || row.idempotencyKey !== `target-draft:${row.draftId}:v${row.draftRevisionNumber}`
        || !Array.isArray(row.missingFields) || row.missingFields.length !== 0
        || !hashPattern.test(row.draftHash) || !hashPattern.test(row.targetHash)
        || row.confirmedAt < row.receivedAt || row.targetCreatedAt < row.confirmedAt) unavailable();

      const expectedDefinition = confirmedCreationProjection(row.draftDefinition);
      const criteria = createdCriteriaSchema.safeParse(row.acceptanceCriteria);
      if (!criteria.success || new Set(criteria.data.map(criterion => criterion.id)).size !== criteria.data.length) unavailable();
      const createdDefinition = {
        collectionId: row.collectionId, title: row.title, summary: row.summary,
        outcomeOwner: { principalType: row.ownerType, principalId: row.ownerId }, goal: row.goal, constraints: row.constraints,
        acceptanceCriteria: criteria.data.map(({ title, description }) => ({ title, description })),
        riskLevel: row.riskLevel, deadline: row.deadline, policySummary: row.policySummary, resourceRefs: row.resourceRefs,
      };
      if (canonicalJson(expectedDefinition) !== canonicalJson(createdDefinition)) unavailable();

      const commands = await tx.select().from(verrailCommandReceipts).where(and(
        eq(verrailCommandReceipts.workspaceId, workspaceId), eq(verrailCommandReceipts.commandType, "target.create.v1"),
        eq(verrailCommandReceipts.principalType, "user"), eq(verrailCommandReceipts.principalId, row.confirmedBy),
        eq(verrailCommandReceipts.idempotencyKey, row.idempotencyKey), eq(verrailCommandReceipts.targetId, row.targetId),
        eq(verrailCommandReceipts.targetRevisionId, row.targetRevisionId),
      )).limit(2);
      const command = commands[0];
      const response = commandResponseSchema.safeParse(command?.response);
      if (commands.length !== 1 || !command || !response.success || command.requestHash !== row.targetHash
        || command.createdAt < row.confirmedAt || response.data.targetId !== row.targetId || response.data.targetRevisionId !== row.targetRevisionId
        || response.data.workbenchHref !== `/targets/${row.targetId}/overview`) unavailable();

      const audits = await tx.select().from(verrailAuditEvents).where(and(
        eq(verrailAuditEvents.workspaceId, workspaceId), eq(verrailAuditEvents.aggregateType, "target"),
        eq(verrailAuditEvents.aggregateId, row.targetId), eq(verrailAuditEvents.eventType, "target.created"),
      )).limit(2);
      const audit = audits[0];
      const expectedPayload = { schemaVersion: 1, targetId: row.targetId, targetRevisionId: row.targetRevisionId,
        workGraphId: response.data.workGraphId, graphRevisionId: response.data.graphRevisionId, requestHash: command.requestHash };
      if (audits.length !== 1 || !audit || audit.principalType !== "user" || audit.principalId !== row.confirmedBy
        || audit.idempotencyKey !== row.idempotencyKey || audit.occurredAt < row.confirmedAt
        || canonicalJson(audit.payload) !== canonicalJson(expectedPayload)) unavailable();

      // Scoped pseudonyms preserve correlation, not anonymity or authenticity.
      const reference = (kind: string, value: unknown) => digest(["verrail/channel-reference/v1", workspaceId, row.connectionId, kind, value]);
      return {
        schemaVersion: 1 as const, kind: "verrail.channel-target-database-context" as const, assurance: "database_context_only" as const,
        workspaceId, channelEventId: row.eventId, conversationId: row.conversationId, messageId: row.messageId, providerBindingId: row.bindingId,
        draft: { id: row.draftId, revisionId: row.draftRevisionId, revisionNumber: row.draftRevisionNumber, storedContentHash: row.draftHash },
        createdTarget: { id: row.targetId, revisionId: row.targetRevisionId, storedContentHash: row.targetHash, commandReceiptId: command.id, auditEventId: audit.id },
        definitionEquivalence: { policy: "verrail/confirmed-target-definition/v1" as const, scope: "target_create_projection" as const, status: "matched" as const,
          contentSha256: digest(["verrail/confirmed-target-definition/v1", input, expectedDefinition]) },
        receivedAt: row.receivedAt.toISOString(), confirmedAt: row.confirmedAt.toISOString(), createdAt: command.createdAt.toISOString(),
        providerReferences: { connectionSha256: reference("connection", row.connectionId), eventSha256: reference("event", row.providerEventId),
          conversationSha256: reference("conversation", row.externalConversationId), messageSha256: reference("message", row.messageProviderMessageId),
          userSha256: reference("user", row.providerUserId), draftReplySha256: row.draftReplyId === null ? null : reference("message", row.draftReplyId) },
        unverified: ["provider_authenticity_and_user_mapping", "stored_content_hash_preimages", "target_creation_reply", "candidate_runtime_binding"] as const,
        contextSha256: digest({ input, row, command, audit }),
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && error.message === "Channel Target proof context unavailable or changed") throw error;
    // Database exceptions may include credentials or raw query parameters.
    throw new HttpError(503, "Channel Target proof context unavailable");
  }
}
