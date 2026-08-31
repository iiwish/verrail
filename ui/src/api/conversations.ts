import type {
  Conversation,
  ConversationDetail,
  CreateConversationInput,
  UpdateConversationInput,
} from "@paperclipai/shared";
import { api } from "./client";

function workspacePath(workspaceId: string) {
  return `/workspaces/${encodeURIComponent(workspaceId)}/conversations`;
}

export const conversationsApi = {
  list: (workspaceId: string, options: { status?: "active" | "archived"; q?: string } = {}) => {
    const search = new URLSearchParams();
    if (options.status) search.set("status", options.status);
    if (options.q) search.set("q", options.q);
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return api.get<Conversation[]>(`${workspacePath(workspaceId)}${suffix}`);
  },
  create: (workspaceId: string, input: CreateConversationInput = { contextBindings: [] }) =>
    api.post<ConversationDetail>(workspacePath(workspaceId), input),
  get: (workspaceId: string, conversationId: string) =>
    api.get<ConversationDetail>(`${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}`),
  update: (workspaceId: string, conversationId: string, input: UpdateConversationInput) =>
    api.patch<Conversation>(`${workspacePath(workspaceId)}/${encodeURIComponent(conversationId)}`, input),
};
