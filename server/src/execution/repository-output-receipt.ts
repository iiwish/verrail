import { createHash } from "node:crypto";
import { z } from "zod";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { nativeSourceSnapshotSchema } from "../services/verrail-native-source-snapshot.js";
import type { SourceTreeObservation } from "../services/verrail-native-source.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const identitySchema = repositoryExecutionRequestSchema.pick({ workspaceId: true, targetId: true, targetRevisionId: true,
  graphRevisionId: true, workNodeId: true, runId: true, runAttemptId: true, leaseId: true, fencingToken: true,
  agentVersionId: true, deploymentRevisionId: true }).strip();
export const repositorySourceBindingSchema = z.object({ repositorySourceRevisionId: z.string().uuid(), provenanceContentHash: sha256 }).strict();
export type RepositorySourceBinding = z.infer<typeof repositorySourceBindingSchema>;
export const repositoryRuntimeFactsSchema = z.object({
  runtime: z.literal("opencode"), runtimeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  model: repositoryExecutionRequestSchema.shape.model, startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  cleanup: z.object({ runtime: z.literal(true), commands: z.literal(true), home: z.literal(true) }).strict(),
}).strict();
export type RepositoryRuntimeFacts = z.infer<typeof repositoryRuntimeFactsSchema>;
export const repositoryExecutionObservationRefSchema = z.object({ contentHash: sha256, contentRef: z.string().max(256),
  bytes: z.number().int().min(1).max(64 * 1024) }).strict();
const sourceSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("verrail.repository-source-observation"),
  phase: z.enum(["before_collection", "after_collection"]), status: z.literal("captured"), observedAt: z.iso.datetime(), scopeVersion: z.literal(2),
  repository: z.object({ headCommit: sha1, headTree: sha1, objectFormat: z.literal("sha1") }).strict(),
  manifest: z.object({ sha256, contentSha256: sha256, files: z.number().int().min(0).max(20_000),
    deletedFiles: z.number().int().min(0).max(20_000), bytes: z.number().int().min(0).max(512 * 1024 * 1024) }).strict(),
}).strict();
const fileSchema = z.object({ ordinal: z.number().int().min(0).max(9),
  path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).refine(value => value !== "manifest.json"),
  title: z.string().trim().min(1).max(200), kind: z.enum(["code_change", "document", "report"]),
  bytes: z.number().int().min(1).max(32 * 1024 * 1024), contentHash: sha256, contentRef: z.string().max(200),
}).strict();
export const repositoryOutputArtifactSchema = z.discriminatedUnion("type", [
  fileSchema.extend({ type: z.literal("file") }),
  fileSchema.extend({ type: z.literal("source_snapshot"), kind: z.literal("code_change"), sourceSnapshot: nativeSourceSnapshotSchema }),
]);
export const repositoryOutputReceiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("verrail.repository-output-receipt"), phase: z.literal("after_runtime_cleanup"),
  identity: identitySchema.strict(), requestSha256: sha256, inputSource: repositoryExecutionRequestSchema.shape.source,
  sourceBinding: repositorySourceBindingSchema,
  executionFacts: repositoryRuntimeFactsSchema.extend({ requestSha256: sha256, exitCode: z.literal(0),
    cleanup: repositoryRuntimeFactsSchema.shape.cleanup.extend({ checkout: z.literal(true) }).strict(),
  }).strict(),
  sourceBefore: sourceSchema, sourceAfter: sourceSchema, sourceStatus: z.literal("stable"), collectionStatus: z.literal("collected"),
  artifacts: z.array(repositoryOutputArtifactSchema).min(1).max(10), finalizedAt: z.iso.datetime(), sha256,
  executionObservation: repositoryExecutionObservationRefSchema.optional(),
}).strict();
export type RepositoryOutputReceipt = z.infer<typeof repositoryOutputReceiptSchema>;

export function repositoryRequestSha256(input: RepositoryExecutionRequest) {
  return createHash("sha256").update(JSON.stringify(repositoryExecutionRequestSchema.parse(input))).digest("hex");
}
function digest(value: unknown) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
export function repositorySourceObservation(source: SourceTreeObservation, phase: "before_collection" | "after_collection") {
  if (source.status !== "captured" || source.scope.version !== 2 || !source.repository || !source.manifest) {
    throw new Error("REPOSITORY_OUTPUT_SOURCE_INVALID");
  }
  return sourceSchema.parse({ schemaVersion: 1, kind: "verrail.repository-source-observation", phase, status: "captured",
    observedAt: source.observedAt, scopeVersion: 2, repository: { headCommit: source.repository.headCommit,
      headTree: source.repository.headTree, objectFormat: source.repository.objectFormat }, manifest: source.manifest });
}

// The digest is correlation, not authorship: admission also requires the durable
// trusted repository dispatch, its fenced Go Attempt and verified source binding.
export function validateRepositoryOutputReceipt(raw: unknown, input: RepositoryExecutionRequest): RepositoryOutputReceipt | null {
  const request = repositoryExecutionRequestSchema.parse(input);
  const parsed = repositoryOutputReceiptSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  const hash = repositoryRequestSha256(request);
  const before = value.sourceBefore;
  const after = value.sourceAfter;
  if (value.executionObservation && value.executionObservation.contentRef
    !== `storage:${request.workspaceId}/verrail/repository-execution-observations/sha256/${value.executionObservation.contentHash}`) return null;
  if (canonicalJson(value.identity) !== canonicalJson(identitySchema.parse(request))
    || value.requestSha256 !== hash || value.executionFacts.requestSha256 !== hash
    || value.executionFacts.model !== request.model || value.executionFacts.runtime !== request.runtime
    || canonicalJson(value.inputSource) !== canonicalJson(request.source)
    || before.phase !== "before_collection" || after.phase !== "after_collection"
    || canonicalJson(before.repository) !== canonicalJson(after.repository)
    || canonicalJson(before.manifest) !== canonicalJson(after.manifest)
    || value.artifacts.length > request.output.maxFiles
    || value.artifacts.reduce((total, artifact) => total + artifact.bytes, 0) > request.output.maxTotalBytes
    || new Set(value.artifacts.map(artifact => artifact.path)).size !== value.artifacts.length
    || !value.artifacts.some(artifact => artifact.type === "source_snapshot")
    || value.artifacts.some((artifact, ordinal) => artifact.ordinal !== ordinal || artifact.bytes > request.output.maxFileBytes
      || artifact.contentRef !== `storage:${request.workspaceId}/verrail/run-artifacts/sha256/${artifact.contentHash}`
      || (artifact.type === "source_snapshot" && (artifact.path !== `source-${ordinal}.bundle`
        || artifact.sourceSnapshot.sourceContentSha256 !== after.manifest.contentSha256)))) return null;
  const times = [value.executionFacts.startedAt, value.executionFacts.finishedAt, before.observedAt, after.observedAt, value.finalizedAt].map(Date.parse);
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) return null;
  const { sha256: expected, ...canonical } = value;
  return digest(canonical) === expected ? value : null;
}

export function finalizeRepositoryOutputReceipt(input: Omit<RepositoryOutputReceipt, "sha256">, request: RepositoryExecutionRequest) {
  const canonical = repositoryOutputReceiptSchema.omit({ sha256: true }).parse(input);
  const result = validateRepositoryOutputReceipt({ ...canonical, sha256: digest(canonical) }, request);
  if (!result) throw new Error("REPOSITORY_OUTPUT_RECEIPT_INVALID");
  return result;
}
