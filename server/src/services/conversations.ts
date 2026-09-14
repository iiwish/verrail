import { and, asc, desc, eq, exists, ilike, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  verrailConversationContextBindings,
  verrailConversationMessages,
  verrailConversations,
  verrailTargetCreationDrafts,
} from "@paperclipai/db";
import type {
  Conversation,
  ConversationContextBinding,
  ConversationDetail,
  ConversationListQuery,
  ConversationMessage,
  CreateConversationInput,
  UpdateConversationInput,
} from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { readConversationTarget, switchConversationContext } from "./conversation-context.js";

type ConversationActor = {
  principalType: "user" | "agent";
  principalId: string;
};

function mapConversation(row: typeof verrailConversations.$inferSelect): Conversation {
  return {
    ...row,
    status: row.status as Conversation["status"],
  };
}

function mapMessage(row: typeof verrailConversationMessages.$inferSelect): ConversationMessage {
  return {
    ...row,
    role: row.role as ConversationMessage["role"],
    status: row.status as ConversationMessage["status"],
    metadata: row.metadata ?? null,
  };
}

function mapBinding(row: typeof verrailConversationContextBindings.$inferSelect): ConversationContextBinding {
  return {
    ...row,
    contextType: row.contextType as ConversationContextBinding["contextType"],
  };
}

function deriveTitle(body: string) {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77).trimEnd()}...`;
}

export function conversationService(db: Db) {
  async function findConversation(workspaceId: string, conversationId: string) {
    return db
      .select()
      .from(verrailConversations)
      .where(and(
        eq(verrailConversations.id, conversationId),
        eq(verrailConversations.workspaceId, workspaceId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  return {
    list: async (workspaceId: string, query: ConversationListQuery): Promise<Conversation[]> => {
      const where = query.q
        ? and(
            eq(verrailConversations.workspaceId, workspaceId),
            eq(verrailConversations.status, query.status),
            ilike(verrailConversations.title, `%${query.q}%`),
          )
        : and(
            eq(verrailConversations.workspaceId, workspaceId),
            eq(verrailConversations.status, query.status),
          );
      const rows = await db
        .select()
        .from(verrailConversations)
        .where(and(where, query.targetId ? exists(db.select({ id: verrailConversationContextBindings.id }).from(verrailConversationContextBindings).where(and(
          eq(verrailConversationContextBindings.workspaceId, workspaceId),
          eq(verrailConversationContextBindings.conversationId, verrailConversations.id),
          eq(verrailConversationContextBindings.contextType, "target"),
          eq(verrailConversationContextBindings.contextId, query.targetId),
        ))) : undefined, query.agentId ? exists(db.select({ id: verrailConversationMessages.id }).from(verrailConversationMessages).where(and(
          eq(verrailConversationMessages.workspaceId, workspaceId),
          eq(verrailConversationMessages.conversationId, verrailConversations.id),
          eq(verrailConversationMessages.role, "assistant"),
          eq(verrailConversationMessages.authorPrincipalType, "agent"),
          eq(verrailConversationMessages.authorPrincipalId, query.agentId),
        ))) : undefined))
        .orderBy(
          sql`${verrailConversations.pinnedAt} desc nulls last`,
          desc(sql`coalesce(${verrailConversations.lastMessageAt}, ${verrailConversations.createdAt})`),
          asc(verrailConversations.id),
        );
      const sources = query.targetId ? await db.select({ conversationId: verrailTargetCreationDrafts.conversationId }).from(verrailTargetCreationDrafts)
        .where(and(eq(verrailTargetCreationDrafts.workspaceId, workspaceId), eq(verrailTargetCreationDrafts.convertedTargetId, query.targetId), eq(verrailTargetCreationDrafts.status, "converted"))) : [];
      const sourceIds = new Set(sources.map(row => row.conversationId));
      return rows.map(row => ({ ...mapConversation(row), ...(query.targetId ? { targetRelation: sourceIds.has(row.id) ? "source" as const : "related" as const } : {}) }));
    },

    create: async (
      workspaceId: string,
      input: CreateConversationInput,
      actor: ConversationActor,
      options: { trustedContext?: boolean; initialTargetId?: string } = {},
    ): Promise<ConversationDetail> => {
      if (input.contextBindings.length > 0 && !options.trustedContext) {
        throw forbidden("Conversation context bindings are server-owned", {
          code: "CONVERSATION_CONTEXT_BINDING_FORBIDDEN",
        });
      }
      return db.transaction(async (tx) => {
        const conversation = await tx
          .insert(verrailConversations)
          .values({
            workspaceId,
            title: input.title ?? "New conversation",
            createdByPrincipalType: actor.principalType,
            createdByPrincipalId: actor.principalId,
          })
          .returning()
          .then((rows) => rows[0]!);
        const contextBindings = input.contextBindings.length > 0
          ? await tx
              .insert(verrailConversationContextBindings)
              .values(input.contextBindings.map((binding) => ({
                workspaceId,
                conversationId: conversation.id,
                contextType: binding.contextType,
                contextId: binding.contextId,
                label: binding.label ?? null,
                href: binding.href ?? null,
              })))
              .returning()
          : [];
        if (options.initialTargetId) {
          if (actor.principalType !== "user") throw forbidden("A human Workspace member is required");
          await switchConversationContext(tx, { workspaceId, conversationId: conversation.id, principalId: actor.principalId }, { targetId: options.initialTargetId, expectedContextVersion: 0, idempotencyKey: "conversation-created" });
        }
        return {
          ...mapConversation(conversation),
          currentTargetId: options.initialTargetId ?? null,
          contextVersion: options.initialTargetId ? 1 : 0,
          currentTarget: await readConversationTarget(tx, workspaceId, options.initialTargetId ?? null),
          contextBindings: options.initialTargetId
            ? (await tx.select().from(verrailConversationContextBindings).where(and(eq(verrailConversationContextBindings.workspaceId, workspaceId), eq(verrailConversationContextBindings.conversationId, conversation.id)))).map(mapBinding)
            : contextBindings.map(mapBinding),
          messages: options.initialTargetId
            ? (await tx.select().from(verrailConversationMessages).where(and(eq(verrailConversationMessages.workspaceId, workspaceId), eq(verrailConversationMessages.conversationId, conversation.id)))).map(mapMessage)
            : [],
        };
      });
    },

    get: async (workspaceId: string, conversationId: string): Promise<ConversationDetail | null> => {
      const row = await findConversation(workspaceId, conversationId);
      if (!row) return null;
      const [messages, bindings] = await Promise.all([
        db
          .select()
          .from(verrailConversationMessages)
          .where(and(
            eq(verrailConversationMessages.workspaceId, workspaceId),
            eq(verrailConversationMessages.conversationId, conversationId),
          ))
          .orderBy(asc(verrailConversationMessages.createdAt)),
        db
          .select()
          .from(verrailConversationContextBindings)
          .where(and(
            eq(verrailConversationContextBindings.workspaceId, workspaceId),
            eq(verrailConversationContextBindings.conversationId, conversationId),
          ))
          .orderBy(asc(verrailConversationContextBindings.createdAt)),
      ]);
      return {
        ...mapConversation(row),
        currentTarget: await readConversationTarget(db, workspaceId, row.currentTargetId),
        messages: messages.map(mapMessage),
        contextBindings: bindings.map(mapBinding),
      };
    },

    update: async (
      workspaceId: string,
      conversationId: string,
      input: UpdateConversationInput,
    ): Promise<Conversation | null> => {
      const patch: Partial<typeof verrailConversations.$inferInsert> = { updatedAt: new Date() };
      if (input.title !== undefined) patch.title = input.title;
      if (input.status !== undefined) patch.status = input.status;
      if (input.pinned !== undefined) patch.pinnedAt = input.pinned ? new Date() : null;
      const row = await db
        .update(verrailConversations)
        .set(patch)
        .where(and(
          eq(verrailConversations.id, conversationId),
          eq(verrailConversations.workspaceId, workspaceId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? mapConversation(row) : null;
    },

    appendMessage: async (
      workspaceId: string,
      conversationId: string,
      input: {
        role: ConversationMessage["role"];
        body: string;
        status?: ConversationMessage["status"];
        actor?: ConversationActor;
        metadata?: Record<string, unknown> | null;
      },
    ): Promise<ConversationMessage | null> => {
      return db.transaction(async (tx) => {
        const conversation = await tx
          .select()
          .from(verrailConversations)
          .where(and(
            eq(verrailConversations.id, conversationId),
            eq(verrailConversations.workspaceId, workspaceId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!conversation) return null;
        if (conversation.status === "archived") {
          throw conflict("Archived conversations must be restored before sending messages", {
            code: "CONVERSATION_ARCHIVED",
          });
        }
        const now = new Date();
        if (input.role === "tool" && input.metadata?.kind === "director_target_proposal" && typeof input.metadata.targetId === "string") {
          const [source] = typeof input.metadata.sourceMessageId === "string"
            ? await tx.select().from(verrailConversationMessages).where(and(eq(verrailConversationMessages.workspaceId, workspaceId), eq(verrailConversationMessages.conversationId, conversationId), eq(verrailConversationMessages.id, input.metadata.sourceMessageId))) : [];
          const context = source?.metadata?.conversationContext as { contextVersion?: number } | undefined;
          // A late reply retains its provenance, but cannot undo a newer unlink or focus change.
          if (context?.contextVersion === conversation.contextVersion) {
            const target = await readConversationTarget(tx, workspaceId, input.metadata.targetId);
            if (target) await tx.insert(verrailConversationContextBindings).values({ workspaceId, conversationId, contextType: "target", contextId: target.targetId, label: target.title, href: `/targets/${target.targetId}/overview` }).onConflictDoNothing();
          }
        }
        const message = await tx
          .insert(verrailConversationMessages)
          .values({
            workspaceId,
            conversationId,
            role: input.role,
            body: input.body,
            status: input.status ?? "complete",
            authorPrincipalType: input.actor?.principalType ?? null,
            authorPrincipalId: input.actor?.principalId ?? null,
            metadata: input.role === "user" ? { ...input.metadata, conversationContext: { currentTargetId: conversation.currentTargetId, contextVersion: conversation.contextVersion } } : input.metadata ?? null,
          })
          .returning()
          .then((rows) => rows[0]!);
        await tx
          .update(verrailConversations)
          .set({
            title:
              input.role === "user" && conversation.title === "New conversation"
                ? deriveTitle(input.body)
                : conversation.title,
            lastMessageAt: now,
            updatedAt: now,
          })
          .where(eq(verrailConversations.id, conversationId));
        return mapMessage(message);
      });
    },
  };
}
