import { z } from "zod";
import { repositoryExecutionRequestSchema } from "../repository-execution.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative().nullable();
const messageId = z.string().regex(/^msg_[A-Za-z0-9]+$/).max(128);
const partId = z.string().regex(/^prt_[A-Za-z0-9]+$/).max(128);
const tokens = z.object({ total: count, input: count, output: count, reasoning: count,
  cache: z.object({ read: count, write: count }).strict() }).strict();
const observedTokens = z.object({ total: count.nullable(), input: count.nullable(), output: count.nullable(), reasoning: count.nullable(),
  cache: z.object({ read: count.nullable(), write: count.nullable() }).strict() }).strict();
const model = repositoryExecutionRequestSchema.shape.model;
export const opencodeCandidateRuntimeBindingSchema = z.object({ kind: z.literal("verrail.opencode-session-bound"),
  nativePid: z.number().int().positive(), observerPid: z.number().int().positive(), sessionId: z.string().uuid(),
  manifestSha256: sha256, executionIdentitySha256: sha256,
  httpSession: z.object({ sessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/).max(128), runtimeVersion: z.literal("1.17.13"),
    createdAt: timestamp, homeSha256: sha256 }).strict(),
}).strict();
export const opencodeRuntimeWitnessSchema = z.object({ checkedAt: timestamp,
  permissions: z.object({ default: z.literal("deny"), allowedTools: z.tuple([z.literal("repository_execute_command")]),
    sessionRulesSha256: sha256, configRulesSha256: sha256 }).strict(),
  environment: z.object({ homeSha256: sha256, directory: z.literal("."), config: z.literal("config/opencode"),
    state: z.literal("state/opencode"), worktree: z.enum(["global", "isolated-home"]) }).strict(),
  configuration: z.object({ share: z.literal("disabled"), model, smallModel: model,
    enabledProviders: z.array(z.string().min(1).max(128)).min(1).max(32) }).strict(),
}).strict();
export const opencodeExecutionFactsSchema = z.object({
  runtime: z.literal("opencode"), runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  model, providerId: z.string().min(1).max(128), modelId: z.string().min(1).max(200),
  sessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/).max(128), messageId,
  sessionCreatedAt: timestamp, healthVerifiedAt: timestamp, startedAt: timestamp, finishedAt: timestamp,
  messages: z.array(z.object({ messageId, role: z.enum(["user", "assistant"]), parentMessageId: messageId.nullable(),
    providerId: z.string().min(1).max(128), modelId: z.string().min(1).max(200), createdAt: timestamp,
    completedAt: timestamp.nullable(), finishReason: z.string().min(1).max(128).nullable(),
    steps: z.array(z.object({ startPartId: partId, finishPartId: partId, reason: z.string().min(1).max(128),
      tokens: observedTokens, reportedCostUsd: amount }).strict()).max(10_000),
    unaccountedPartTypes: z.array(z.string().min(1).max(128)).max(100),
    tools: z.array(z.object({ partId, status: z.enum(["completed", "error"]) }).strict()).max(10_000),
  }).strict()).min(2).max(1000),
  fullHistory: z.object({ sha256, projectionSha256: sha256, bytes: z.number().int().min(1).max(2 * 1024 * 1024),
    messageCount: z.number().int().min(2).max(1000), partCount: z.number().int().min(0).max(10_000) }).strict(),
  runtimeWitness: z.object({ before: opencodeRuntimeWitnessSchema, after: opencodeRuntimeWitnessSchema }).strict(),
  candidateRuntime: opencodeCandidateRuntimeBindingSchema.optional(),
  usageStatus: z.enum(["complete", "unavailable"]), usageScope: z.literal("session-step-finish"), usage: tokens.nullable(),
  costStatus: z.literal("unavailable"), costBasis: z.literal("opencode-estimate"), reportedCostUsd: amount,
  cleanup: z.object({ runtime: z.literal(true), home: z.literal(true), commands: z.literal(true) }).strict(),
}).strict();
export const repositoryExecutionIdentitySchema = repositoryExecutionRequestSchema.pick({ workspaceId: true, targetId: true,
  targetRevisionId: true, graphRevisionId: true, workNodeId: true, runId: true, runAttemptId: true, leaseId: true,
  fencingToken: true, agentVersionId: true, deploymentRevisionId: true }).strict();
export const opencodeExecutionLogRefSchema = z.object({ contentHash: sha256, contentRef: z.string().max(256),
  bytes: z.number().int().min(1).max(2 * 1024 * 1024) }).strict();
export const opencodeExecutionObservationSchema = z.object({ schemaVersion: z.literal(1),
  kind: z.literal("verrail.opencode-execution-observation"), identity: repositoryExecutionIdentitySchema,
  requestSha256: sha256, recordedAt: timestamp, facts: opencodeExecutionFactsSchema, log: opencodeExecutionLogRefSchema,
}).strict();
export type OpencodeExecutionObservation = z.infer<typeof opencodeExecutionObservationSchema>;
export const opencodeExecutionProofContextInputSchema = z.object({ workspaceId: z.string().uuid(), targetId: z.string().uuid(),
  targetRevisionId: z.string().uuid(), graphRevisionId: z.string().uuid(), runId: z.string().uuid(), runAttemptId: z.string().uuid(),
  artifactRevisionId: z.string().uuid() }).strict();
