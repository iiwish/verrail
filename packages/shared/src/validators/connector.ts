import { z } from "zod";
import { targetIdempotencyKeySchema } from "./target.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Must be a lowercase 64-character sha256 hex digest");

export const connectorIdempotencyKeySchema = targetIdempotencyKeySchema;

export const connectorProviderSchema = z.literal("github");
export const connectorActionTypeSchema = z.literal("create_pull_request");
export const connectorActionStatusSchema = z.enum(["pending_approval", "approved", "executed"]);
export const connectorConclusionSchema = z.enum(["success", "failure", "neutral"]);

export const pullRequestParamsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    head: z.string().trim().min(1).max(200),
    base: z.string().trim().min(1).max(200),
  })
  .strict();

export const recordIntegrationRunSchema = z.object({
  targetId: z.string().uuid(),
  claimId: z.string().uuid(),
  workNodeId: z.string().uuid().nullable().optional(),
  provider: connectorProviderSchema,
  externalRef: z.string().trim().min(1).max(300),
  conclusion: connectorConclusionSchema,
  objectHash: sha256Hex,
  reference: z.string().trim().min(1).max(500),
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
export type RequestPullRequestActionInput = z.infer<typeof requestPullRequestActionSchema>;
export type ApproveActionInput = z.infer<typeof approveActionSchema>;
export type ExecuteActionInput = z.infer<typeof executeActionSchema>;
export type CreateGithubRepoBindingInput = z.infer<typeof createGithubRepoBindingSchema>;
export type PullRequestParams = z.infer<typeof pullRequestParamsSchema>;
