export const TARGET_READ_MODEL_SCHEMA_VERSION = 1 as const;
export const TARGET_PROJECTION_POLICY_VERSION = "g1.v1" as const;

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

export type TargetStatus = (typeof TARGET_STATUSES)[number];
export type TargetSourceType = "case" | "issue";
export type TargetStageKey = "define" | "execute" | "verify" | "accept" | "unknown";
export type TargetRiskLevel = "unknown" | "low" | "medium" | "high" | "critical";

export interface TargetAcceptanceCriterionV1 {
  id: string;
  title: string;
  description: string | null;
}

export interface CreateTargetInputV1 {
  projectId: string;
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
}

export interface CreateTargetResponseV1 {
  schemaVersion: typeof TARGET_READ_MODEL_SCHEMA_VERSION;
  targetId: string;
  targetRevisionId: string;
  workbenchHref: string;
  replayed: boolean;
}

export interface TargetReadModelV1 {
  schemaVersion: typeof TARGET_READ_MODEL_SCHEMA_VERSION;
  projectionPolicyVersion: string;
  targetId: string;
  activeTargetRevisionId: string;
  workspaceId: string;
  authority: {
    kind: "native" | "compatibility";
    writer: "go-domain-api" | "typescript-compatibility";
  };
  project: { id: string; name: string } | null;
  source:
    | {
        type: TargetSourceType;
        id: string;
        identifier: string | null;
        href: string;
        updatedAt: string;
        revisionKey: string;
      }
    | {
        type: "native";
        id: string;
        identifier: null;
        href: string;
        updatedAt: string;
        revisionKey: string;
      };
  title: string;
  summary: string | null;
  status: TargetStatus;
  outcomeOwner: {
    principalType: "user" | "agent";
    principalId: string;
    displayName: string | null;
  } | null;
  currentStage: {
    key: TargetStageKey;
    label: string;
  } | null;
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
  } | null;
  compatibility: {
    readOnly: true;
    completionUnverified: boolean;
    missingFields: string[];
    warnings: string[];
  } | null;
  createdAt: string;
  updatedAt: string;
  projectedAt: string;
}

export interface TargetListResponseV1 {
  schemaVersion: typeof TARGET_READ_MODEL_SCHEMA_VERSION;
  projectionPolicyVersion: string;
  asOf: string;
  items: TargetReadModelV1[];
  nextCursor: string | null;
}

export interface TargetProjectionSource {
  workspaceId: string;
  targetId: string;
  sourceType: TargetSourceType;
  sourceId: string;
  projectionPolicyVersion: string;
  eligibilityReason: "explicit_marker" | "approved_backfill" | "operator_mapping";
  activeTargetRevisionId: string;
  sourceRevisionKey: string;
  sourceSnapshotHash: string;
  lastProjectedAt: Date;
  disabledAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}
