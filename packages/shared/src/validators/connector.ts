import { z } from "zod";
import { targetIdempotencyKeySchema } from "./target.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Must be a lowercase 64-character sha256 hex digest");

export const connectorIdempotencyKeySchema = targetIdempotencyKeySchema;

export const connectorProviderSchema = z.literal("github");
export const connectorActionTypeSchema = z.literal("create_pull_request");
export const connectorActionStatusSchema = z.enum(["pending_approval", "approved", "executing", "unknown_effect", "executed"]);
export const connectorConclusionSchema = z.enum(["success", "failure", "neutral"]);
export const connectorAttemptStatusSchema = z.enum(["succeeded", "failed", "neutral"]);

const credentialFreeRecordSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const visit = (candidate: unknown, path: Array<string | number>) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, item] of Object.entries(candidate)) {
      if (/(authorization|credential|password|secret|token)/i.test(key)) {
        ctx.addIssue({ code: "custom", message: "payload must not contain credentials", path: [...path, key] });
      }
      visit(item, [...path, key]);
    }
  };
  visit(value, []);
});

export const pullRequestParamsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    head: z.string().trim().min(1).max(200),
    base: z.string().trim().min(1).max(200),
    body: z.string().max(65_536).optional().default(""),
  })
  .strict();

export const recordIntegrationRunSchema = z.object({
  targetId: z.string().uuid(),
  targetRevisionId: z.string().uuid(),
  graphRevisionId: z.string().uuid(),
  claimId: z.string().uuid(),
  workNodeId: z.string().uuid(),
  connectorVersion: z.string().trim().min(1).max(200),
  connectionId: z.string().uuid(),
  provider: connectorProviderSchema,
  externalRef: z.string().trim().min(1).max(300),
  commitRef: z.string().trim().min(1).max(500),
  criterionKey: z.string().trim().min(1).max(100),
  environmentRef: z.string().trim().min(1).max(500),
  conclusion: connectorConclusionSchema,
  objectHash: sha256Hex,
  reference: z.string().trim().min(1).max(500),
  providerReceipt: credentialFreeRecordSchema,
}).strict();

export const recordHumanWorkResultSchema = z.object({
  targetId: z.string().uuid(),
  targetRevisionId: z.string().uuid(),
  graphRevisionId: z.string().uuid(),
  workNodeId: z.string().uuid(),
  inputHash: sha256Hex,
  result: credentialFreeRecordSchema,
  artifactRevisionId: z.string().uuid().nullable().optional(),
  attachmentHashes: z.array(sha256Hex).max(100).default([]),
}).strict();

export const requestPullRequestActionSchema = z.object({
  targetId: z.string().uuid(),
  submissionId: z.string().uuid(),
  params: pullRequestParamsSchema,
}).strict();

/**
 * Wire parity with the review pattern (RecordDeliveryReview): the approver
 * identity fields are accepted on the wire, but the Go store binds the
 * approver to the command principal — self-attested identities are rejected
 * with 403 CONNECTOR_APPROVER_FORBIDDEN.
 */
export const approveActionSchema = z.object({
  actionRequestId: z.string().uuid(),
  approverPrincipalType: z.literal("user"),
  approverPrincipalId: z.string().trim().min(1).max(200),
  paramsHash: sha256Hex,
}).strict();

export const executeActionSchema = z.object({
  actionRequestId: z.string().uuid(),
}).strict();

export const createGithubRepoBindingSchema = z.object({
  connectionId: z.string().uuid(),
  repoOwner: z.string().trim().min(1).max(200),
  repoName: z.string().trim().min(1).max(200),
}).strict();

export type RecordIntegrationRunInput = z.infer<typeof recordIntegrationRunSchema>;
export type RecordHumanWorkResultInput = z.infer<typeof recordHumanWorkResultSchema>;
export type RequestPullRequestActionInput = z.infer<typeof requestPullRequestActionSchema>;
export type ApproveActionInput = z.infer<typeof approveActionSchema>;
export type ExecuteActionInput = z.infer<typeof executeActionSchema>;
export type CreateGithubRepoBindingInput = z.infer<typeof createGithubRepoBindingSchema>;
export type PullRequestParams = z.infer<typeof pullRequestParamsSchema>;
