import { z } from "zod";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const repositorySourceProvenanceSchema = z.object({
  schemaVersion: z.literal(1), workspaceId: uuid, targetId: uuid,
  targetRevisionId: uuid, graphRevisionId: uuid, bindingId: uuid, connectionId: uuid,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(401),
  ref: z.string().min(1).max(256), baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  authorizationContextHash: sha256,
}).strict();

const sourceArtifactSchema = z.object({ artifactId: uuid, artifactRevisionId: uuid, contentHash: sha256 }).strict();
export const repositorySourceReceiptSchema = repositorySourceProvenanceSchema.extend({
  source: sourceArtifactSchema.extend({ baseCommit: z.string().regex(/^[a-f0-9]{40}$/), format: z.literal("git_bundle") }).strict(),
  provenanceArtifact: sourceArtifactSchema,
}).strict().refine(value => value.baseCommit === value.source.baseCommit);
export type RepositorySourceReceipt = z.infer<typeof repositorySourceReceiptSchema>;

// A trusted controller resolves the repository; agents cannot supply a host path,
// arbitrary fetch URL, credential, or conversation capability on this channel.
export const repositoryExecutionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("target_repository_execution"),
  workspaceId: uuid,
  targetId: uuid,
  targetRevisionId: uuid,
  graphRevisionId: uuid,
  workNodeId: uuid,
  runId: uuid,
  runAttemptId: uuid,
  leaseId: uuid,
  fencingToken: z.number().int().positive().max(2147483647),
  agentVersionId: uuid,
  deploymentRevisionId: uuid,
  source: z.object({
    artifactId: uuid,
    contentHash: sha256,
    baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    format: z.literal("git_bundle"),
  }).strict(),
  runtime: z.literal("opencode"),
  model: z.string().regex(/^[^/\s]+\/[^\s]+$/).max(200),
  instructions: z.string().min(1).max(400_000),
  timeoutSeconds: z.number().int().min(1).max(3600),
  output: z.object({
    maxFiles: z.number().int().min(1).max(10),
    maxFileBytes: z.number().int().min(1).max(32 * 1024 * 1024),
    maxTotalBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  }).strict().refine(value => value.maxFileBytes <= value.maxTotalBytes),
}).strict();

export type RepositoryExecutionRequest = z.infer<typeof repositoryExecutionRequestSchema>;
