import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  activityLog, companies, companyMemberships, verrailConversations, verrailConversationContextBindings,
  verrailConversationContextChanges, verrailConversationMessages, verrailTargets, verrailTargetRevisions,
  type Db,
} from "@paperclipai/db";
import { switchConversationContextSchema, type SwitchConversationContextInput, type SwitchConversationContextResult } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";

type ContextDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export async function readConversationTarget(db: ContextDb, workspaceId: string, targetId: string | null) {
  if (!targetId) return null;
  const [target] = await db.select({ targetId: verrailTargets.id, title: verrailTargetRevisions.title, archivedAt: verrailTargets.archivedAt })
    .from(verrailTargets).innerJoin(verrailTargetRevisions, and(eq(verrailTargetRevisions.id, verrailTargets.activeTargetRevisionId), eq(verrailTargetRevisions.workspaceId, workspaceId)))
    .where(and(eq(verrailTargets.workspaceId, workspaceId), eq(verrailTargets.id, targetId)));
  return target ? { ...target, archivedAt: target.archivedAt?.toISOString() ?? null } : null;
}

// The caller owns the transaction, allowing creation finalization and focus to commit together.
export async function switchConversationContext(tx: ContextDb, scope: {
  workspaceId: string; conversationId: string; principalId: string;
  sourceMessageId?: string; agentId?: string;
}, input: SwitchConversationContextInput): Promise<SwitchConversationContextResult> {
  input = switchConversationContextSchema.parse(input);
  const [member] = await tx.select({ role: companyMemberships.membershipRole }).from(companyMemberships)
    .innerJoin(companies, and(eq(companies.id, companyMemberships.companyId), eq(companies.status, "active")))
    .where(and(eq(companyMemberships.companyId, scope.workspaceId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, scope.principalId), eq(companyMemberships.status, "active"))).for("share");
  if (!member || member.role === "viewer") throw forbidden("Workspace membership does not permit changing conversation context");
  const [conversation] = await tx.select().from(verrailConversations).where(and(eq(verrailConversations.workspaceId, scope.workspaceId), eq(verrailConversations.id, scope.conversationId))).for("update");
  if (!conversation) throw notFound("Conversation not found");
  if (conversation.status !== "active") throw conflict("Archived conversations must be restored before changing context");
  if (scope.sourceMessageId) {
    const [source] = await tx.select().from(verrailConversationMessages).where(and(eq(verrailConversationMessages.workspaceId, scope.workspaceId), eq(verrailConversationMessages.conversationId, scope.conversationId), eq(verrailConversationMessages.id, scope.sourceMessageId)));
    if (!source || source.role !== "user" || source.authorPrincipalType !== "user" || source.authorPrincipalId !== scope.principalId) throw forbidden("Context switch requires the initiating user's message");
  }
  const hash = createHash("sha256").update(JSON.stringify({ targetId: input.targetId, version: input.expectedContextVersion, source: scope.sourceMessageId ?? null, ...(input.operation ? { operation: input.operation } : {}) })).digest("hex");
  const [receipt] = await tx.select().from(verrailConversationContextChanges).where(and(eq(verrailConversationContextChanges.conversationId, scope.conversationId), eq(verrailConversationContextChanges.principalId, scope.principalId), eq(verrailConversationContextChanges.idempotencyKey, input.idempotencyKey)));
  if (receipt) {
    if (receipt.requestHash !== hash) throw conflict("Context command idempotency key was already used");
    return { ...receipt.response, replayed: true } as unknown as SwitchConversationContextResult;
  }
  if (conversation.contextVersion !== input.expectedContextVersion) throw conflict("Conversation context changed; refresh before switching", { code: "CONVERSATION_CONTEXT_CONFLICT" });
  const target = await readConversationTarget(tx, scope.workspaceId, input.targetId);
  if (input.targetId && !target) throw notFound("Target not found");
  const bindingWhere = and(eq(verrailConversationContextBindings.workspaceId, scope.workspaceId), eq(verrailConversationContextBindings.conversationId, conversation.id), eq(verrailConversationContextBindings.contextType, "target"), eq(verrailConversationContextBindings.contextId, input.targetId ?? ""));
  const [binding] = input.operation ? await tx.select().from(verrailConversationContextBindings).where(bindingWhere) : [];
  const currentTargetId = input.operation === "link" ? conversation.currentTargetId
    : input.operation === "unlink" ? (conversation.currentTargetId === input.targetId ? null : conversation.currentTargetId) : input.targetId;
  const changed = input.operation === "link" ? !binding
    : input.operation === "unlink" ? Boolean(binding) || currentTargetId !== conversation.currentTargetId : currentTargetId !== conversation.currentTargetId;
  const result: SwitchConversationContextResult = { ...(input.operation ? { operation: input.operation, relatedTargetId: input.targetId! } : {}), conversationId: conversation.id, previousTargetId: conversation.currentTargetId, currentTargetId, contextVersion: conversation.contextVersion + (changed ? 1 : 0), changed, replayed: false, targetTitle: target?.title ?? null };
  await tx.insert(verrailConversationContextChanges).values({ ...scope, sourceMessageId: scope.sourceMessageId ?? null, idempotencyKey: input.idempotencyKey, requestHash: hash, response: { ...result, agentId: scope.agentId ?? null } });
  if (changed) {
    await tx.insert(activityLog).values({ companyId: scope.workspaceId, actorType: "user", actorId: scope.principalId, agentId: scope.agentId ?? null, action: "conversation.context_changed", entityType: "conversation", entityId: conversation.id, details: { ...result, sourceMessageId: scope.sourceMessageId ?? null } });
    await tx.update(verrailConversations).set({ currentTargetId, contextVersion: result.contextVersion, updatedAt: new Date() }).where(eq(verrailConversations.id, conversation.id));
    if (input.operation === "unlink") await tx.delete(verrailConversationContextBindings).where(bindingWhere);
    else if (target) await tx.insert(verrailConversationContextBindings).values({ workspaceId: scope.workspaceId, conversationId: conversation.id, contextType: "target", contextId: target.targetId, label: target.title, href: `/targets/${target.targetId}/overview` }).onConflictDoNothing();
    await tx.insert(verrailConversationMessages).values({ workspaceId: scope.workspaceId, conversationId: conversation.id, role: "tool", body: target?.title ?? "", authorPrincipalType: scope.agentId ? "agent" : "user", authorPrincipalId: scope.agentId ?? scope.principalId, metadata: { kind: "conversation_context_changed", ...result, sourceMessageId: scope.sourceMessageId ?? null } });
  }
  return result;
}

export function conversationContextService(db: Db) {
  return { switch: (scope: Parameters<typeof switchConversationContext>[1], input: SwitchConversationContextInput) => db.transaction(tx => switchConversationContext(tx, scope, input)) };
}
