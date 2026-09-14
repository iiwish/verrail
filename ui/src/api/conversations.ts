import type {
  Conversation,
  ChannelTargetReplySummary,
  ConversationDetail,
  ConversationMessage,
  CreateConversationInput,
  CreateTargetResponseV1,
  TargetCreationDraft,
  TargetDraftDefinition,
  UpdateConversationInput,
  SwitchConversationContextInput,
  SwitchConversationContextResult,
} from "@paperclipai/shared";
import { api } from "./client";

function workspacePath(workspaceId: string) {
  return `/workspaces/${encodeURIComponent(workspaceId)}/conversations`;
}

export const conversationsApi = {
  list: (workspaceId: string, options: { status?: "active" | "archived"; q?: string; targetId?: string; agentId?: string } = {}) => {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.q) search.set("q", options.q);
    if (options.targetId) search.set("targetId", options.targetId);
    if (options.agentId) search.set("agentId", options.agentId);
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return api.get<Conversation[]>(`${workspacePath(workspaceId)}${suffix}`);
  },
  create: (workspaceId: string, input: CreateConversationInput = { contextBindings: [] }) =>
    api.post<ConversationDetail>(workspacePath(workspaceId), input),
  get: (workspaceId: string, conversationId: string) =>
    api.get<ConversationDetail>(`${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}`),
  update: (workspaceId: string, conversationId: string, input: UpdateConversationInput) =>
    api.patch<Conversation>(`${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}`, input),
  switchContext: (workspaceId: string, conversationId: string, input: SwitchConversationContextInput) =>
    api.post<SwitchConversationContextResult>(`${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/context`, input),
  appendStructuredMessage: (workspaceId: string, conversationId: string, body: string) =>
    api.post<ConversationMessage>(`${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/messages`, { body }),
  listTargetDrafts: (workspaceId: string, conversationId: string) =>
    api.get<TargetCreationDraft[]>(`${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/target-drafts`),
  confirmTargetProposal: (workspaceId: string, conversationId: string, messageId: string) =>
    api.post<import("@paperclipai/shared").ManageTargetResult>(`${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/proposals/${encodeURIComponent(messageId)}/confirm`, {}),
  updateTargetDraft: (workspaceId: string, conversationId: string, draftId: string, revisionNumber: number, patch: Partial<TargetDraftDefinition>) =>
    api.patch<TargetCreationDraft>(
      `${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/target-drafts/${encodeURIComponent(draftId)}`,
      { expectedRevisionNumber: revisionNumber, patch, fieldSources: {} },
    ),
  createTargetDraft: (
    workspaceId: string,
    conversationId: string,
    sourceMessageId: string,
    initial: Partial<TargetDraftDefinition>,
  ) => api.post<TargetCreationDraft>(
    `${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/target-drafts`,
    { sourceMessageId, initial, fieldSources: {} },
  ),
  confirmTargetDraft: (workspaceId: string, conversationId: string, draftId: string, revisionNumber: number) =>
    api.post<{ draft: TargetCreationDraft; target: CreateTargetResponseV1; channelReply?: ChannelTargetReplySummary }>(
      `${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/target-drafts/${encodeURIComponent(draftId)}/confirm`,
      { expectedRevisionNumber: revisionNumber },
    ),
  getTargetDraftChannelReply: (workspaceId: string, conversationId: string, draftId: string) =>
    api.get<ChannelTargetReplySummary>(
      `${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/target-drafts/${encodeURIComponent(draftId)}/channel-reply`,
    ),
  reconcileTargetDraftChannelReply: (workspaceId: string, conversationId: string, draftId: string, providerMessageId: string) =>
    api.post<ChannelTargetReplySummary>(
      `${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}/target-drafts/${encodeURIComponent(draftId)}/channel-reply/reconcile`,
      { providerMessageId },
    ),
};
