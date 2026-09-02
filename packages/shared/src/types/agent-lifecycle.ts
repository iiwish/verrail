export const AGENT_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export type AgentDefinitionStatus = "draft" | "published" | "retired";
export type EvaluationRunStatus = "passed" | "failed" | "inconclusive";
export type DeploymentStatus = "active" | "paused" | "retired";
export type DeploymentRevisionState = "active" | "paused" | "superseded" | "retired";

export interface CreateAgentDefinitionInputV1 {
  name: string;
  description?: string | null;
  compatibilityAgentId?: string | null;
}

export interface UpdateAgentDefinitionInputV1 {
  name?: string;
  description?: string | null;
}

export interface PublishAgentVersionInputV1 {
  runtime: string;
  model: string;
  prompt: string;
  skills?: string[];
  tools?: string[];
  outputSchema?: Record<string, unknown>;
  capabilityCeiling?: string[];
  supplyChain?: Record<string, unknown>;
}

export interface RecordEvaluationRunInputV1 {
  candidateAgentVersionId: string;
  baselineAgentVersionId?: string | null;
  status: EvaluationRunStatus;
  qualityScore?: number | null;
  costCents?: number | null;
  latencyMs?: number | null;
  safetyStatus: "passed" | "failed" | "not_run";
  summary?: string | null;
}

export interface CreateDeploymentInputV1 {
  agentDefinitionId: string;
  agentVersionId: string;
  evaluationRunId: string;
  name: string;
  isDefault?: boolean;
  runtimeConfig?: Record<string, unknown>;
}

export interface ReviseDeploymentInputV1 {
  action: "pause" | "resume" | "upgrade" | "rollback" | "retire" | "set_default";
  agentVersionId?: string;
  evaluationRunId?: string;
  sourceDeploymentRevisionId?: string;
  runtimeConfig?: Record<string, unknown>;
}

export interface AgentVersionV1 extends PublishAgentVersionInputV1 {
  id: string;
  workspaceId: string;
  agentDefinitionId: string;
  versionNumber: number;
  contentHash: string;
  createdAt: string;
}

export interface EvaluationRunV1 extends RecordEvaluationRunInputV1 {
  id: string;
  workspaceId: string;
  createdAt: string;
}

export interface DeploymentRevisionV1 {
  id: string;
  workspaceId: string;
  deploymentId: string;
  revisionNumber: number;
  agentVersionId: string;
  evaluationRunId: string;
  state: DeploymentRevisionState;
  runtimeConfig: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
}

export interface DeploymentV1 {
  id: string;
  workspaceId: string;
  agentDefinitionId: string;
  name: string;
  status: DeploymentStatus;
  isDefault: boolean;
  activeRevision: DeploymentRevisionV1 | null;
  revisions: DeploymentRevisionV1[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinitionV1 {
  id: string;
  workspaceId: string;
  compatibilityAgentId: string | null;
  name: string;
  description: string | null;
  status: AgentDefinitionStatus;
  versions: AgentVersionV1[];
  evaluations: EvaluationRunV1[];
  deployments: DeploymentV1[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentLifecycleReadModelV1 {
  schemaVersion: typeof AGENT_LIFECYCLE_SCHEMA_VERSION;
  workspaceId: string;
  generatedAt: string;
  defaultDeploymentId: string | null;
  definitions: AgentDefinitionV1[];
}

export interface AgentLifecycleCommandResponseV1 {
  schemaVersion: typeof AGENT_LIFECYCLE_SCHEMA_VERSION;
  resourceType: "agent_definition" | "agent_version" | "evaluation_run" | "deployment" | "deployment_revision";
  resourceId: string;
  replayed: boolean;
}
