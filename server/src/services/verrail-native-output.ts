import { createHash } from "node:crypto";
import { z } from "zod";
import type { StorageService } from "../storage/types.js";
import { captureNativeSource, unavailableNativeSource, validateNativeSourceObservation, type NativeSourceIdentity, type NativeSourceObservation } from "./verrail-native-source.js";
import { NativeRunArtifactError, prepareNativeRunArtifacts } from "./verrail-run-artifacts.js";

export const NATIVE_OUTPUT_CONTEXT_KEY = "verrailNativeOutputReceipt";
export const NATIVE_OUTPUT_TIMEOUT_MS = 60_000;
type OutputFailureCode = "NATIVE_OUTPUT_DEADLINE_EXCEEDED" | "NATIVE_OUTPUT_BINDING_INVALID"
  | "NATIVE_ARTIFACT_INVALID" | "NATIVE_OUTPUT_UPLOAD_FAILED" | "NATIVE_OUTPUT_SOURCE_INVALID"
  | "NATIVE_OUTPUT_SOURCE_CHANGED" | "NATIVE_OUTPUT_RECEIPT_INVALID" | "NATIVE_OUTPUT_FACTS_INVALID";
class NativeOutputFailure extends Error {
  constructor(code: OutputFailureCode) { super(code); this.name = "NativeOutputFailure"; }
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
const identitySchema = z.object({ workspaceId: id, heartbeatRunId: id, agentId: id, runId: id, attemptId: id, deploymentRevisionId: id, agentVersionId: id }).strict();
const environmentSchema = z.object({ schemaVersion: z.literal(1), source: z.literal("deployment_revision"), cwd: z.string().max(4096), requestedCwd: z.string().max(4096), deploymentRevisionId: id, agentVersionId: id, workspaceId: id, heartbeatRunId: id, agentId: id, runId: id, attemptId: id, contentHash: hash }).strict();
const factsSchema = z.object({
  heartbeatRunId: id, heartbeatStatus: z.literal("succeeded"), agentId: id,
  logStore: z.string().max(128).nullable(), logRef: z.string().max(4096).nullable(), logSha256: z.string().max(128).nullable(), logBytes: z.number().int().nonnegative().nullable(),
  usage: z.record(z.string().max(128), z.json()).nullable().refine((value) => JSON.stringify(value).length <= 16_384),
  exitCode: z.number().int().nullable(), errorCode: z.string().max(128).nullable(), environmentManifest: environmentSchema.nullable(),
}).strict();
const receiptSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("verrail.native-output-receipt"), phase: z.literal("after_adapter_return"),
  identity: identitySchema,
  beforeSource: z.custom<NativeSourceObservation>(), sourceBefore: z.custom<NativeSourceObservation>(), sourceAfter: z.custom<NativeSourceObservation>(),
  sourceStatus: z.enum(["stable", "unavailable"]), collectionStatus: z.enum(["collected", "no_manifest", "unsupported"]),
  readStartedAt: z.iso.datetime(), readFinishedAt: z.iso.datetime(), uploadStartedAt: z.iso.datetime(), uploadFinishedAt: z.iso.datetime(),
  artifacts: z.array(z.object({ ordinal: z.number().int().min(0).max(9), path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).refine((p) => p !== "manifest.json"), title: z.string().trim().min(1).max(200), kind: z.enum(["code_change", "document", "report"]), bytes: z.number().int().min(1).max(32 * 1024 * 1024), contentHash: hash, contentRef: z.string().max(512) }).strict()).max(10),
  executionFacts: factsSchema.optional(),
  finalizedAt: z.iso.datetime().optional(),
  sha256: hash,
}).strict();
export type NativeOutputReceipt = z.infer<typeof receiptSchema>;
function digest(receipt: Omit<NativeOutputReceipt, "sha256">) {
  return createHash("sha256").update(JSON.stringify(receipt, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value)).digest("hex");
}
function stable(a: NativeSourceObservation, b: NativeSourceObservation) {
  return a.status === "captured" && b.status === "captured"
    && JSON.stringify(a.repository) === JSON.stringify(b.repository)
    && JSON.stringify(a.scope) === JSON.stringify(b.scope)
    && JSON.stringify(a.manifest) === JSON.stringify(b.manifest);
}

// Authorship comes from the trusted database association, not this structural digest.
export function validateNativeOutputReceipt(raw: unknown, identity: NativeSourceIdentity): NativeOutputReceipt | null {
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (Object.keys(identitySchema.shape).some((key) => value.identity[key as keyof NativeSourceIdentity] !== identity[key as keyof NativeSourceIdentity])) return null;
  const beforeSource = validateNativeSourceObservation(value.beforeSource, identity);
  const sourceBefore = validateNativeSourceObservation(value.sourceBefore, identity, "after_adapter_return");
  const sourceAfter = validateNativeSourceObservation(value.sourceAfter, identity, "after_adapter_return");
  if (!beforeSource || !sourceBefore || !sourceAfter) return null;
  if (value.executionFacts && (value.executionFacts.heartbeatRunId !== identity.heartbeatRunId || value.executionFacts.agentId !== identity.agentId
    || (value.executionFacts.exitCode !== null && value.executionFacts.exitCode !== 0) || value.executionFacts.errorCode !== null)) return null;
  if (!!value.executionFacts !== !!value.finalizedAt || (value.finalizedAt && Date.parse(value.finalizedAt) < Date.parse(value.uploadFinishedAt))) return null;
  const environment = value.executionFacts?.environmentManifest;
  if (environment && Object.keys(identitySchema.shape).some((key) => environment[key as keyof NativeSourceIdentity] !== identity[key as keyof NativeSourceIdentity])) return null;
  const times = [beforeSource.observedAt, sourceBefore.observedAt, value.readStartedAt, value.readFinishedAt, sourceAfter.observedAt, value.uploadStartedAt, value.uploadFinishedAt].map(Date.parse);
  if (times.some((time, index) => index > 0 && time < times[index - 1]!)) return null;
  if (value.sourceStatus !== (stable(sourceBefore, sourceAfter) ? "stable" : "unavailable")) return null;
  if (sourceBefore.status === "captured" && sourceAfter.status === "captured" && !stable(sourceBefore, sourceAfter)) return null;
  if ((value.collectionStatus === "collected") !== (value.artifacts.length > 0)) return null;
  if (value.collectionStatus === "unsupported" && (sourceBefore.reasonCode !== "unsupported_execution" && sourceBefore.reasonCode !== "cwd_mismatch")) return null;
  if (value.artifacts.reduce((total, entry) => total + entry.bytes, 0) > 64 * 1024 * 1024
    || new Set(value.artifacts.map((entry) => entry.path)).size !== value.artifacts.length
    || value.artifacts.some((entry, index) => entry.ordinal !== index || entry.contentRef !== `storage:${identity.workspaceId}/verrail/run-artifacts/sha256/${entry.contentHash}`)) return null;
  const { sha256, ...canonical } = { ...value, beforeSource, sourceBefore, sourceAfter };
  return digest(canonical) === sha256 ? { ...canonical, sha256 } : null;
}

export function finalizeNativeOutputReceipt(receipt: NativeOutputReceipt, facts: unknown, finalizedAt = new Date().toISOString()): NativeOutputReceipt {
  const { sha256: _, ...base } = receipt;
  const parsedFacts = factsSchema.safeParse(facts);
  if (!parsedFacts.success) throw new NativeOutputFailure("NATIVE_OUTPUT_FACTS_INVALID");
  const canonical = { ...base, executionFacts: parsedFacts.data, finalizedAt };
  const result = validateNativeOutputReceipt({ ...canonical, sha256: digest(canonical) }, receipt.identity);
  if (!result) throw new NativeOutputFailure("NATIVE_OUTPUT_FACTS_INVALID");
  return result;
}

export async function captureNativeOutput(input: {
  cwd: string; identity: NativeSourceIdentity; beforeSource: NativeSourceObservation;
  storage?: Pick<StorageService, "putFile">;
  revalidate: () => Promise<void>;
  timeoutMs?: number;
}): Promise<NativeOutputReceipt> {
  const beforeSource = validateNativeSourceObservation(input.beforeSource, input.identity);
  if (!beforeSource) throw new NativeOutputFailure("NATIVE_OUTPUT_SOURCE_INVALID");
  const timeout = input.timeoutMs ?? NATIVE_OUTPUT_TIMEOUT_MS;
  const deadline = performance.now() + (Number.isSafeInteger(timeout) ? Math.max(0, Math.min(timeout, NATIVE_OUTPUT_TIMEOUT_MS)) : 0);
  let expired = false;
  const check = () => {
    if (expired || performance.now() >= deadline) {
      expired = true;
      throw new NativeOutputFailure("NATIVE_OUTPUT_DEADLINE_EXCEEDED");
    }
  };
  const bounded = async <T>(work: () => Promise<T>, failureCode: OutputFailureCode): Promise<T> => {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new NativeOutputFailure("NATIVE_OUTPUT_DEADLINE_EXCEEDED"));
        }, Math.max(0, deadline - performance.now()));
      })]);
    } catch (error) {
      // Provider errors and parser causes can contain output bytes or credentials.
      // Only closed diagnostics cross into heartbeat persistence and logging.
      if (expired) throw new NativeOutputFailure("NATIVE_OUTPUT_DEADLINE_EXCEEDED");
      if (error instanceof NativeOutputFailure) throw error;
      throw new NativeOutputFailure(error instanceof NativeRunArtifactError ? "NATIVE_ARTIFACT_INVALID" : failureCode);
    } finally { if (timer) clearTimeout(timer); }
  };
  await bounded(input.revalidate, "NATIVE_OUTPUT_BINDING_INVALID");
  const unsupported = beforeSource.reasonCode === "unsupported_execution" || beforeSource.reasonCode === "cwd_mismatch";
  const scan = () => unsupported
    ? Promise.resolve(unavailableNativeSource(input.identity, beforeSource.reasonCode!, "after_adapter_return"))
    : captureNativeSource({ cwd: input.cwd, identity: input.identity, phase: "after_adapter_return", limits: { timeoutMs: Math.max(0, Math.floor(deadline - performance.now())) } });
  const sourceBefore = await bounded(scan, "NATIVE_OUTPUT_SOURCE_INVALID");
  const emptyTime = new Date().toISOString();
  const prepared = unsupported ? null : await bounded(() => prepareNativeRunArtifacts({ cwd: input.cwd, workspaceId: input.identity.workspaceId, runAttemptId: input.identity.attemptId, check }), "NATIVE_ARTIFACT_INVALID");
  const sourceAfter = await bounded(scan, "NATIVE_OUTPUT_SOURCE_INVALID");
  if (sourceBefore.status === "captured" && sourceAfter.status === "captured" && !stable(sourceBefore, sourceAfter)) throw new NativeOutputFailure("NATIVE_OUTPUT_SOURCE_CHANGED");
  await bounded(input.revalidate, "NATIVE_OUTPUT_BINDING_INVALID");
  const uploadStartedAt = new Date().toISOString();
  const artifacts = prepared ? await bounded(() => prepared.upload(input.storage), "NATIVE_OUTPUT_UPLOAD_FAILED") : [];
  await bounded(input.revalidate, "NATIVE_OUTPUT_BINDING_INVALID");
  check();
  const value: Omit<NativeOutputReceipt, "sha256"> = {
    schemaVersion: 1, kind: "verrail.native-output-receipt", phase: "after_adapter_return", identity: identitySchema.parse(input.identity),
    beforeSource, sourceBefore, sourceAfter, sourceStatus: stable(sourceBefore, sourceAfter) ? "stable" : "unavailable",
    collectionStatus: prepared?.collectionStatus ?? "unsupported", readStartedAt: prepared?.readStartedAt ?? emptyTime,
    readFinishedAt: prepared?.readFinishedAt ?? emptyTime, uploadStartedAt, uploadFinishedAt: new Date().toISOString(), artifacts,
  };
  // Schema validation and sorted-key hashing preserve the digest through JSONB ordering.
  const normalized = receiptSchema.parse({ ...value, sha256: "0".repeat(64) });
  const { sha256: _, ...canonical } = normalized;
  const receipt = validateNativeOutputReceipt({ ...canonical, sha256: digest(canonical) }, input.identity);
  if (!receipt) throw new NativeOutputFailure("NATIVE_OUTPUT_RECEIPT_INVALID");
  return receipt;
}
