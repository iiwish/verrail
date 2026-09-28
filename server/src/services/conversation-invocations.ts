import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, companies, companyMemberships, verrailConversations, verrailConversationMessages, verrailConversationInvocations as invocations, verrailConversationInvocationEvents as events, type Db } from "@paperclipai/db";
import { conversationInvocationEventSchema, startConversationInvocationSchema, type ConversationInvocationStatus, type StartConversationInvocationInput } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { reduceConversationInvocation } from "./conversation-invocation-state.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Scope = { workspaceId: string; conversationId: string; principalId: string };
const ACTIVE = ["queued", "running", "cancel_requested"];
const snapshotSchema = z.object({
  agentVersionId: z.string().uuid(), deploymentRevisionId: z.string().uuid(),
  assistantAgentId: z.string().uuid(), runtime: z.literal("opencode"),
  model: z.string().regex(/^[^/\s]+\/.+$/).max(200),
  systemPrompt: z.string().min(1).max(80_000),
}).strict();
export type ConversationInvocationSnapshot = z.infer<typeof snapshotSchema>;

async function member(db: Db | Tx, scope: Scope, write: boolean) {
  const [row] = await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships)
    .innerJoin(companies, and(eq(companies.id, companyMemberships.companyId), eq(companies.status, "active")))
    .where(and(eq(companyMemberships.companyId, scope.workspaceId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, scope.principalId), eq(companyMemberships.status, "active"))).for("share");
  if (!row || (write && row.role === "viewer")) throw forbidden("Workspace membership does not permit this operation");
}

const scopeWhere = (scope: Scope, id: string) => and(eq(invocations.id, id), eq(invocations.workspaceId, scope.workspaceId), eq(invocations.conversationId, scope.conversationId));

export function conversationInvocationService(db: Db, now = () => new Date()) {
  return {
    async list(scope: Scope) {
      return db.transaction(async tx => {
        await member(tx, scope, false);
        const [conversation] = await tx.select({ id: verrailConversations.id }).from(verrailConversations).where(and(eq(verrailConversations.id, scope.conversationId), eq(verrailConversations.workspaceId, scope.workspaceId)));
        if (!conversation) throw notFound("Conversation not found");
        return tx.select().from(invocations).where(and(eq(invocations.workspaceId, scope.workspaceId), eq(invocations.conversationId, scope.conversationId))).orderBy(desc(invocations.createdAt), desc(invocations.id)).limit(20);
      });
    },
    async replay(scope: Scope, raw: StartConversationInvocationInput) {
      const input = startConversationInvocationSchema.parse(raw);
      const requestHash = createHash("sha256").update(JSON.stringify({ conversationId: scope.conversationId, body: input.body })).digest("hex");
      return db.transaction(async tx => {
        await member(tx, scope, true);
        const [row] = await tx.select().from(invocations).where(and(eq(invocations.workspaceId, scope.workspaceId), eq(invocations.principalId, scope.principalId), eq(invocations.idempotencyKey, input.idempotencyKey)));
        if (row && row.requestHash !== requestHash) throw conflict("Invocation idempotency key was already used");
        return row ?? null;
      });
    },
    async begin(scope: Scope, raw: StartConversationInvocationInput, snapshot: ConversationInvocationSnapshot) {
      const input = startConversationInvocationSchema.parse(raw);
      snapshot = snapshotSchema.parse(snapshot);
      const requestHash = createHash("sha256").update(JSON.stringify({ conversationId: scope.conversationId, body: input.body })).digest("hex");
      return db.transaction(async tx => {
        await member(tx, scope, true);
        // Serializes workspace admission and idempotency checks across conversations.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`conversation-invocation:${scope.workspaceId}`}, 0))`);
        const [existing] = await tx.select().from(invocations).where(and(eq(invocations.workspaceId, scope.workspaceId), eq(invocations.principalId, scope.principalId), eq(invocations.idempotencyKey, input.idempotencyKey)));
        if (existing) {
          if (existing.requestHash !== requestHash) throw conflict("Invocation idempotency key was already used");
          return { invocation: existing, replayed: true };
        }
        const [conversation] = await tx.select().from(verrailConversations).where(and(eq(verrailConversations.id, scope.conversationId), eq(verrailConversations.workspaceId, scope.workspaceId))).for("update");
        if (!conversation) throw notFound("Conversation not found");
        if (conversation.status !== "active") throw conflict("Restore the conversation before executing");
        const active = await tx.select({ id: invocations.id, conversationId: invocations.conversationId }).from(invocations).where(and(eq(invocations.workspaceId, scope.workspaceId), inArray(invocations.status, ACTIVE))).limit(3);
        if (active.length >= 3 || active.some(row => row.conversationId === scope.conversationId)) throw conflict("Conversation execution is busy");
        const history = await tx.select({ role: verrailConversationMessages.role, body: verrailConversationMessages.body, metadata: verrailConversationMessages.metadata }).from(verrailConversationMessages)
          .where(and(eq(verrailConversationMessages.workspaceId, scope.workspaceId), eq(verrailConversationMessages.conversationId, scope.conversationId), inArray(verrailConversationMessages.role, ["user", "assistant"])))
          .orderBy(desc(verrailConversationMessages.createdAt), desc(verrailConversationMessages.id)).limit(30);
        const context = { currentTargetId: conversation.currentTargetId, contextVersion: conversation.contextVersion };
        const timestamp = now();
        const [message] = await tx.insert(verrailConversationMessages).values({ workspaceId: scope.workspaceId, conversationId: scope.conversationId, role: "user", body: input.body, authorPrincipalType: "user", authorPrincipalId: scope.principalId, metadata: { conversationContext: context } }).returning();
        const payload = { ...snapshot, history: history.reverse(), body: input.body, conversationContext: context };
        if (Buffer.byteLength(JSON.stringify(payload)) > 512_000) throw conflict("Conversation context exceeds execution limit");
        const [invocation] = await tx.insert(invocations).values({ ...scope, sourceMessageId: message.id, agentVersionId: snapshot.agentVersionId, deploymentRevisionId: snapshot.deploymentRevisionId, idempotencyKey: input.idempotencyKey, requestHash, input: payload }).returning();
        await tx.update(verrailConversations).set({ lastMessageAt: timestamp, updatedAt: timestamp }).where(eq(verrailConversations.id, scope.conversationId));
        await tx.insert(activityLog).values({ companyId: scope.workspaceId, actorType: "user", actorId: scope.principalId, action: "conversation.invocation_created", entityType: "conversation", entityId: scope.conversationId, details: { invocationId: invocation.id, sourceMessageId: message.id, agentVersionId: snapshot.agentVersionId } });
        return { invocation, replayed: false };
      });
    },
    async read(scope: Scope, id: string, after = 0) {
      if (!Number.isSafeInteger(after) || after < 0) throw conflict("Invalid event cursor");
      return db.transaction(async tx => {
        await member(tx, scope, false);
        const [invocation] = await tx.select().from(invocations).where(scopeWhere(scope, id)).for("share");
        if (!invocation) throw notFound("Invocation not found");
        const replay = await tx.select().from(events).where(and(eq(events.workspaceId, scope.workspaceId), eq(events.invocationId, id), gt(events.cursor, after))).orderBy(asc(events.cursor)).limit(200);
        return { invocation, events: replay };
      });
    },
    async cancel(scope: Scope, id: string) {
      return db.transaction(async tx => {
        await member(tx, scope, true);
        const [invocation] = await tx.select().from(invocations).where(scopeWhere(scope, id)).for("update");
        if (!invocation || invocation.principalId !== scope.principalId) throw notFound("Invocation not found");
        if (invocation.finishedAt || invocation.status === "cancel_requested") return invocation;
        const [updated] = await tx.update(invocations).set({ status: "cancel_requested", updatedAt: now() }).where(eq(invocations.id, id)).returning();
        await tx.insert(activityLog).values({ companyId: scope.workspaceId, actorType: "user", actorId: scope.principalId, action: "conversation.invocation_cancel_requested", entityType: "conversation", entityId: scope.conversationId, details: { invocationId: id } });
        return updated;
      });
    },
    async claim(workspaceId: string, id: string, controllerId: string) {
      if (!controllerId || controllerId.length > 200) throw conflict("Invalid controller identity");
      return db.transaction(async tx => {
        const [row] = await tx.select().from(invocations).where(and(eq(invocations.id, id), eq(invocations.workspaceId, workspaceId))).for("update");
        if (!row) throw notFound("Invocation not found");
        if (row.finishedAt) return row;
        const timestamp = now();
        if (row.leaseExpiresAt && row.leaseExpiresAt > timestamp && row.controllerId !== controllerId) throw conflict("Invocation controller lease is held");
        const fencingToken = row.controllerId === controllerId && row.leaseExpiresAt && row.leaseExpiresAt > timestamp ? row.fencingToken : row.fencingToken + 1;
        const [updated] = await tx.update(invocations).set({ controllerId, fencingToken, leaseExpiresAt: new Date(timestamp.getTime() + 30_000), updatedAt: timestamp }).where(eq(invocations.id, id)).returning();
        return updated;
      });
    },
    async prepareDispatch(scope: { workspaceId: string; invocationId: string; controllerId: string; fencingToken: number }) {
      return db.transaction(async tx => {
        const [row] = await tx.select().from(invocations).where(and(eq(invocations.id, scope.invocationId), eq(invocations.workspaceId, scope.workspaceId))).for("update");
        if (!row || row.finishedAt || row.status === "cancel_requested" || row.controllerId !== scope.controllerId || row.fencingToken !== scope.fencingToken || !row.leaseExpiresAt || row.leaseExpiresAt <= now()) throw conflict("Invocation dispatch lease is unavailable");
        const [attempt] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, row.workspaceId), eq(activityLog.entityType, "conversation_invocation"), eq(activityLog.entityId, row.id), eq(activityLog.action, "conversation.invocation_dispatch_started"))).limit(1);
        if (attempt) return false;
        await member(tx, row, true);
        await tx.insert(activityLog).values({ companyId: row.workspaceId, actorType: "system", actorId: scope.controllerId, action: "conversation.invocation_dispatch_started", entityType: "conversation_invocation", entityId: row.id, details: { fencingToken: row.fencingToken, agentVersionId: row.agentVersionId } });
        return true;
      });
    },
    async wasDispatched(workspaceId: string, invocationId: string) {
      const [attempt] = await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, workspaceId), eq(activityLog.entityType, "conversation_invocation"), eq(activityLog.entityId, invocationId), eq(activityLog.action, "conversation.invocation_dispatch_started"))).limit(1);
      return Boolean(attempt);
    },
    async append(scope: { workspaceId: string; invocationId: string; controllerId: string; fencingToken: number }, cursor: number, rawEvent: unknown) {
      if (!Number.isSafeInteger(cursor) || cursor < 1) throw conflict("Invalid event cursor");
      const event = conversationInvocationEventSchema.parse(rawEvent);
      return db.transaction(async tx => {
        const [row] = await tx.select().from(invocations).where(and(eq(invocations.id, scope.invocationId), eq(invocations.workspaceId, scope.workspaceId))).for("update");
        if (!row) throw notFound("Invocation not found");
        const timestamp = now();
        if (row.fencingToken !== scope.fencingToken || row.controllerId !== scope.controllerId || !row.leaseExpiresAt || row.leaseExpiresAt <= timestamp) throw conflict("Invocation controller lease expired");
        if (cursor <= row.lastEventCursor) {
          const [previous] = await tx.select().from(events).where(and(eq(events.invocationId, row.id), eq(events.cursor, cursor)));
          if (!previous || previous.type !== event.type || JSON.stringify(conversationInvocationEventSchema.parse({ type: previous.type, data: previous.data })) !== JSON.stringify(event)) throw conflict("Invocation event cursor was reused");
          return row;
        }
        if (cursor !== row.lastEventCursor + 1) throw conflict("Invocation event cursor gap");
        const state = reduceConversationInvocation({ ...row, status: row.status as ConversationInvocationStatus }, event, timestamp);
        await tx.insert(events).values({ workspaceId: scope.workspaceId, invocationId: row.id, cursor, type: event.type, data: event.data });
        const [updated] = await tx.update(invocations).set({ ...state, lastEventCursor: cursor, updatedAt: timestamp }).where(eq(invocations.id, row.id)).returning();
        if (state.finishedAt) {
          if (state.output) await tx.insert(verrailConversationMessages).values({ workspaceId: row.workspaceId, conversationId: row.conversationId, role: "assistant", status: state.status === "succeeded" ? "complete" : "failed", body: state.output, authorPrincipalType: "agent", authorPrincipalId: typeof row.input.assistantAgentId === "string" ? row.input.assistantAgentId : null, metadata: { invocationId: row.id, sourceMessageId: row.sourceMessageId, agentVersionId: row.agentVersionId, deploymentRevisionId: row.deploymentRevisionId, conversationContext: row.input.conversationContext ?? null } });
          await tx.update(verrailConversations).set({ lastMessageAt: timestamp, updatedAt: timestamp }).where(eq(verrailConversations.id, row.conversationId));
          await tx.insert(activityLog).values({ companyId: row.workspaceId, actorType: "system", actorId: scope.controllerId, action: "conversation.invocation_finished", entityType: "conversation", entityId: row.conversationId, details: { invocationId: row.id, status: state.status, errorCode: state.errorCode } });
        }
        return updated;
      });
    },
  };
}
