import type {
  CreateTargetInputV1,
  CreateTargetResponseV1,
  TargetListResponseV1,
  TargetReadModelV1,
  TargetStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export interface TargetListOptions {
  limit?: number;
  cursor?: string;
  projectId?: string;
  status?: TargetStatus;
  ownerId?: string;
  attention?: boolean;
}

function listPath(workspaceId: string, options: TargetListOptions = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.projectId) params.set("projectId", options.projectId);
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
  listForProject: (workspaceId: string, projectId: string, options: Omit<TargetListOptions, "projectId"> = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.status) params.set("status", options.status);
    if (options.ownerId) params.set("ownerId", options.ownerId);
    if (options.attention !== undefined) params.set("attention", String(options.attention));
    const query = params.toString();
    return api.get<TargetListResponseV1>(
      `/workspaces/${workspaceId}/projects/${projectId}/targets${query ? `?${query}` : ""}`,
    );
  },
  get: (workspaceId: string, targetId: string) =>
    api.get<TargetReadModelV1>(`/workspaces/${workspaceId}/targets/${targetId}`),
  getRevision: (workspaceId: string, targetId: string, targetRevisionId: string) =>
    api.get<TargetReadModelV1>(
      `/workspaces/${workspaceId}/targets/${targetId}/revisions/${targetRevisionId}`,
    ),
};
