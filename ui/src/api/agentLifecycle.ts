import type {
  AgentLifecycleCommandResponseV1,
  AgentLifecycleReadModelV1,
  CreateAgentDefinitionInputV1,
  CreateDeploymentInputV1,
  PublishAgentVersionInputV1,
  RecordEvaluationRunInputV1,
  ReviseDeploymentInputV1,
  UpdateAgentDefinitionInputV1,
} from "@paperclipai/shared";
import { api } from "./client";

// Optional idempotencyKey lets callers reuse a key across re-submits; defaults to a fresh key.
const headers = (idempotencyKey?: string) => ({ "Idempotency-Key": `ui.agent.${idempotencyKey ?? crypto.randomUUID()}` });
const workspacePath = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`;

export const agentLifecycleApi = {
  get: (workspaceId: string) => api.get<AgentLifecycleReadModelV1>(`${workspacePath(workspaceId)}/agent-lifecycle`),
  createDefinition: (workspaceId: string, input: CreateAgentDefinitionInputV1, idempotencyKey?: string) => api.post<AgentLifecycleCommandResponseV1>(`${workspacePath(workspaceId)}/agent-definitions`, input, { headers: headers(idempotencyKey) }),
  updateDefinition: (workspaceId: string, definitionId: string, input: UpdateAgentDefinitionInputV1, idempotencyKey?: string) => api.patch<AgentLifecycleCommandResponseV1>(`${workspacePath(workspaceId)}/agent-definitions/${encodeURIComponent(definitionId)}`, input, { headers: headers(idempotencyKey) }),
  publishVersion: (workspaceId: string, definitionId: string, input: PublishAgentVersionInputV1, idempotencyKey?: string) => api.post<AgentLifecycleCommandResponseV1>(`${workspacePath(workspaceId)}/agent-definitions/${encodeURIComponent(definitionId)}/versions`, input, { headers: headers(idempotencyKey) }),
  recordEvaluation: (workspaceId: string, input: RecordEvaluationRunInputV1, idempotencyKey?: string) => api.post<AgentLifecycleCommandResponseV1>(`${workspacePath(workspaceId)}/evaluation-runs`, input, { headers: headers(idempotencyKey) }),
  createDeployment: (workspaceId: string, input: CreateDeploymentInputV1, idempotencyKey?: string) => api.post<AgentLifecycleCommandResponseV1>(`${workspacePath(workspaceId)}/deployments`, input, { headers: headers(idempotencyKey) }),
  reviseDeployment: (workspaceId: string, deploymentId: string, input: ReviseDeploymentInputV1, idempotencyKey?: string) => api.post<AgentLifecycleCommandResponseV1>(`${workspacePath(workspaceId)}/deployments/${encodeURIComponent(deploymentId)}/revisions`, input, { headers: headers(idempotencyKey) }),
};
