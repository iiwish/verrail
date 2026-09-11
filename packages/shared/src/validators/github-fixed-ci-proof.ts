import { z } from "zod";
import { collectGithubCiObservationSchema } from "./connector.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const key = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const providerId = collectGithubCiObservationSchema.shape.runId;
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const recordGithubFixedCiProofSchema = collectGithubCiObservationSchema.extend({
  claimId: uuid,
  workNodeId: uuid,
  artifactRevisionId: uuid,
  requirementId: key,
}).strict();

export const githubFixedCiProofTrustSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: uuid,
  targetId: uuid,
  targetRevisionId: uuid,
  graphRevisionId: uuid,
  connectionId: uuid,
  bindingId: uuid,
  policySha256: sha256,
  repository: z.string().max(401).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .refine(value => value.split("/").every(part => part !== "." && part !== "..")),
  repositoryId: positiveId,
  workflowId: positiveId,
  workflowExecutionSha: gitSha,
  workflowSha256: sha256,
  helperSha256: sha256,
  maxAgeMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000),
}).strict();

export function parseGithubFixedCiProofTrustConfig(raw: string) {
  if (raw.length > 16_384) throw new Error("Invalid fixed CI trust profile");
  const parsed = githubFixedCiProofTrustSchema.parse(JSON.parse(raw));
  // JSON.parse validates grammar; this flat primitive-only profile also rejects
  // repeated decoded keys, including differently escaped spellings of one key.
  const keys = new Set<string>();
  for (const token of raw.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (!/^\s*:/.test(raw.slice(token.index! + token[0].length))) continue;
    const key: string = JSON.parse(token[0]);
    if (keys.has(key)) throw new Error("Invalid fixed CI trust profile");
    keys.add(key);
  }
  return parsed;
}

/** Internal capability-authenticated command, never a public receipt-ingestion body. */
export const githubFixedCiProofCommandSchema = z.object({
  schemaVersion: z.literal(1),
  targetId: uuid,
  targetRevisionId: uuid,
  graphRevisionId: uuid,
  claimId: uuid,
  workNodeId: uuid,
  artifactRevisionId: uuid,
  criterionKey: z.string().min(1).max(100).refine(value => value.trim() === value),
  requirementId: key,
  source: z.object({
    runId: uuid,
    runAttemptId: uuid,
    runEventId: uuid,
    runEventContentHash: sha256,
    outputReceiptSha256: sha256,
    artifactOrdinal: z.number().int().min(0).max(9),
  }).strict(),
  ci: z.object({
    providerRunId: providerId,
    providerAttempt: collectGithubCiObservationSchema.shape.runAttempt,
    testedCommit: gitSha,
    verifiedAt: z.string().datetime({ offset: true }),
    artifactId: providerId,
    archiveSha256: sha256,
    reportSha256: sha256,
    observationSha256: sha256,
  }).strict(),
  mapping: z.object({
    version: z.literal(1),
    commitTreeSha: gitSha,
    sourceSnapshotTreeSha: gitSha,
    sourceContentSha256: sha256,
  }).strict(),
}).strict();

export const githubFixedCiProofResultSchema = z.object({
  schemaVersion: z.literal(1),
  resourceType: z.literal("integration_run"),
  resourceId: uuid,
  replayed: z.boolean(),
}).strict();

export type RecordGithubFixedCiProofInput = z.infer<typeof recordGithubFixedCiProofSchema>;
export type GithubFixedCiProofTrust = z.infer<typeof githubFixedCiProofTrustSchema>;
export type GithubFixedCiProofCommand = z.infer<typeof githubFixedCiProofCommandSchema>;
export type GithubFixedCiProofResult = z.infer<typeof githubFixedCiProofResultSchema>;
