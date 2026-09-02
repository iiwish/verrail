export const CONVERSATION_STATUSES = ["active", "archived"] as const;
export const CONVERSATION_MESSAGE_ROLES = ["user", "assistant", "system", "tool"] as const;
export const TARGET_CREATION_DRAFT_STATUSES = [
  "collecting",
  "ready_for_confirmation",
  "converting",
  "converted",
  "canceled",
] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export type ConversationMessageRole = (typeof CONVERSATION_MESSAGE_ROLES)[number];
export type TargetCreationDraftStatus = (typeof TARGET_CREATION_DRAFT_STATUSES)[number];
export type ConversationContextType =
  | "collection"
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

export interface ProviderConversationBinding {
  id: string;
  workspaceId: string;
  conversationId: string;
  providerKey: string;
  connectionId: string;
  externalConversationType: "group" | "direct";
  externalConversationId: string;
  createdByPrincipalType: string;
  createdByPrincipalId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TargetDraftResourceRef {
  kind: string;
  id: string;
  label?: string | null;
  href?: string | null;
  contentHash?: string | null;
}

export interface TargetDraftDefinition {
  collectionId: string | null;
  title: string | null;
  summary: string | null;
  outcomeOwner: { principalType: "user" | "agent"; principalId: string } | null;
  goal: string | null;
  constraints: string[];
  acceptanceCriteria: Array<{ title: string; description?: string | null }>;
  riskLevel: "low" | "medium" | "high" | "critical" | null;
  deadline: string | null;
  policySummary: string | null;
  resourceRefs: TargetDraftResourceRef[];
}

export interface TargetCreationDraftRevision {
  id: string;
  workspaceId: string;
  draftId: string;
  revisionNumber: number;
  definition: TargetDraftDefinition;
  missingFields: string[];
  fieldSources: Record<string, Record<string, unknown>>;
  contentHash: string;
  createdByPrincipalType: string;
  createdByPrincipalId: string;
  createdAt: Date;
}

export interface TargetCreationDraft {
  id: string;
  workspaceId: string;
  conversationId: string;
  sourceMessageId: string;
  initiatedByPrincipalType: string;
  initiatedByPrincipalId: string;
  status: TargetCreationDraftStatus;
  activeRevisionId: string;
  activeRevisionNumber: number;
  convertedTargetId: string | null;
  convertedTargetRevisionId: string | null;
  confirmedByPrincipalType: string | null;
  confirmedByPrincipalId: string | null;
  confirmedAt: Date | null;
  conversionIdempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  activeRevision: TargetCreationDraftRevision;
}
