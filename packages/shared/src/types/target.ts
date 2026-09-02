import type { RunAttemptV1 } from "./execution.js";

export const TARGET_READ_MODEL_SCHEMA_VERSION = 1 as const;
export const TARGET_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const TARGET_READ_MODEL_POLICY_VERSION = "native.v1" as const;

export const TARGET_STATUSES = [
  "draft",
  "ready",
  "active",
  "verifying",
  "awaiting_acceptance",
  "blocked",
  "canceled",
  "accepted",
] as const;

export const TARGET_STAGE_KEYS = ["define", "execute", "verify", "accept"] as const;
export const TARGET_RISK_LEVELS = ["unknown", "low", "medium", "high", "critical"] as const;

export type TargetStatus = (typeof TARGET_STATUSES)[number];
export type TargetStageKey = (typeof TARGET_STAGE_KEYS)[number] | "unknown";
export type TargetRiskLevel = (typeof TARGET_RISK_LEVELS)[number];
export type TargetStageState = "completed" | "current" | "pending" | "blocked";

export interface TargetAcceptanceCriterionV1 {
  id: string;
  title: string;
  description: string | null;
}

export interface TargetResourceRefV1 {
  kind: string;
  id: string;
  label: string | null;
}

export interface CreateTargetInputV1 {
  collectionId?: string | null;
  title: string;
  summary?: string | null;
  outcomeOwner: {
    principalType: "user" | "agent";
    principalId: string;
  };
  goal: string;
  constraints: string[];
  acceptanceCriteria: Array<{
    title: string;
    description?: string | null;
  }>;
  riskLevel: Exclude<TargetRiskLevel, "unknown">;
  deadline?: string | null;
  policySummary?: string | null;
  resourceRefs?: TargetResourceRefV1[];
}

export interface CreateTargetResponseV1 {
  schemaVersion: typeof TARGET_READ_MODEL_SCHEMA_VERSION;
  targetId: string;
  targetRevisionId: string;
  workGraphId: string;
  graphRevisionId: string;
  workbenchHref: string;
  replayed: boolean;
}

export interface TargetReadModelV1 {
  schemaVersion: typeof TARGET_READ_MODEL_SCHEMA_VERSION;
  readModelPolicyVersion: typeof TARGET_READ_MODEL_POLICY_VERSION;
  targetId: string;
  activeTargetRevisionId: string;
  workspaceId: string;
  collection: { id: string; name: string } | null;
  title: string;
  summary: string | null;
  status: TargetStatus;
  outcomeOwner: {
    principalType: "user" | "agent";
    principalId: string;
    displayName: string | null;
  };
  currentStage: { key: TargetStageKey; label: string } | null;
  risk: { level: TargetRiskLevel };
  attentionSummary: { total: number; highestSeverity: string | null };
  artifactSummary: { count: number; latestRevisionId: string | null };
  evidenceSummary: {
    count: number;
    passed: number;
    failed: number;
    inconclusive: number;
    coverage: "unknown" | "partial" | "complete";
  };
  runSummary: {
    active: number;
    failed: number;
    latestRunId: string | null;
    latestRunAt: string | null;
  };
  definition: {
    goal: string;
    constraints: string[];
    acceptanceCriteria: TargetAcceptanceCriterionV1[];
    deadline: string | null;
    policySummary: string | null;
    resourceRefs: TargetResourceRefV1[];
  };
  createdAt: string;
  updatedAt: string;
  projectedAt: string;
}

export interface TargetListResponseV1 {
  schemaVersion: typeof TARGET_READ_MODEL_SCHEMA_VERSION;
  readModelPolicyVersion: typeof TARGET_READ_MODEL_POLICY_VERSION;
  asOf: string;
  items: TargetReadModelV1[];
  summary: {
    total: number;
    open: number;
    attention: number;
    byCollection: Record<string, { total: number; open: number; attention: number }>;
  };
  nextCursor: string | null;
}

export interface TargetGraphSummaryV1 {
  workGraphId: string;
  activeGraphRevisionId: string | null;
  status: "draft" | "active" | "completed" | "canceled";
  revisionNumber: number | null;
}

export interface TargetStageProgressV1 {
  key: Exclude<TargetStageKey, "unknown">;
  label: string;
  state: TargetStageState;
}

export interface TargetWorkItemV1 {
  id: string;
  nodeKey: string;
  graphRevisionId: string;
  kind: "agent_task" | "integration_task" | "human_task" | "decision_gate" | "review_gate" | "acceptance_gate" | "policy_gate";
  stage: Exclude<TargetStageKey, "unknown">;
  status: "pending" | "ready" | "running" | "blocked" | "completed" | "canceled";
  title: string;
  responsiblePrincipal: { principalType: "user" | "agent" | "service"; principalId: string } | null;
  dependencyNodeKeys: string[];
  completionDefinition: string | null;
  updatedAt: string;
}

export interface TargetSubmissionV1 {
  id: string;
  targetRevisionId: string;
  status: "draft" | "submitted" | "withdrawn";
  createdAt: string;
}

export interface TargetArtifactRevisionV1 {
  id: string;
  targetRevisionId: string;
  title: string;
  mediaKind: string;
  href: string;
  updatedAt: string;
}

export interface TargetEvidenceV1 {
  id: string;
  targetRevisionId: string;
  criterionId: string | null;
  result: "passed" | "failed" | "inconclusive";
  title: string;
  href: string | null;
  createdAt: string;
}

export interface TargetRunV1 {
  id: string;
  kind: "agent_run" | "integration_run";
  targetRevisionId: string;
  graphRevisionId: string;
  workNodeId: string;
  status: "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "canceled";
  actor: { principalType: "agent" | "service"; principalId: string };
  deploymentRevisionId: string | null;
  agentVersionId: string | null;
  attempt: number;
  cancelRequestedAt: string | null;
  attempts: RunAttemptV1[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface TargetAttentionItemV1 {
  id: string;
  severity: "info" | "warning" | "critical";
  kind: "draft_graph" | "blocked_node" | "failed_run" | "awaiting_acceptance";
  title: string;
  detail: string | null;
  workNodeId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface TargetTimelineEventV1 {
  id: string;
  type: "target_created" | "target_revision_created" | "graph_revision_created" | "graph_activated" | "run_created" | "run_updated";
  title: string;
  detail: string | null;
  occurredAt: string;
}

export interface TargetWorkspaceV1 {
  schemaVersion: typeof TARGET_WORKSPACE_SCHEMA_VERSION;
  targetId: string;
  targetRevisionId: string;
  workspaceId: string;
  generatedAt: string;
  graph: TargetGraphSummaryV1 | null;
  stages: TargetStageProgressV1[];
  work: TargetWorkItemV1[];
  attention: TargetAttentionItemV1[];
  submissions: TargetSubmissionV1[];
  artifacts: TargetArtifactRevisionV1[];
  evidence: TargetEvidenceV1[];
  runs: TargetRunV1[];
  timeline: TargetTimelineEventV1[];
}

export interface CreateGraphRevisionInputV1 {
  expectedTargetRevisionId: string;
  nodes: Array<{
    nodeKey: string;
    kind: TargetWorkItemV1["kind"];
    stage: TargetWorkItemV1["stage"];
    title: string;
    responsiblePrincipal?: TargetWorkItemV1["responsiblePrincipal"];
    dependencyNodeKeys?: string[];
    completionDefinition: string;
  }>;
}

export interface CreateGraphRevisionResponseV1 {
  schemaVersion: 1;
  targetId: string;
  targetRevisionId: string;
  workGraphId: string;
  graphRevisionId: string;
  revisionNumber: number;
  replayed: boolean;
}

export interface ActivateGraphRevisionResponseV1 extends CreateGraphRevisionResponseV1 {
  activatedAt: string;
}

export interface CreateRunInputV1 {
  kind: "agent_run" | "integration_run";
  actor: { principalType: "agent" | "service"; principalId: string };
}

export interface CreateRunResponseV1 {
  schemaVersion: 1;
  runId: string;
  targetId: string;
  targetRevisionId: string;
  graphRevisionId: string;
  workNodeId: string;
  deploymentRevisionId: string | null;
  agentVersionId: string | null;
  status: "queued";
  replayed: boolean;
}
