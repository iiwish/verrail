export const EXECUTION_SCHEMA_VERSION = 1 as const;

export type RuntimeProfileV1 = "host_trusted";
export type RunAttemptStatusV1 = "pending" | "running" | "cancel_requested" | "cancel_acknowledged" | "succeeded" | "failed" | "canceled" | "superseded";
export type ExecutionLeaseStatusV1 = "offered" | "active" | "suspect" | "expired" | "released" | "revoked";
export type RunEventTypeV1 = "claimed" | "heartbeat" | "started" | "progress" | "succeeded" | "failed" | "cancel_acknowledged" | "terminated";

export interface ExecutionLeaseV1 {
  id: string;
  runAttemptId: string;
  executorPrincipalId: string;
  runtimeProfile: RuntimeProfileV1;
  fencingToken: number;
  status: ExecutionLeaseStatusV1;
  expiresAt: string;
  graceExpiresAt: string;
  claimedAt: string | null;
  lastHeartbeatAt: string | null;
  releasedAt: string | null;
}

export interface RunEventV1 {
  id: string;
  runAttemptId: string;
  cursor: number;
  fencingToken: number;
  eventType: RunEventTypeV1;
  payload: Record<string, unknown>;
  emittedAt: string;
  receivedAt: string;
}

export interface RunAttemptV1 {
  id: string;
  runId: string;
  attemptNumber: number;
  deploymentRevisionId: string;
  agentVersionId: string;
  runtimeProfile: RuntimeProfileV1;
  executor: { principalType: "service"; principalId: string };
  fencingToken: number;
  status: RunAttemptStatusV1;
  lastEventCursor: number;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  lease: ExecutionLeaseV1 | null;
  events: RunEventV1[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunAttemptInputV1 {
  runtimeProfile: RuntimeProfileV1;
  executor: { principalType: "service"; principalId: string };
  leaseDurationSeconds?: number;
  graceDurationSeconds?: number;
}

export interface CreateRunAttemptResponseV1 {
  schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  runId: string;
  runAttemptId: string;
  leaseId: string;
  attemptNumber: number;
  fencingToken: number;
  status: "pending";
  leaseStatus: "offered";
  expiresAt: string;
  replayed: boolean;
}

export interface ReportRunEventInputV1 {
  leaseId: string;
  fencingToken: number;
  cursor: number;
  eventType: RunEventTypeV1;
  emittedAt: string;
  payload?: Record<string, unknown>;
  extendLeaseSeconds?: number;
}

export interface ReportRunEventResponseV1 {
  schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  runId: string;
  runAttemptId: string;
  cursor: number;
  eventType: RunEventTypeV1;
  authoritative: boolean;
  rejectionCode: "STALE_FENCING_TOKEN" | "EVENT_CURSOR_GAP" | "LEASE_NOT_ACTIVE" | "ATTEMPT_TERMINAL" | "CANCELLATION_IN_PROGRESS" | null;
  runStatus: "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "canceled";
  attemptStatus: RunAttemptStatusV1;
  leaseStatus: ExecutionLeaseStatusV1;
  replayed: boolean;
}

export interface RequestRunCancellationResponseV1 {
  schemaVersion: typeof EXECUTION_SCHEMA_VERSION;
  runId: string;
  runAttemptId: string;
  runStatus: "cancel_requested";
  attemptStatus: "cancel_requested";
  replayed: boolean;
}
