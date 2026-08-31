import { and, asc, desc, eq, ilike } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  verrailConversationContextBindings,
  verrailConversationMessages,
  verrailConversations,
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
import { conflict } from "../errors.js";

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
        .where(where)
        .orderBy(
          desc(verrailConversations.pinnedAt),
          desc(verrailConversations.lastMessageAt),
          desc(verrailConversations.updatedAt),
        );
      return rows.map(mapConversation);
    },

    create: async (
      workspaceId: string,
      input: CreateConversationInput,
      actor: ConversationActor,
    ): Promise<ConversationDetail> => {
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
        return {
          ...mapConversation(conversation),
          contextBindings: contextBindings.map(mapBinding),
          messages: [],
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
          .then((rows) => rows[0] ?? null);
        if (!conversation) return null;
        if (conversation.status === "archived") {
          throw conflict("Archived conversations must be restored before sending messages", {
            code: "CONVERSATION_ARCHIVED",
          });
        }
        const now = new Date();
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
            metadata: input.metadata ?? null,
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
