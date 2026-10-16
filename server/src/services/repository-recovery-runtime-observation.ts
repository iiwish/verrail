import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { openCodeCandidateIdentitySchema, openCodeCandidateWitnessSchema, openCodeObserverConfigurationSchema } from "./opencode-runtime-observation.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), time = z.iso.datetime(), uuid = z.string().uuid();
const pid = z.number().int().positive();
export const repositoryRecoveryEnvelopeSchema = z.object({ schemaVersion: z.literal(1), payload: z.string().min(1).max(900_000),
  signature: z.string().min(1).max(128) }).strict();
export type RecoveryEnvelope = z.infer<typeof repositoryRecoveryEnvelopeSchema>;
export const recoveryRuntimeDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const recoveryProcessIdentitySchema = z.object({ bootId: uuid, pid, pgid: pid, sessionId: pid,
  startTicks: z.string().regex(/^[1-9][0-9]*$/) }).strict();
export type RecoveryProcessIdentity = z.infer<typeof recoveryProcessIdentitySchema>;
const nodeObservation = openCodeCandidateWitnessSchema.shape.observation.options[0];
const snapshot = z.object({ process: recoveryProcessIdentitySchema, observation: nodeObservation }).strict();
const common = { schemaVersion: z.literal(1), recoverySessionId: uuid, nonce: uuid, identity: openCodeCandidateIdentitySchema,
  candidateSessionId: uuid, runtimeManifestSha256: hash, configurationSha256: hash };
export const repositoryRecoveryReadySchema = z.object({ ...common, kind: z.literal("verrail.repository-recovery-runtime-ready"),
  observerProcess: recoveryProcessIdentitySchema, verifierBuildSha256: hash, observerExecutableSha256: hash,
  old: snapshot, observedAt: time }).strict();
export type RepositoryRecoveryReady = z.infer<typeof repositoryRecoveryReadySchema>;
export const recoveryOwnedCleanupSchema = z.object({
  basis: z.literal("candidate_executor_typed_output_receipt_and_signed_opencode_termination"),
  outputReceiptSha256: hash, terminationEnvelopeSha256: hash, executionSessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/),
  observerPid: pid, nativePid: pid, terminatedAt: time, checkedAt: time,
}).strict();
export const repositoryRecoveryAuthorizationSchema = z.object({ ...common, kind: z.literal("verrail.repository-recovery-authorize"),
  oldReadySha256: hash, oldRuntimeWitnessEnvelopeSha256: hash, preRuntimeProofSha256: hash,
  beforeCheckpointSha256: hash, beforeObservedAt: time, issuedAt: time, expiresAt: time,
  ownedCleanup: recoveryOwnedCleanupSchema,
}).strict();
export type RepositoryRecoveryAuthorization = z.infer<typeof repositoryRecoveryAuthorizationSchema>;
const stopped = z.object({ process: recoveryProcessIdentitySchema, requestedSignal: z.literal("SIGTERM"),
  termSentAt: time, killSentAt: time.nullable(), stoppedAt: time, processGroupGone: z.literal(true), processReaped: z.literal(true) }).strict();
export type RecoveryStoppedProcess = z.infer<typeof stopped>;
const gone = z.object({ observerPid: pid, nativePid: pid, checkedAt: time, processGroupsGone: z.literal(true),
  basis: recoveryOwnedCleanupSchema.shape.basis, outputReceiptSha256: hash, terminationEnvelopeSha256: hash }).strict();
export const repositoryRecoveryTransitionSchema = z.object({ ...common, kind: z.literal("verrail.repository-recovery-runtime-transition"),
  oldReadySha256: hash, authorizationSha256: hash, beforeCheckpointSha256: hash,
  old: snapshot, oldStopped: stopped, ownedCleanup: gone, next: snapshot, observedAt: time }).strict();
export type RepositoryRecoveryTransition = z.infer<typeof repositoryRecoveryTransitionSchema>;
export const recoveryOlderAttemptSchema = z.object({ runAttemptId: uuid, leaseId: uuid, fencingToken: pid, attemptNumber: pid, cursor: pid }).strict();
export const repositoryRecoveryProbeAuthorizationSchema = z.object({ ...common, kind: z.literal("verrail.repository-recovery-probe-authorize"),
  authorizationSha256: hash, transitionSha256: hash, beforeCheckpointSha256: hash,
  completionBaselineSha256: hash, staleCheckpointSha256: hash, olderAttempt: recoveryOlderAttemptSchema,
  baselineObservedAt: time, issuedAt: time, expiresAt: time }).strict();
export type RepositoryRecoveryProbeAuthorization = z.infer<typeof repositoryRecoveryProbeAuthorizationSchema>;
const staleProbe = z.object({ workspaceId: uuid, runId: uuid, runAttemptId: uuid, idempotencyKey: z.string().min(1).max(200),
  input: z.object({ leaseId: uuid, fencingToken: pid, cursor: pid, eventType: z.literal("heartbeat"),
    emittedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/) }).strict() }).strict();
const ipcRequest = { schemaVersion: z.literal(1), kind: z.literal("verrail.repository-recovery-ipc-request"),
  recoverySessionId: uuid, nonce: uuid, identity: openCodeCandidateIdentitySchema, challenge: uuid,
  authorization: repositoryRecoveryEnvelopeSchema, issuedAt: time, expiresAt: time };
export const repositoryRecoveryIpcRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...ipcRequest, operation: z.literal("reconcile"), probe: z.null() }).strict(),
  z.object({ ...ipcRequest, operation: z.literal("stale_heartbeat"), probe: staleProbe }).strict(),
]);
export type RepositoryRecoveryIpcRequest = z.infer<typeof repositoryRecoveryIpcRequestSchema>;
export const recoveryStaleResponseSchema = z.object({ schemaVersion: z.literal(1), runId: uuid, runAttemptId: uuid,
  cursor: pid, eventType: z.literal("heartbeat"), authoritative: z.literal(false), rejectionCode: z.literal("STALE_FENCING_TOKEN"),
  runStatus: z.literal("succeeded"), attemptStatus: z.enum(["failed", "superseded"]), leaseStatus: z.enum(["expired", "revoked"]),
  replayed: z.literal(false) }).strict();
const ipcResponse = { schemaVersion: z.literal(1), kind: z.literal("verrail.repository-recovery-ipc-response"),
  challenge: uuid, requestSha256: hash, executorPid: pid, completedAt: time };
export const repositoryRecoveryIpcResponseSchema = z.discriminatedUnion("operation", [
  z.object({ ...ipcResponse, operation: z.literal("reconcile"), result: z.object({ status: z.literal("registered") }).strict() }).strict(),
  z.object({ ...ipcResponse, operation: z.literal("stale_heartbeat"), result: recoveryStaleResponseSchema }).strict(),
]);
export type RepositoryRecoveryIpcResponse = z.infer<typeof repositoryRecoveryIpcResponseSchema>;
export const repositoryRecoveryProbeJournalSchema = z.object({ ...common, kind: z.literal("verrail.repository-recovery-probe-journal"),
  probeAuthorizationSha256: hash, transitionSha256: hash, operation: z.enum(["reconcile", "stale_heartbeat"]),
  executor: recoveryProcessIdentitySchema, before: snapshot, after: snapshot,
  request: z.string().min(1).max(8192), requestSha256: hash, requestBytes: pid.max(8192),
  response: z.string().min(1).max(8192), responseSha256: hash, responseBytes: pid.max(8192),
  issuedAt: time, receivedAt: time }).strict();
export type RepositoryRecoveryProbeJournal = z.infer<typeof repositoryRecoveryProbeJournalSchema>;
export const repositoryRecoveryCompletionAuthorizationSchema = z.object({ ...common,
  kind: z.literal("verrail.repository-recovery-complete-authorize"), authorizationSha256: hash, transitionSha256: hash,
  probeAuthorizationSha256: hash, duplicateJournalSha256: hash, staleJournalSha256: hash,
  beforeCheckpointSha256: hash, afterCheckpointSha256: hash, afterObservedAt: time, issuedAt: time, expiresAt: time,
}).strict();
export type RepositoryRecoveryCompletionAuthorization = z.infer<typeof repositoryRecoveryCompletionAuthorizationSchema>;
export const repositoryRecoveryFinalSchema = z.object({ ...common, kind: z.literal("verrail.repository-recovery-runtime-final"),
  oldReadySha256: hash, authorizationSha256: hash, transitionSha256: hash, completionAuthorizationSha256: hash,
  beforeCheckpointSha256: hash, afterCheckpointSha256: hash,
  oldStopped: stopped, next: snapshot, nextStopped: stopped, ownedCleanup: gone, observedAt: time }).strict();
export type RepositoryRecoveryFinal = z.infer<typeof repositoryRecoveryFinalSchema>;
export const repositoryRecoveryReaderPayloadSchema = z.union([repositoryRecoveryAuthorizationSchema, repositoryRecoveryProbeAuthorizationSchema, repositoryRecoveryCompletionAuthorizationSchema]);
export const repositoryRecoveryObserverPayloadSchema = z.union([repositoryRecoveryReadySchema, repositoryRecoveryTransitionSchema, repositoryRecoveryProbeJournalSchema, repositoryRecoveryFinalSchema]);
export function repositoryRecoveryRuntimePaths(directory: string, recoverySessionId: string) {
  uuid.parse(recoverySessionId); if (!path.isAbsolute(directory)) throw new Error("REPOSITORY_RECOVERY_RUNTIME_UNAVAILABLE");
  const prefix = path.join(directory, `${recoverySessionId}-recovery`);
  return { ready: `${prefix}.ready.json`, authorize: `${prefix}.authorize.json`, transition: `${prefix}.transition.json`,
    probeAuthorize: `${prefix}.probe-authorize.json`, verifiedProbeAuthorization: `${prefix}.probe-authorization.verified.json`,
    duplicateJournal: `${prefix}.duplicate-journal.json`, staleJournal: `${prefix}.stale-journal.json`,
    complete: `${prefix}.complete.json`, final: `${prefix}.final.json`,
    verifiedAuthorization: `${prefix}.authorization.verified.json`, verifiedCompletion: `${prefix}.completion-authorization.verified.json` };
}
const domain = (role: "reader" | "observer") => Buffer.from(`verrail.repository-recovery-${role}.v1\0`);
const fail = () => new Error("REPOSITORY_RECOVERY_RUNTIME_UNAVAILABLE");

export function signRecoveryReaderEnvelope(raw: z.input<typeof repositoryRecoveryReaderPayloadSchema>, privateKey: string): RecoveryEnvelope {
  return signEnvelope(repositoryRecoveryReaderPayloadSchema.parse(raw), privateKey, "reader");
}
export function signRecoveryObserverEnvelope(raw: z.input<typeof repositoryRecoveryObserverPayloadSchema>, privateKey: string): RecoveryEnvelope {
  return signEnvelope(repositoryRecoveryObserverPayloadSchema.parse(raw), privateKey, "observer");
}
function signEnvelope(value: unknown, privateKey: string, role: "reader" | "observer"): RecoveryEnvelope {
  const key = createPrivateKey(privateKey); if (key.asymmetricKeyType !== "ed25519") throw fail();
  const bytes = Buffer.from(canonicalJson(value));
  return repositoryRecoveryEnvelopeSchema.parse({ schemaVersion: 1, payload: bytes.toString("base64"),
    signature: sign(null, Buffer.concat([domain(role), bytes]), key).toString("base64") });
}
export function verifyRecoveryReaderEnvelope(raw: unknown, publicKey: string) {
  return repositoryRecoveryReaderPayloadSchema.parse(verifyEnvelope(raw, publicKey, "reader"));
}
export function verifyRecoveryObserverEnvelope(raw: unknown, publicKey: string) {
  return repositoryRecoveryObserverPayloadSchema.parse(verifyEnvelope(raw, publicKey, "observer"));
}
function verifyEnvelope(raw: unknown, publicKey: string, role: "reader" | "observer") {
  const envelope = repositoryRecoveryEnvelopeSchema.parse(raw), key = createPublicKey(publicKey);
  const bytes = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "base64");
  if (key.asymmetricKeyType !== "ed25519" || bytes.toString("base64") !== envelope.payload || signature.toString("base64") !== envelope.signature
    || !verify(null, Buffer.concat([domain(role), bytes]), key, signature)) throw fail();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export const repositoryRecoveryRuntimeConfigurationSchema = z.object({ schemaVersion: z.literal(1),
  kind: z.literal("verrail.repository-recovery-runtime-config"), recoverySessionId: uuid, candidateSessionId: uuid,
  identity: openCodeCandidateIdentitySchema, runtimeManifestSha256: hash, sourceManifestSha256: hash,
  verifierBuildSha256: hash, observerExecutableSha256: hash, directory: z.string().min(1),
  privateKey: z.string().min(1).max(4096), readerPublicKey: z.string().min(1).max(4096), readerPublicKeySha256: hash,
  node: openCodeObserverConfigurationSchema.shape.node.unwrap(),
}).strict();
export type RepositoryRecoveryRuntimeConfiguration = z.infer<typeof repositoryRecoveryRuntimeConfigurationSchema>;
export const recoveryIpcConfigurationSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("verrail.repository-recovery-ipc-config"),
  recoverySessionId: uuid, identity: openCodeCandidateIdentitySchema,
  observerExecutable: z.string().refine(path.isAbsolute), observerExecutableSha256: hash,
  observerEntrypoint: z.string().refine(path.isAbsolute), observerEntrypointSha256: hash,
  readerPublicKey: z.string().min(1).max(4096), readerPublicKeySha256: hash }).strict();
export type RecoveryIpcConfiguration = z.infer<typeof recoveryIpcConfigurationSchema>;
export function validateRecoveryIpcConfigurationBinding(ipc: RecoveryIpcConfiguration,
  config: Pick<RepositoryRecoveryRuntimeConfiguration, "recoverySessionId" | "identity" | "readerPublicKey" | "readerPublicKeySha256" | "observerExecutableSha256" | "verifierBuildSha256">,
  actual: { configurationSha256: string; executable: string; entrypoint: string }) {
  recoveryIpcConfigurationSchema.parse(ipc);
  if (recoveryRuntimeDigest(ipc) !== actual.configurationSha256 || ipc.recoverySessionId !== config.recoverySessionId
    || canonicalJson(ipc.identity) !== canonicalJson(config.identity) || ipc.readerPublicKey !== config.readerPublicKey
    || ipc.readerPublicKeySha256 !== config.readerPublicKeySha256 || ipc.observerExecutable !== actual.executable
    || ipc.observerExecutableSha256 !== config.observerExecutableSha256 || ipc.observerEntrypoint !== actual.entrypoint
    || ipc.observerEntrypointSha256 !== config.verifierBuildSha256) throw fail();
}

function readerWindow(value: z.infer<typeof repositoryRecoveryReaderPayloadSchema>, ready: RepositoryRecoveryReady) {
  equalCommon(value, ready);
  const issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
  if (!(expires > issued && expires - issued <= 30_000)) throw fail();
}
function activeReaderWindow(value: z.infer<typeof repositoryRecoveryReaderPayloadSchema>, ready: RepositoryRecoveryReady) {
  readerWindow(value, ready);
  if (!(Date.parse(value.issuedAt) <= Date.now() && Date.now() <= Date.parse(value.expiresAt))) throw fail();
}
function equalCommon(value: z.infer<typeof repositoryRecoveryObserverPayloadSchema> | z.infer<typeof repositoryRecoveryReaderPayloadSchema>, ready: RepositoryRecoveryReady) {
  for (const field of ["recoverySessionId", "nonce", "identity", "candidateSessionId", "runtimeManifestSha256", "configurationSha256"] as const) {
    if (canonicalJson(value[field]) !== canonicalJson(ready[field])) throw fail();
  }
}
function authorizationBindings(value: RepositoryRecoveryAuthorization, ready: RepositoryRecoveryReady) {
  repositoryRecoveryAuthorizationSchema.parse(value); repositoryRecoveryReadySchema.parse(ready); readerWindow(value, ready);
  validateSnapshot(ready.old, ready.old);
  if (value.oldReadySha256 !== recoveryRuntimeDigest(ready) || Date.parse(value.beforeObservedAt) < Date.parse(ready.observedAt)
    || Date.parse(ready.observedAt) < Date.parse(ready.old.observation.observedAt)
    || ready.observerProcess.bootId !== ready.old.process.bootId
    || Date.parse(value.beforeObservedAt) > Date.parse(value.issuedAt)
    || Date.parse(value.ownedCleanup.terminatedAt) > Date.parse(value.beforeObservedAt)
    || Date.parse(value.ownedCleanup.checkedAt) < Date.parse(value.ownedCleanup.terminatedAt)
    || Date.parse(value.ownedCleanup.checkedAt) > Date.parse(value.issuedAt)
    || new Set([value.ownedCleanup.observerPid, value.ownedCleanup.nativePid, ready.old.process.pid, ready.observerProcess.pid]).size !== 4) throw fail();
}
export function validateRecoveryAuthorization(value: RepositoryRecoveryAuthorization, ready: RepositoryRecoveryReady) {
  authorizationBindings(value, ready); activeReaderWindow(value, ready);
}
function completionBindings(value: RepositoryRecoveryCompletionAuthorization, ready: RepositoryRecoveryReady,
  transition: RepositoryRecoveryTransition) {
  repositoryRecoveryCompletionAuthorizationSchema.parse(value); repositoryRecoveryReadySchema.parse(ready);
  repositoryRecoveryTransitionSchema.parse(transition); readerWindow(value, ready); equalCommon(transition, ready);
  if (value.authorizationSha256 !== transition.authorizationSha256 || value.transitionSha256 !== recoveryRuntimeDigest(transition)
    || value.beforeCheckpointSha256 !== transition.beforeCheckpointSha256
    || Date.parse(value.afterObservedAt) < Date.parse(transition.observedAt) || Date.parse(value.afterObservedAt) > Date.parse(value.issuedAt)) throw fail();
}
export function validateRecoveryCompletion(value: RepositoryRecoveryCompletionAuthorization, ready: RepositoryRecoveryReady,
  transition: RepositoryRecoveryTransition) {
  completionBindings(value, ready, transition); activeReaderWindow(value, ready);
}
export function validateRecoveryProbeAuthorization(value: RepositoryRecoveryProbeAuthorization, ready: RepositoryRecoveryReady,
  transition: RepositoryRecoveryTransition, active = true) {
  repositoryRecoveryProbeAuthorizationSchema.parse(value); repositoryRecoveryReadySchema.parse(ready);
  repositoryRecoveryTransitionSchema.parse(transition); readerWindow(value, ready); equalCommon(transition, ready);
  if (active) activeReaderWindow(value, ready);
  if (value.authorizationSha256 !== transition.authorizationSha256 || value.transitionSha256 !== recoveryRuntimeDigest(transition)
    || value.beforeCheckpointSha256 !== transition.beforeCheckpointSha256
    || Date.parse(value.baselineObservedAt) < Date.parse(transition.observedAt) || Date.parse(value.baselineObservedAt) > Date.parse(value.issuedAt)
    || value.olderAttempt.runAttemptId === value.identity.runAttemptId || value.olderAttempt.leaseId === value.identity.leaseId
    || value.olderAttempt.fencingToken >= value.identity.fencingToken) throw fail();
}
export function validateRecoveryIpcRequest(value: RepositoryRecoveryIpcRequest, authorization: RepositoryRecoveryProbeAuthorization, active = true) {
  repositoryRecoveryIpcRequestSchema.parse(value); repositoryRecoveryProbeAuthorizationSchema.parse(authorization);
  for (const key of ["recoverySessionId", "nonce", "identity"] as const) {
    if (canonicalJson(value[key]) !== canonicalJson(authorization[key])) throw fail();
  }
  const issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
  const authIssued = Date.parse(authorization.issuedAt), authExpires = Date.parse(authorization.expiresAt);
  if (expires <= issued || expires - issued > 10_000 || issued < Date.parse(authorization.issuedAt)
    || authExpires <= authIssued || authExpires - authIssued > 30_000
    || expires > Date.parse(authorization.expiresAt) || (active && !(issued <= Date.now() && Date.now() <= expires))) throw fail();
  if (value.operation === "stale_heartbeat") {
    const { probe } = value, old = authorization.olderAttempt;
    if (probe.workspaceId !== value.identity.workspaceId || probe.runId !== value.identity.runId || probe.runAttemptId !== old.runAttemptId
      || probe.input.leaseId !== old.leaseId || probe.input.fencingToken !== old.fencingToken || probe.input.cursor !== old.cursor
      || probe.idempotencyKey !== `recovery-stale:${value.challenge}`
      || new Date(issued).toISOString().replace(/\.\d{3}Z$/, "Z") !== probe.input.emittedAt) throw fail();
  }
}
export function validateRecoveryProbeJournal(value: RepositoryRecoveryProbeJournal, ready: RepositoryRecoveryReady,
  transition: RepositoryRecoveryTransition, authorization: RepositoryRecoveryProbeAuthorization, readerPublicKey: string) {
  repositoryRecoveryProbeJournalSchema.parse(value); equalCommon(value, ready);
  validateRecoveryProbeAuthorization(authorization, ready, transition, false);
  const request = repositoryRecoveryIpcRequestSchema.parse(JSON.parse(value.request));
  const response = repositoryRecoveryIpcResponseSchema.parse(JSON.parse(value.response));
  const actualAuthorization = verifyRecoveryReaderEnvelope(request.authorization, readerPublicKey);
  if (recoveryRuntimeDigest(actualAuthorization) !== recoveryRuntimeDigest(authorization)) throw fail();
  validateRecoveryIpcRequest(request, authorization, false);
  for (const field of ["request", "response"] as const) {
    if (canonicalJson(JSON.parse(value[field])) !== value[field] || Buffer.byteLength(value[field]) !== value[`${field}Bytes`]
      || createHash("sha256").update(value[field]).digest("hex") !== value[`${field}Sha256`]) throw fail();
  }
  validateSnapshot(value.before, transition.next); validateSnapshot(value.after, transition.next);
  for (const observed of [value.before, value.after]) {
    if (canonicalJson(observed.process) !== canonicalJson(transition.next.process)
      || observed.observation.observerSessionId !== transition.next.observation.observerSessionId
      || observed.observation.startedAt !== transition.next.observation.startedAt) throw fail();
  }
  if (value.probeAuthorizationSha256 !== recoveryRuntimeDigest(authorization) || value.transitionSha256 !== recoveryRuntimeDigest(transition)
    || canonicalJson(value.executor) !== canonicalJson(transition.next.process) || response.executorPid !== value.executor.pid
    || value.operation !== request.operation || value.operation !== response.operation || request.challenge !== response.challenge
    || response.requestSha256 !== value.requestSha256 || value.issuedAt !== request.issuedAt
    || Date.parse(value.before.observation.observedAt) < Date.parse(authorization.baselineObservedAt)
    || Date.parse(value.issuedAt) < Date.parse(value.before.observation.observedAt)
    || Date.parse(response.completedAt) < Date.parse(value.issuedAt) || Date.parse(value.receivedAt) < Date.parse(response.completedAt)
    || Date.parse(value.receivedAt) > Date.parse(request.expiresAt)
    || Date.parse(value.after.observation.observedAt) < Date.parse(value.receivedAt) || Date.parse(value.after.observation.observedAt) > Date.now()) throw fail();
  if (request.operation === "stale_heartbeat" && response.operation === "stale_heartbeat"
    && (response.result.runId !== request.probe.runId || response.result.runAttemptId !== request.probe.runAttemptId
      || response.result.cursor !== request.probe.input.cursor)) throw fail();
  return { request, response };
}

function validateSnapshot(value: z.infer<typeof snapshot>, initial: z.infer<typeof snapshot>) {
  const { sha256, ...observation } = value.observation;
  if (recoveryRuntimeDigest(observation) !== sha256 || value.observation.pid !== value.process.pid
    || value.process.pgid !== value.process.pid || value.process.sessionId !== value.process.pid
    || value.observation.candidateCommit !== initial.observation.candidateCommit
    || value.observation.executableSha256 !== initial.observation.executableSha256
    || value.observation.manifestSha256 !== initial.observation.manifestSha256
    || Date.parse(value.observation.observedAt) < Date.parse(value.observation.startedAt)) throw fail();
}
function validateStopped(value: RecoveryStoppedProcess, observed: z.infer<typeof snapshot>, minimum: string, maximum: string) {
  if (canonicalJson(value.process) !== canonicalJson(observed.process)
    || Date.parse(value.termSentAt) < Math.max(Date.parse(minimum), Date.parse(observed.observation.observedAt))
    || Date.parse(value.termSentAt) > Date.parse(maximum) || Date.parse(value.stoppedAt) < Date.parse(value.termSentAt)
    || (value.killSentAt && (Date.parse(value.killSentAt) < Date.parse(value.termSentAt) || Date.parse(value.killSentAt) > Date.parse(value.stoppedAt)))) throw fail();
}
function validateCleanup(value: z.infer<typeof gone>, authorization: RepositoryRecoveryAuthorization, minimum: string) {
  for (const key of ["observerPid", "nativePid", "basis", "outputReceiptSha256", "terminationEnvelopeSha256"] as const) {
    if (value[key] !== authorization.ownedCleanup[key]) throw fail();
  }
  if (Date.parse(value.checkedAt) < Date.parse(minimum)) throw fail();
}
export function validateRecoveryTransition(value: RepositoryRecoveryTransition, ready: RepositoryRecoveryReady,
  authorization: RepositoryRecoveryAuthorization) {
  repositoryRecoveryTransitionSchema.parse(value); authorizationBindings(authorization, ready); equalCommon(value, ready);
  validateSnapshot(ready.old, ready.old); validateSnapshot(value.old, ready.old); validateSnapshot(value.next, ready.old);
  validateStopped(value.oldStopped, value.old, authorization.issuedAt, authorization.expiresAt);
  validateCleanup(value.ownedCleanup, authorization, value.oldStopped.stoppedAt);
  if (value.oldReadySha256 !== recoveryRuntimeDigest(ready) || authorization.oldReadySha256 !== value.oldReadySha256
    || value.authorizationSha256 !== recoveryRuntimeDigest(authorization) || value.beforeCheckpointSha256 !== authorization.beforeCheckpointSha256
    || canonicalJson(value.old.process) !== canonicalJson(ready.old.process)
    || value.old.observation.observerSessionId !== ready.old.observation.observerSessionId
    || value.old.observation.startedAt !== ready.old.observation.startedAt
    || Date.parse(value.old.observation.observedAt) < Date.parse(authorization.beforeObservedAt)
    || value.next.process.bootId !== value.old.process.bootId || value.next.process.pid === value.old.process.pid
    || value.next.process.startTicks === value.old.process.startTicks || value.next.observation.observerSessionId === value.old.observation.observerSessionId
    || Date.parse(value.next.observation.startedAt) < Date.parse(value.oldStopped.stoppedAt)
    || Date.parse(value.observedAt) < Math.max(Date.parse(value.next.observation.observedAt), Date.parse(value.ownedCleanup.checkedAt))
    || Date.parse(value.observedAt) > Date.now()) throw fail();
}
export function validateRecoveryFinal(value: RepositoryRecoveryFinal, ready: RepositoryRecoveryReady, authorization: RepositoryRecoveryAuthorization,
  transition: RepositoryRecoveryTransition, completion: RepositoryRecoveryCompletionAuthorization) {
  repositoryRecoveryFinalSchema.parse(value); validateRecoveryTransition(transition, ready, authorization);
  equalCommon(value, ready); completionBindings(completion, ready, transition); validateSnapshot(value.next, transition.next);
  validateStopped(value.nextStopped, value.next, completion.issuedAt, completion.expiresAt);
  validateCleanup(value.ownedCleanup, authorization, value.nextStopped.stoppedAt);
  if (value.oldReadySha256 !== transition.oldReadySha256 || value.authorizationSha256 !== transition.authorizationSha256
    || value.transitionSha256 !== recoveryRuntimeDigest(transition) || completion.transitionSha256 !== value.transitionSha256
    || completion.authorizationSha256 !== transition.authorizationSha256 || completion.beforeCheckpointSha256 !== authorization.beforeCheckpointSha256
    || value.completionAuthorizationSha256 !== recoveryRuntimeDigest(completion) || value.beforeCheckpointSha256 !== authorization.beforeCheckpointSha256
    || value.afterCheckpointSha256 !== completion.afterCheckpointSha256 || canonicalJson(value.oldStopped) !== canonicalJson(transition.oldStopped)
    || canonicalJson(value.next.process) !== canonicalJson(transition.next.process)
    || value.next.observation.observerSessionId !== transition.next.observation.observerSessionId
    || value.next.observation.startedAt !== transition.next.observation.startedAt
    || Date.parse(completion.afterObservedAt) < Date.parse(transition.observedAt)
    || Date.parse(value.next.observation.observedAt) < Date.parse(completion.afterObservedAt)
    || Date.parse(value.observedAt) < Math.max(Date.parse(value.nextStopped.stoppedAt), Date.parse(value.ownedCleanup.checkedAt))
    || Date.parse(value.observedAt) > Date.now()) throw fail();
}

export function parseLinuxProcessIdentity(stat: string, bootId: string): RecoveryProcessIdentity {
  const end = stat.lastIndexOf(")"), start = stat.indexOf(" (");
  if (end <= start || start < 1) throw fail();
  const fields = stat.slice(end + 1).trim().split(/\s+/);
  return recoveryProcessIdentitySchema.parse({ pid: Number(stat.slice(0, start)), bootId: bootId.trim(),
    pgid: Number(fields[2]), sessionId: Number(fields[3]), startTicks: fields[19] });
}
export async function readLinuxProcessIdentity(pidValue: number) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pidValue) || pidValue < 1) throw fail();
  return parseLinuxProcessIdentity(await readFile(`/proc/${pidValue}/stat`, "utf8"), await readFile("/proc/sys/kernel/random/boot_id", "utf8"));
}
export function processGroupExists(pgid: number) {
  try { process.kill(-pid.parse(pgid), 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw fail(); }
}

export async function stopRecoveryOwnedNode(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
  identity: RecoveryProcessIdentity, dependencies: {
    readIdentity: (pid: number) => Promise<RecoveryProcessIdentity>; groupExists: (pgid: number) => boolean;
    signal: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void; sleep: (ms: number) => Promise<void>; now: () => number;
  } = { readIdentity: readLinuxProcessIdentity,
    groupExists: processGroupExists, signal: (pgid: number, signal: "SIGTERM" | "SIGKILL") => process.kill(-pgid, signal),
    sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), now: () => Date.now() }): Promise<RecoveryStoppedProcess> {
  recoveryProcessIdentitySchema.parse(identity);
  if (child.pid !== identity.pid || identity.pgid !== identity.pid || identity.sessionId !== identity.pid) throw fail();
  const sameBirth = async () => {
    if (canonicalJson(await dependencies.readIdentity(identity.pid)) !== canonicalJson(identity)) throw fail();
  };
  const reaped = () => child.exitCode !== null || child.signalCode !== null;
  const waitGone = async (ms: number) => {
    const deadline = dependencies.now() + ms;
    while (dependencies.now() < deadline) {
      if (!dependencies.groupExists(identity.pgid) && reaped()) return true;
      await dependencies.sleep(20);
    }
    return !dependencies.groupExists(identity.pgid) && reaped();
  };
  await sameBirth(); const termSentAt = new Date(dependencies.now()).toISOString();
  dependencies.signal(identity.pgid, "SIGTERM"); let killSentAt: string | null = null;
  if (!await waitGone(1000)) {
    // A vanished/reused group leader is not authorization to signal its numeric PID again.
    await sameBirth(); killSentAt = new Date(dependencies.now()).toISOString(); dependencies.signal(identity.pgid, "SIGKILL");
    if (!await waitGone(1000)) throw fail();
  }
  return stopped.parse({ process: identity, requestedSignal: "SIGTERM", termSentAt, killSentAt,
    stoppedAt: new Date(dependencies.now()).toISOString(), processGroupGone: true, processReaped: true });
}
