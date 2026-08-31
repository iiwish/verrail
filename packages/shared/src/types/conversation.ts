export const CONVERSATION_STATUSES = ["active", "archived"] as const;
export const CONVERSATION_MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export type ConversationMessageRole = (typeof CONVERSATION_MESSAGE_ROLES)[number];
export type ConversationContextType =
  | "project"
  | "target"
  | "target_revision"
  | "stage"
  | "artifact_revision"
  | "review"
  | "run"
  | "action_request";

export interface ConversationContextBinding {
  id: string;
  workspaceId: string;
  conversationId: string;
  contextType: ConversationContextType;
  contextId: string;
  label: string | null;
  href: string | null;
  createdAt: Date;
}

export interface ConversationMessage {
  id: string;
  workspaceId: string;
  conversationId: string;
  role: ConversationMessageRole;
  status: "complete" | "failed";
  body: string;
  authorPrincipalType: string | null;
  authorPrincipalId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  status: ConversationStatus;
  pinnedAt: Date | null;
  createdByPrincipalType: string;
  createdByPrincipalId: string;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationDetail extends Conversation {
  contextBindings: ConversationContextBinding[];
  messages: ConversationMessage[];
}
