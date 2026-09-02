import type { Collection, CreateCollectionInput } from "@paperclipai/shared";
import { api } from "./client";

export const collectionsApi = {
  list: (workspaceId: string) =>
    api.get<Collection[]>(`/workspaces/${workspaceId}/collections`),
  create: (workspaceId: string, input: CreateCollectionInput) =>
    api.post<Collection>(`/workspaces/${workspaceId}/collections`, input),
};
