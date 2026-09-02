export interface Collection {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  targetCount: number;
  openTargetCount: number;
  attentionTargetCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollectionInput {
  name: string;
  description?: string | null;
}
