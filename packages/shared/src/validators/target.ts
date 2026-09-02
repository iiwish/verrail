import { z } from "zod";
import {
  TARGET_READ_MODEL_POLICY_VERSION,
  TARGET_READ_MODEL_SCHEMA_VERSION,
  TARGET_RISK_LEVELS,
  TARGET_STAGE_KEYS,
  TARGET_STATUSES,
  TARGET_WORKSPACE_SCHEMA_VERSION,
  type TargetReadModelV1,
  type TargetWorkspaceV1,
} from "../types/target.js";

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const nullableTrimmed = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const principalSchema = z.object({
  principalType: z.enum(["user", "agent"]),
  principalId: z.string().trim().min(1).max(200),
}).strict();

export const targetResourceRefSchema = z.object({
  kind: z.string().trim().min(1).max(100),
  id: z.string().trim().min(1).max(500),
  label: z.string().trim().min(1).max(500).nullable(),
}).strict();

const targetDefinitionSchema = z.object({
  goal: z.string(),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
  }).strict()),
  deadline: z.iso.date().nullable(),
  policySummary: z.string().nullable(),
  resourceRefs: z.array(targetResourceRefSchema),
}).strict();

export const targetReadModelV1Schema: z.ZodType<TargetReadModelV1> = z.object({
  schemaVersion: z.literal(TARGET_READ_MODEL_SCHEMA_VERSION),
  readModelPolicyVersion: z.literal(TARGET_READ_MODEL_POLICY_VERSION),
  targetId: z.string().uuid(),
  activeTargetRevisionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  collection: z.object({ id: z.string().uuid(), name: z.string() }).strict().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  status: z.enum(TARGET_STATUSES),
  outcomeOwner: z.object({
    principalType: z.enum(["user", "agent"]),
    principalId: z.string().min(1),
    displayName: z.string().nullable(),
  }).strict(),
  currentStage: z.object({
    key: z.enum([...TARGET_STAGE_KEYS, "unknown"]),
    label: z.string(),
  }).strict().nullable(),
  risk: z.object({ level: z.enum(TARGET_RISK_LEVELS) }).strict(),
  attentionSummary: z.object({
    total: z.number().int().nonnegative(),
    highestSeverity: z.string().nullable(),
  }).strict(),
  artifactSummary: z.object({
    count: z.number().int().nonnegative(),
    latestRevisionId: z.string().nullable(),
  }).strict(),
  evidenceSummary: z.object({
    count: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    inconclusive: z.number().int().nonnegative(),
    coverage: z.enum(["unknown", "partial", "complete"]),
  }).strict(),
  runSummary: z.object({
    active: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    latestRunId: z.string().nullable(),
    latestRunAt: isoDateTimeSchema.nullable(),
  }).strict(),
  definition: targetDefinitionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  projectedAt: isoDateTimeSchema,
}).strict();

const stageSchema = z.enum(TARGET_STAGE_KEYS);
const workKindSchema = z.enum(["agent_task", "integration_task", "human_task", "decision_gate", "review_gate", "acceptance_gate", "policy_gate"]);
const workStatusSchema = z.enum(["pending", "ready", "running", "blocked", "completed", "canceled"]);
const runStatusSchema = z.enum(["queued", "running", "cancel_requested", "succeeded", "failed", "canceled"]);
const executionLeaseSchema = z.object({
  id: z.string().uuid(), runAttemptId: z.string().uuid(), executorPrincipalId: z.string().min(1),
  runtimeProfile: z.literal("host_trusted"), fencingToken: z.number().int().positive(),
  status: z.enum(["offered", "active", "suspect", "expired", "released", "revoked"]),
  expiresAt: isoDateTimeSchema, graceExpiresAt: isoDateTimeSchema,
  claimedAt: isoDateTimeSchema.nullable(), lastHeartbeatAt: isoDateTimeSchema.nullable(),
  releasedAt: isoDateTimeSchema.nullable(),
}).strict();
const runEventSchema = z.object({
  id: z.string().uuid(), runAttemptId: z.string().uuid(), cursor: z.number().int().positive(),
  fencingToken: z.number().int().positive(),
  eventType: z.enum(["claimed", "heartbeat", "started", "progress", "succeeded", "failed", "cancel_acknowledged", "terminated"]),
  payload: z.record(z.string(), z.unknown()), emittedAt: isoDateTimeSchema, receivedAt: isoDateTimeSchema,
}).strict();
const runAttemptSchema = z.object({
  id: z.string().uuid(), runId: z.string().uuid(), attemptNumber: z.number().int().positive(),
  deploymentRevisionId: z.string().uuid(), agentVersionId: z.string().uuid(),
  runtimeProfile: z.literal("host_trusted"),
  executor: z.object({ principalType: z.literal("service"), principalId: z.string().min(1) }).strict(),
  fencingToken: z.number().int().positive(),
  status: z.enum(["pending", "running", "cancel_requested", "cancel_acknowledged", "succeeded", "failed", "canceled", "superseded"]),
  lastEventCursor: z.number().int().nonnegative(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(), lease: executionLeaseSchema.nullable(), events: z.array(runEventSchema),
  startedAt: isoDateTimeSchema.nullable(), finishedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema, updatedAt: isoDateTimeSchema,
}).strict();

export const targetWorkspaceV1Schema: z.ZodType<TargetWorkspaceV1> = z.object({
  schemaVersion: z.literal(TARGET_WORKSPACE_SCHEMA_VERSION),
  targetId: z.string().uuid(),
  targetRevisionId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  generatedAt: isoDateTimeSchema,
  graph: z.object({
    workGraphId: z.string().uuid(),
    activeGraphRevisionId: z.string().uuid().nullable(),
    status: z.enum(["draft", "active", "completed", "canceled"]),
    revisionNumber: z.number().int().positive().nullable(),
  }).strict().nullable(),
  stages: z.array(z.object({
    key: stageSchema,
    label: z.string().min(1),
    state: z.enum(["completed", "current", "pending", "blocked"]),
  }).strict()),
  work: z.array(z.object({
    id: z.string().uuid(),
    nodeKey: z.string().min(1),
    graphRevisionId: z.string().uuid(),
    kind: workKindSchema,
    stage: stageSchema,
    status: workStatusSchema,
    title: z.string(),
    responsiblePrincipal: z.object({
      principalType: z.enum(["user", "agent", "service"]),
      principalId: z.string().min(1),
    }).strict().nullable(),
    dependencyNodeKeys: z.array(z.string()),
    completionDefinition: z.string().nullable(),
    updatedAt: isoDateTimeSchema,
  }).strict()),
  attention: z.array(z.object({
    id: z.string().min(1),
    severity: z.enum(["info", "warning", "critical"]),
    kind: z.enum(["draft_graph", "blocked_node", "failed_run", "awaiting_acceptance"]),
    title: z.string().min(1),
    detail: z.string().nullable(),
    workNodeId: z.string().uuid().nullable(),
    runId: z.string().uuid().nullable(),
    createdAt: isoDateTimeSchema,
  }).strict()),
  submissions: z.array(z.object({
    id: z.string().uuid(), targetRevisionId: z.string().uuid(),
    status: z.enum(["draft", "submitted", "withdrawn"]), createdAt: isoDateTimeSchema,
  }).strict()),
  artifacts: z.array(z.object({
    id: z.string().min(1), targetRevisionId: z.string().uuid(), title: z.string(),
    mediaKind: z.string().min(1), href: z.string().min(1), updatedAt: isoDateTimeSchema,
  }).strict()),
  evidence: z.array(z.object({
    id: z.string().min(1), targetRevisionId: z.string().uuid(), criterionId: z.string().nullable(),
    result: z.enum(["passed", "failed", "inconclusive"]), title: z.string(),
    href: z.string().nullable(), createdAt: isoDateTimeSchema,
  }).strict()),
  runs: z.array(z.object({
    id: z.string().uuid(), kind: z.enum(["agent_run", "integration_run"]),
    targetRevisionId: z.string().uuid(), graphRevisionId: z.string().uuid(), workNodeId: z.string().uuid(),
    status: runStatusSchema,
    actor: z.object({ principalType: z.enum(["agent", "service"]), principalId: z.string().min(1) }).strict(),
    deploymentRevisionId: z.string().uuid().nullable(), agentVersionId: z.string().uuid().nullable(),
    attempt: z.number().int().nonnegative(), cancelRequestedAt: isoDateTimeSchema.nullable(),
    attempts: z.array(runAttemptSchema), startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(), createdAt: isoDateTimeSchema,
  }).strict()),
  timeline: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(["target_created", "target_revision_created", "graph_revision_created", "graph_activated", "run_created", "run_updated"]),
    title: z.string().min(1), detail: z.string().nullable(), occurredAt: isoDateTimeSchema,
  }).strict()),
}).strict();

export const targetListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().trim().min(1).max(4_096).optional(),
  collectionId: z.string().uuid().optional(),
  status: z.enum(TARGET_STATUSES).optional(),
  ownerId: z.string().trim().min(1).max(200).optional(),
  attention: z.enum(["true", "false"]).optional(),
  sort: z.enum(["updated_desc"]).optional().default("updated_desc"),
}).strict();

export const createTargetSchema = z.object({
  collectionId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(160),
  summary: nullableTrimmed(2_000),
  outcomeOwner: principalSchema,
  goal: z.string().trim().min(1).max(4_000),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(20),
  acceptanceCriteria: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    description: nullableTrimmed(2_000),
  }).strict()).min(1).max(20),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  deadline: z.iso.date().nullable().optional(),
  policySummary: nullableTrimmed(4_000),
  resourceRefs: z.array(targetResourceRefSchema).max(100).optional().default([]),
}).strict();

export const createGraphRevisionSchema = z.object({
  expectedTargetRevisionId: z.string().uuid(),
  nodes: z.array(z.object({
    nodeKey: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    kind: workKindSchema,
    stage: stageSchema,
    title: z.string().trim().min(1).max(300),
    responsiblePrincipal: z.object({
      principalType: z.enum(["user", "agent", "service"]),
      principalId: z.string().trim().min(1).max(200),
    }).strict().nullable().optional(),
    dependencyNodeKeys: z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]),
    completionDefinition: z.string().trim().min(1).max(4_000),
  }).strict()).max(200),
}).strict();

export const createRunSchema = z.object({
  kind: z.enum(["agent_run", "integration_run"]),
  actor: z.object({
    principalType: z.enum(["agent", "service"]),
    principalId: z.string().trim().min(1).max(200),
  }).strict(),
}).strict();

export const targetIdempotencyKeySchema = z.string()
  .trim().min(8).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Invalid idempotency key");

export type TargetListQuery = z.infer<typeof targetListQuerySchema>;
export type CreateTargetInput = z.infer<typeof createTargetSchema>;
export type CreateGraphRevisionInput = z.infer<typeof createGraphRevisionSchema>;
export type CreateRunInput = z.infer<typeof createRunSchema>;
