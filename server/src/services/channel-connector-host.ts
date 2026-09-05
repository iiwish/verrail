import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  verrailChannelEvents,
  verrailConversationMessages,
  verrailConversations,
  verrailProviderConversationBindings,
  verrailTargetCreationDraftRevisions,
  verrailTargetCreationDrafts,
  type Db,
  type VerrailTargetDraftDefinitionRecord,
} from "@paperclipai/db";
import type {
  ChannelConnectionBindingV1,
  ChannelMessageEventV1,
  TargetDraftDefinition,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";

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

const EMPTY_MISSING_FIELDS = ["title", "goal", "outcomeOwner", "acceptanceCriteria", "riskLevel"];

function stableUuid(namespace: string, value: string) {
  const bytes = createHash("sha256").update(`${namespace}\0${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function eventKey(input: ChannelConnectorIngestInput) {
  return JSON.stringify([
    input.workspaceId,
    input.connectorKey,
    input.connectionId,
    input.event.providerEventId,
  ]);
}

function externalPrincipalId(connectorKey: string, providerUserId: string) {
  return `provider:${connectorKey}:${providerUserId}`;
}

export interface ChannelConnectorIngestInput {
  workspaceId: string;
  connectorKey: string;
  connectionId: string;
  connection: ChannelConnectionBindingV1;
  event: ChannelMessageEventV1;
}

export interface ChannelConnectorIngestResult {
  duplicate: boolean;
  conversationId: string;
  messageId: string;
  draftId: string | null;
  authorizedUserId: string | null;
  replyProviderMessageId: string | null;
}

export function channelConnectorHostService(db: Db) {
  return {
    ingest: async (input: ChannelConnectorIngestInput): Promise<ChannelConnectorIngestResult> => {
      if (
        input.connection.contractVersion !== 1
        || input.connection.connectorKey !== input.connectorKey
        || input.connection.connectionId !== input.connectionId
      ) {
        throw unprocessable("Channel connection does not match the webhook scope", {
          code: "CHANNEL_CONNECTION_SCOPE_MISMATCH",
        });
      }

      const mappedUserId = input.connection.authorizedUsers.find(
        (binding) => binding.providerUserId === input.event.author.providerUserId,
      )?.userId ?? null;
      if (input.event.intent?.kind === "create_target_draft" || input.connection.transport === "long_connection") {
        if (!mappedUserId) {
          throw forbidden("The Feishu user is not authorized to create a Target draft", {
            code: "CHANNEL_USER_NOT_AUTHORIZED",
          });
        }
        const membership = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
          eq(companyMemberships.companyId, input.workspaceId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, mappedUserId),
          eq(companyMemberships.status, "active"),
        )).then((rows) => rows[0] ?? null);
        if (!membership) {
          throw forbidden("The mapped Verrail user is not an active Workspace member", {
            code: "CHANNEL_USER_MEMBERSHIP_INACTIVE",
          });
        }
      }

      const key = eventKey(input);
      const conversationId = stableUuid("channel-conversation", JSON.stringify([
        input.workspaceId,
        input.connectorKey,
        input.connectionId,
        input.event.conversation.externalConversationId,
      ]));
      const messageId = stableUuid("channel-message", key);
      const draftId = input.event.intent ? stableUuid("channel-target-draft", key) : null;
      const draftRevisionId = draftId ? stableUuid("channel-target-draft-revision", key) : null;
      const eventId = stableUuid("channel-event", key);
      const authorId = mappedUserId ?? externalPrincipalId(input.connectorKey, input.event.author.providerUserId);

      return db.transaction(async (tx) => {
        const claimed = await tx.insert(verrailChannelEvents).values({
          id: eventId,
          workspaceId: input.workspaceId,
          connectorKey: input.connectorKey,
          connectionId: input.connectionId,
          providerEventId: input.event.providerEventId,
          externalConversationType: input.event.conversation.type,
          externalConversationId: input.event.conversation.externalConversationId,
          providerUserId: input.event.author.providerUserId,
          conversationId,
          messageId,
          draftId,
          occurredAt: input.event.occurredAt ? new Date(input.event.occurredAt) : null,
        }).onConflictDoNothing().returning({ id: verrailChannelEvents.id });

        if (claimed.length === 0) {
          const existing = await tx.select().from(verrailChannelEvents).where(and(
            eq(verrailChannelEvents.workspaceId, input.workspaceId),
            eq(verrailChannelEvents.connectorKey, input.connectorKey),
            eq(verrailChannelEvents.connectionId, input.connectionId),
            eq(verrailChannelEvents.providerEventId, input.event.providerEventId),
          )).then((rows) => rows[0]!);
          return {
            duplicate: true,
            conversationId: existing.conversationId,
            messageId: existing.messageId,
            draftId: existing.draftId,
            authorizedUserId: mappedUserId,
            replyProviderMessageId: existing.replyProviderMessageId,
          };
        }

        await tx.insert(verrailConversations).values({
          id: conversationId,
          workspaceId: input.workspaceId,
          title: input.event.content.text.replace(/\s+/g, " ").trim().slice(0, 80),
          createdByPrincipalType: "user",
          createdByPrincipalId: authorId,
          lastMessageAt: new Date(),
        }).onConflictDoNothing();

        await tx.insert(verrailProviderConversationBindings).values({
          workspaceId: input.workspaceId,
          conversationId,
          providerKey: input.connectorKey,
          connectionId: input.connectionId,
          externalConversationType: input.event.conversation.type,
          externalConversationId: input.event.conversation.externalConversationId,
          createdByPrincipalType: "user",
          createdByPrincipalId: authorId,
        }).onConflictDoNothing();

        const binding = await tx.select().from(verrailProviderConversationBindings).where(and(
          eq(verrailProviderConversationBindings.workspaceId, input.workspaceId),
          eq(verrailProviderConversationBindings.connectionId, input.connectionId),
          eq(verrailProviderConversationBindings.externalConversationId, input.event.conversation.externalConversationId),
        )).then((rows) => rows[0] ?? null);
        if (!binding || binding.conversationId !== conversationId || binding.providerKey !== input.connectorKey) {
          throw unprocessable("Provider conversation is bound to a different scope", {
            code: "CHANNEL_CONVERSATION_SCOPE_MISMATCH",
          });
        }

        await tx.insert(verrailConversationMessages).values({
          id: messageId,
          workspaceId: input.workspaceId,
          conversationId,
          role: "user",
          status: "complete",
          body: input.event.content.text,
          authorPrincipalType: "user",
          authorPrincipalId: authorId,
          metadata: {
            channelConnector: input.connectorKey,
            providerEventId: input.event.providerEventId,
            providerMessageId: input.event.replyContext.providerMessageId,
          },
        });
        await tx.update(verrailConversations).set({
          lastMessageAt: new Date(),
          updatedAt: new Date(),
        }).where(and(
          eq(verrailConversations.workspaceId, input.workspaceId),
          eq(verrailConversations.id, conversationId),
        ));

        if (draftId && draftRevisionId && mappedUserId) {
          await tx.insert(verrailTargetCreationDrafts).values({
            id: draftId,
            workspaceId: input.workspaceId,
            conversationId,
            sourceMessageId: messageId,
            initiatedByPrincipalType: "user",
            initiatedByPrincipalId: mappedUserId,
            status: "collecting",
            activeRevisionId: draftRevisionId,
            activeRevisionNumber: 1,
          });
          await tx.insert(verrailTargetCreationDraftRevisions).values({
            id: draftRevisionId,
            workspaceId: input.workspaceId,
            draftId,
            revisionNumber: 1,
            definition: EMPTY_DEFINITION as unknown as VerrailTargetDraftDefinitionRecord,
            missingFields: EMPTY_MISSING_FIELDS,
            fieldSources: {},
            contentHash: createHash("sha256").update(JSON.stringify(EMPTY_DEFINITION)).digest("hex"),
            createdByPrincipalType: "user",
            createdByPrincipalId: mappedUserId,
          });
        }

        return {
          duplicate: false,
          conversationId,
          messageId,
          draftId,
          authorizedUserId: mappedUserId,
          replyProviderMessageId: null,
        };
      });
    },

    recordReply: async (input: {
      workspaceId: string;
      connectorKey: string;
      connectionId: string;
      providerEventId: string;
      providerMessageId: string;
    }) => {
      const row = await db.update(verrailChannelEvents).set({
        replyProviderMessageId: input.providerMessageId,
      }).where(and(
        eq(verrailChannelEvents.workspaceId, input.workspaceId),
        eq(verrailChannelEvents.connectorKey, input.connectorKey),
        eq(verrailChannelEvents.connectionId, input.connectionId),
        eq(verrailChannelEvents.providerEventId, input.providerEventId),
      )).returning({ replyProviderMessageId: verrailChannelEvents.replyProviderMessageId })
        .then((rows) => rows[0] ?? null);
      if (!row) throw unprocessable("Channel event was not found while recording its reply", {
        code: "CHANNEL_EVENT_NOT_FOUND",
      });
      return row.replyProviderMessageId;
    },
  };
}
