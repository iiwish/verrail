import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  verrailConversationContextBindings,
  verrailConversationMessages,
  verrailConversations,
  verrailProviderConversationBindings,
  verrailTargetCreationDraftRevisions,
  verrailTargetCreationDrafts,
  type Db,
  type VerrailTargetDraftDefinitionRecord,
} from "@paperclipai/db";
import type {
  CreateProviderConversationBindingInput,
  CreateTargetCreationDraftInput,
  ProviderConversationBinding,
  TargetCreationDraft,
  TargetCreationDraftRevision,
  TargetDraftDefinition,
  TargetDraftDefinitionPatch,
  UpdateTargetCreationDraftInput,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type Actor = { principalType: "user" | "agent"; principalId: string };

const EMPTY_DEFINITION: TargetDraftDefinition = {
  collectionId: null,
  title: null,
  summary: null,
  outcomeOwner: null,
  goal: null,
  constraints: [],
  acceptanceCriteria: [],
  riskLevel: null,
  deadline: null,
  policySummary: null,
  resourceRefs: [],
};

function mergeDefinition(
  current: TargetDraftDefinition,
  patch: TargetDraftDefinitionPatch,
): TargetDraftDefinition {
  return {
    collectionId: patch.collectionId !== undefined ? patch.collectionId : current.collectionId,
    title: patch.title !== undefined ? patch.title : current.title,
    summary: patch.summary !== undefined ? patch.summary : current.summary,
    outcomeOwner: patch.outcomeOwner !== undefined ? patch.outcomeOwner : current.outcomeOwner,
    goal: patch.goal !== undefined ? patch.goal : current.goal,
    constraints: patch.constraints ?? current.constraints,
    acceptanceCriteria: patch.acceptanceCriteria ?? current.acceptanceCriteria,
    riskLevel: patch.riskLevel !== undefined ? patch.riskLevel : current.riskLevel,
    deadline: patch.deadline !== undefined ? patch.deadline : current.deadline,
    policySummary: patch.policySummary !== undefined ? patch.policySummary : current.policySummary,
    resourceRefs: patch.resourceRefs ?? current.resourceRefs,
  };
}

function missingFields(definition: TargetDraftDefinition) {
  return [
    !definition.title ? "title" : null,
    !definition.goal ? "goal" : null,
    !definition.outcomeOwner ? "outcomeOwner" : null,
    definition.acceptanceCriteria.length === 0 ? "acceptanceCriteria" : null,
    !definition.riskLevel ? "riskLevel" : null,
  ].filter((field): field is string => Boolean(field));
}

function contentHash(definition: TargetDraftDefinition) {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function mapRevision(
  row: typeof verrailTargetCreationDraftRevisions.$inferSelect,
): TargetCreationDraftRevision {
  return {
    ...row,
    definition: row.definition as unknown as TargetDraftDefinition,
  };
}

function mapDraft(
  row: typeof verrailTargetCreationDrafts.$inferSelect,
  revision: typeof verrailTargetCreationDraftRevisions.$inferSelect,
): TargetCreationDraft {
  return {
    ...row,
    status: row.status as TargetCreationDraft["status"],
    activeRevision: mapRevision(revision),
  };
}

export function targetCreationDraftService(db: Db) {
  async function get(workspaceId: string, conversationId: string, draftId: string) {
    const row = await db
      .select({ draft: verrailTargetCreationDrafts, revision: verrailTargetCreationDraftRevisions })
      .from(verrailTargetCreationDrafts)
      .innerJoin(verrailTargetCreationDraftRevisions, and(
        eq(verrailTargetCreationDraftRevisions.id, verrailTargetCreationDrafts.activeRevisionId),
        eq(verrailTargetCreationDraftRevisions.workspaceId, verrailTargetCreationDrafts.workspaceId),
      ))
      .where(and(
        eq(verrailTargetCreationDrafts.workspaceId, workspaceId),
        eq(verrailTargetCreationDrafts.conversationId, conversationId),
        eq(verrailTargetCreationDrafts.id, draftId),
      ))
      .then((rows) => rows[0] ?? null);
    return row ? mapDraft(row.draft, row.revision) : null;
  }

  return {
    get,

    list: async (workspaceId: string, conversationId: string) => {
      const rows = await db
        .select({ draft: verrailTargetCreationDrafts, revision: verrailTargetCreationDraftRevisions })
        .from(verrailTargetCreationDrafts)
        .innerJoin(verrailTargetCreationDraftRevisions, and(
          eq(verrailTargetCreationDraftRevisions.id, verrailTargetCreationDrafts.activeRevisionId),
          eq(verrailTargetCreationDraftRevisions.workspaceId, verrailTargetCreationDrafts.workspaceId),
        ))
        .where(and(
          eq(verrailTargetCreationDrafts.workspaceId, workspaceId),
          eq(verrailTargetCreationDrafts.conversationId, conversationId),
        ))
        .orderBy(asc(verrailTargetCreationDrafts.createdAt));
      return rows.map((row) => mapDraft(row.draft, row.revision));
    },

    create: async (
      workspaceId: string,
      conversationId: string,
      input: CreateTargetCreationDraftInput,
      actor: Actor,
    ) => db.transaction(async (tx) => {
      const source = await tx
        .select({ message: verrailConversationMessages, conversation: verrailConversations })
        .from(verrailConversationMessages)
        .innerJoin(verrailConversations, and(
          eq(verrailConversations.id, verrailConversationMessages.conversationId),
          eq(verrailConversations.workspaceId, verrailConversationMessages.workspaceId),
        ))
        .where(and(
          eq(verrailConversationMessages.id, input.sourceMessageId),
          eq(verrailConversationMessages.workspaceId, workspaceId),
          eq(verrailConversationMessages.conversationId, conversationId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!source) throw notFound("Conversation source message not found");
      if (source.conversation.status !== "active") {
        throw conflict("Archived conversations cannot start Target drafts");
      }
      if (
        source.message.role !== "user"
        || source.message.authorPrincipalType !== actor.principalType
        || source.message.authorPrincipalId !== actor.principalId
      ) {
        throw unprocessable("A Target draft must start from the confirming user's explicit message", {
          code: "TARGET_DRAFT_SOURCE_INVALID",
        });
      }

      const definition = mergeDefinition(EMPTY_DEFINITION, input.initial);
      const missing = missingFields(definition);
      const draftId = randomUUID();
      const revisionId = randomUUID();
      const draft = await tx.insert(verrailTargetCreationDrafts).values({
        id: draftId,
        workspaceId,
        conversationId,
        sourceMessageId: input.sourceMessageId,
        initiatedByPrincipalType: actor.principalType,
        initiatedByPrincipalId: actor.principalId,
        status: missing.length === 0 ? "ready_for_confirmation" : "collecting",
        activeRevisionId: revisionId,
        activeRevisionNumber: 1,
      }).returning().then((rows) => rows[0]!);
      const revision = await tx.insert(verrailTargetCreationDraftRevisions).values({
        id: revisionId,
        workspaceId,
        draftId,
        revisionNumber: 1,
        definition: definition as unknown as VerrailTargetDraftDefinitionRecord,
        missingFields: missing,
        fieldSources: input.fieldSources,
        contentHash: contentHash(definition),
        createdByPrincipalType: actor.principalType,
        createdByPrincipalId: actor.principalId,
      }).returning().then((rows) => rows[0]!);
      return mapDraft(draft, revision);
    }),

    update: async (
      workspaceId: string,
      conversationId: string,
      draftId: string,
      input: UpdateTargetCreationDraftInput,
      actor: Actor,
    ) => db.transaction(async (tx) => {
      const current = await tx
        .select({ draft: verrailTargetCreationDrafts, revision: verrailTargetCreationDraftRevisions })
        .from(verrailTargetCreationDrafts)
        .innerJoin(verrailTargetCreationDraftRevisions, eq(
          verrailTargetCreationDraftRevisions.id,
          verrailTargetCreationDrafts.activeRevisionId,
        ))
        .where(and(
          eq(verrailTargetCreationDrafts.workspaceId, workspaceId),
          eq(verrailTargetCreationDrafts.conversationId, conversationId),
          eq(verrailTargetCreationDrafts.id, draftId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Target draft not found");
      if (["converted", "converting", "canceled"].includes(current.draft.status)) {
        throw conflict("Target draft cannot be edited in its current state", { status: current.draft.status });
      }
      if (current.draft.activeRevisionNumber !== input.expectedRevisionNumber) {
        throw conflict("Target draft revision changed", {
          expectedRevisionNumber: input.expectedRevisionNumber,
          activeRevisionNumber: current.draft.activeRevisionNumber,
        });
      }
      const definition = mergeDefinition(current.revision.definition as unknown as TargetDraftDefinition, input.patch);
      const missing = missingFields(definition);
      const revisionNumber = current.draft.activeRevisionNumber + 1;
      const revisionId = randomUUID();
      const revision = await tx.insert(verrailTargetCreationDraftRevisions).values({
        id: revisionId,
        workspaceId,
        draftId,
        revisionNumber,
        definition: definition as unknown as VerrailTargetDraftDefinitionRecord,
        missingFields: missing,
        fieldSources: { ...current.revision.fieldSources, ...input.fieldSources },
        contentHash: contentHash(definition),
        createdByPrincipalType: actor.principalType,
        createdByPrincipalId: actor.principalId,
      }).returning().then((rows) => rows[0]!);
      const draft = await tx.update(verrailTargetCreationDrafts).set({
        activeRevisionId: revisionId,
        activeRevisionNumber: revisionNumber,
        status: missing.length === 0 ? "ready_for_confirmation" : "collecting",
        updatedAt: new Date(),
      }).where(eq(verrailTargetCreationDrafts.id, draftId)).returning().then((rows) => rows[0]!);
      return mapDraft(draft, revision);
    }),

    cancel: async (workspaceId: string, conversationId: string, draftId: string) =>
      db.transaction(async (tx) => {
        const current = await tx
          .select({ draft: verrailTargetCreationDrafts, revision: verrailTargetCreationDraftRevisions })
          .from(verrailTargetCreationDrafts)
          .innerJoin(verrailTargetCreationDraftRevisions, eq(
            verrailTargetCreationDraftRevisions.id,
            verrailTargetCreationDrafts.activeRevisionId,
          ))
          .where(and(
            eq(verrailTargetCreationDrafts.workspaceId, workspaceId),
            eq(verrailTargetCreationDrafts.conversationId, conversationId),
            eq(verrailTargetCreationDrafts.id, draftId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Target draft not found");
        if (current.draft.status === "converted" || current.draft.status === "converting") {
          throw conflict("Target draft conversion cannot be canceled", { status: current.draft.status });
        }
        if (current.draft.status === "canceled") return mapDraft(current.draft, current.revision);
        const draft = await tx.update(verrailTargetCreationDrafts).set({
          status: "canceled",
          updatedAt: new Date(),
        }).where(eq(verrailTargetCreationDrafts.id, draftId)).returning().then((rows) => rows[0]!);
        return mapDraft(draft, current.revision);
      }),

    prepareConfirmation: async (
      workspaceId: string,
      conversationId: string,
      draftId: string,
      expectedRevisionNumber: number,
      actor: Actor,
    ) => db.transaction(async (tx) => {
      const current = await tx
        .select({ draft: verrailTargetCreationDrafts, revision: verrailTargetCreationDraftRevisions })
        .from(verrailTargetCreationDrafts)
        .innerJoin(verrailTargetCreationDraftRevisions, eq(
          verrailTargetCreationDraftRevisions.id,
          verrailTargetCreationDrafts.activeRevisionId,
        ))
        .where(and(
          eq(verrailTargetCreationDrafts.workspaceId, workspaceId),
          eq(verrailTargetCreationDrafts.conversationId, conversationId),
          eq(verrailTargetCreationDrafts.id, draftId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Target draft not found");
      if (current.draft.activeRevisionNumber !== expectedRevisionNumber) {
        throw conflict("Target draft revision changed", {
          expectedRevisionNumber,
          activeRevisionNumber: current.draft.activeRevisionNumber,
        });
      }
      if (
        (current.draft.status === "converting" || current.draft.status === "converted")
        && (
          current.draft.confirmedByPrincipalType !== actor.principalType
          || current.draft.confirmedByPrincipalId !== actor.principalId
        )
      ) {
        throw conflict("Target draft confirmation is already owned by another principal");
      }
      if (current.draft.status === "converted") {
        return { draft: mapDraft(current.draft, current.revision), replayed: true };
      }
      if (current.revision.missingFields.length > 0 || current.draft.status === "collecting") {
        throw unprocessable("Target draft is incomplete", {
          code: "TARGET_DRAFT_INCOMPLETE",
          missingFields: current.revision.missingFields,
        });
      }
      if (current.draft.status === "canceled") throw conflict("Canceled Target draft cannot be confirmed");
      const idempotencyKey = current.draft.conversionIdempotencyKey
        ?? `target-draft:${draftId}:v${expectedRevisionNumber}`;
      const draft = current.draft.status === "converting"
        ? current.draft
        : await tx.update(verrailTargetCreationDrafts).set({
            status: "converting",
            confirmedByPrincipalType: actor.principalType,
            confirmedByPrincipalId: actor.principalId,
            confirmedAt: new Date(),
            conversionIdempotencyKey: idempotencyKey,
            updatedAt: new Date(),
          }).where(eq(verrailTargetCreationDrafts.id, draftId)).returning().then((rows) => rows[0]!);
      return { draft: mapDraft(draft, current.revision), replayed: false };
    }),

    finalizeConfirmation: async (input: {
      workspaceId: string;
      conversationId: string;
      draftId: string;
      targetId: string;
      targetRevisionId: string;
      title: string;
    }) => db.transaction(async (tx) => {
      const draft = await tx.update(verrailTargetCreationDrafts).set({
        status: "converted",
        convertedTargetId: input.targetId,
        convertedTargetRevisionId: input.targetRevisionId,
        updatedAt: new Date(),
      }).where(and(
        eq(verrailTargetCreationDrafts.workspaceId, input.workspaceId),
        eq(verrailTargetCreationDrafts.conversationId, input.conversationId),
        eq(verrailTargetCreationDrafts.id, input.draftId),
      )).returning().then((rows) => rows[0] ?? null);
      if (!draft) throw notFound("Target draft not found");
      await tx.insert(verrailConversationContextBindings).values([
        {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          contextType: "target",
          contextId: input.targetId,
          label: input.title,
          href: `/targets/${input.targetId}/overview`,
        },
        {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          contextType: "target_revision",
          contextId: input.targetRevisionId,
          label: `Target revision ${input.targetRevisionId.slice(0, 8)}`,
          href: `/targets/${input.targetId}/revisions/${input.targetRevisionId}`,
        },
      ]).onConflictDoNothing();
      return draft;
    }),
  };
}

export function providerConversationBindingService(db: Db) {
  return {
    create: async (
      workspaceId: string,
      input: CreateProviderConversationBindingInput,
      actor: Actor,
    ): Promise<ProviderConversationBinding> => {
      const conversation = await db.select({ id: verrailConversations.id }).from(verrailConversations).where(and(
        eq(verrailConversations.workspaceId, workspaceId),
        eq(verrailConversations.id, input.conversationId),
      )).then((rows) => rows[0] ?? null);
      if (!conversation) throw notFound("Conversation not found");
      const inserted = await db.insert(verrailProviderConversationBindings).values({
        workspaceId,
        ...input,
        createdByPrincipalType: actor.principalType,
        createdByPrincipalId: actor.principalId,
      }).onConflictDoNothing().returning().then((rows) => rows[0] ?? null);
      if (inserted) return {
        ...inserted,
        externalConversationType: inserted.externalConversationType as "group" | "direct",
      };
      const existing = await db.select().from(verrailProviderConversationBindings).where(and(
        eq(verrailProviderConversationBindings.workspaceId, workspaceId),
        eq(verrailProviderConversationBindings.connectionId, input.connectionId),
        eq(verrailProviderConversationBindings.externalConversationId, input.externalConversationId),
      )).then((rows) => rows[0] ?? null);
      if (existing?.conversationId === input.conversationId) return existing as ProviderConversationBinding;
      throw conflict("Provider conversation identity is already bound", {
        code: "PROVIDER_CONVERSATION_ALREADY_BOUND",
      });
    },

    resolve: async (workspaceId: string, connectionId: string, externalConversationId: string) =>
      db.select().from(verrailProviderConversationBindings).where(and(
        eq(verrailProviderConversationBindings.workspaceId, workspaceId),
        eq(verrailProviderConversationBindings.connectionId, connectionId),
        eq(verrailProviderConversationBindings.externalConversationId, externalConversationId),
      )).then((rows) => rows[0] ?? null),
  };
}
