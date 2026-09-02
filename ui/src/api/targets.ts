import type {
  ConversationDetail,
  CreateTargetInputV1,
  CreateTargetResponseV1,
  CreateRunAttemptInputV1,
  CreateRunAttemptResponseV1,
  RequestRunCancellationResponseV1,
  TargetListResponseV1,
  TargetReadModelV1,
  TargetStatus,
  TargetWorkspaceV1,
} from "@paperclipai/shared";
import { api } from "./client";

export interface TargetListOptions {
  limit?: number;
  cursor?: string;
  collectionId?: string;
  status?: TargetStatus;
  ownerId?: string;
  attention?: boolean;
}

function listPath(workspaceId: string, options: TargetListOptions = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.collectionId) params.set("collectionId", options.collectionId);
  if (options.status) params.set("status", options.status);
  if (options.ownerId) params.set("ownerId", options.ownerId);
  if (options.attention !== undefined) params.set("attention", String(options.attention));
  const query = params.toString();
  return `/workspaces/${workspaceId}/targets${query ? `?${query}` : ""}`;
}

export const targetsApi = {
  create: (workspaceId: string, input: CreateTargetInputV1, idempotencyKey: string) =>
    api.post<CreateTargetResponseV1>(`/workspaces/${workspaceId}/targets`, input, {
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  list: (workspaceId: string, options: TargetListOptions = {}) =>
    api.get<TargetListResponseV1>(listPath(workspaceId, options)),
  listForCollection: (workspaceId: string, collectionId: string, options: Omit<TargetListOptions, "collectionId"> = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.status) params.set("status", options.status);
    if (options.ownerId) params.set("ownerId", options.ownerId);
    if (options.attention !== undefined) params.set("attention", String(options.attention));
    const query = params.toString();
    return api.get<TargetListResponseV1>(
      `/workspaces/${workspaceId}/collections/${collectionId}/targets${query ? `?${query}` : ""}`,
    );
  },
  get: (workspaceId: string, targetId: string) =>
    api.get<TargetReadModelV1>(`/workspaces/${workspaceId}/targets/${targetId}`),
  getWorkspace: (workspaceId: string, targetId: string) =>
    api.get<TargetWorkspaceV1>(`/workspaces/${workspaceId}/targets/${targetId}/workspace`),
  createConversation: (workspaceId: string, targetId: string) =>
    api.post<ConversationDetail>(`/workspaces/${workspaceId}/targets/${targetId}/conversation`, {}),
  createRunAttempt: (workspaceId: string, runId: string, input: CreateRunAttemptInputV1, idempotencyKey: string) =>
    api.post<CreateRunAttemptResponseV1>(`/workspaces/${workspaceId}/runs/${runId}/attempts`, input, {
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  requestRunCancellation: (workspaceId: string, runId: string, idempotencyKey: string) =>
    api.post<RequestRunCancellationResponseV1>(`/workspaces/${workspaceId}/runs/${runId}/cancel`, {}, {
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  getRevision: (workspaceId: string, targetId: string, targetRevisionId: string) =>
    api.get<TargetReadModelV1>(
      `/workspaces/${workspaceId}/targets/${targetId}/revisions/${targetRevisionId}`,
    ),
};
