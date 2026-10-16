import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { assertDeliveryProofReader, type DeliveryProofReaderAccess } from "./delivery-proof-reader-access.js";
import { collectRepositoryRecoveryCheckpoint, collectRepositoryRecoveryCompletion,
  repositoryRecoveryCheckpointSchema, repositoryRecoverySelectionSchema } from "./repository-recovery-proof-context.js";
import { collectOpenCodeRuntimeWitnesses, openCodeCandidateWitnessSchema, openCodeRuntimeDigest,
  openCodeRuntimeManifestSchema, openCodeWitnessDomain } from "./opencode-runtime-observation.js";
import { openCodeRuntimeProofSchema, projectOpenCodeRuntimeProof } from "./opencode-runtime-proof-projection.js";
import { recoveryRuntimeDigest, repositoryRecoveryAuthorizationSchema, repositoryRecoveryCompletionAuthorizationSchema,
  repositoryRecoveryEnvelopeSchema, repositoryRecoveryFinalSchema, repositoryRecoveryReadySchema,
  repositoryRecoveryTransitionSchema, repositoryRecoveryRuntimePaths, signRecoveryReaderEnvelope,
  verifyRecoveryObserverEnvelope, verifyRecoveryReaderEnvelope, validateRecoveryAuthorization,
  validateRecoveryCompletion, validateRecoveryTransition, validateRecoveryFinal,
  repositoryRecoveryProbeAuthorizationSchema, repositoryRecoveryProbeJournalSchema,
  validateRecoveryProbeAuthorization, validateRecoveryProbeJournal,
  type RepositoryRecoveryReady } from "./repository-recovery-runtime-observation.js";
import { collectRepositoryStaleFenceProbeCheckpoint, collectRepositoryStaleFenceContext } from "./repository-stale-fence-proof-context.js";
import type { RepositoryCiSourceOptions } from "./github-ci-repository-source-context.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function unavailable(): never { throw new Error("REPOSITORY_RECOVERY_READER_UNAVAILABLE"); }
const digest = (value: unknown) => recoveryRuntimeDigest(value);
const ordered = (...values: string[]) => values.every((value, index) => Number.isFinite(Date.parse(value))
  && (!index || Date.parse(values[index - 1]!) <= Date.parse(value)));
const afterSelectionSchema = z.object({ workspaceId: z.string().uuid(), targetId: z.string().uuid(),
  targetRevisionId: z.string().uuid(), graphRevisionId: z.string().uuid(), claimId: z.string().uuid(),
  workNodeId: z.string().uuid(), artifactRevisionId: z.string().uuid(), requirementId: z.string().min(1).max(200) }).strict();
const beforeRecordSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("verrail.repository-recovery-before-record"),
  readyEnvelope: repositoryRecoveryEnvelopeSchema, checkpoint: repositoryRecoveryCheckpointSchema,
  preRuntime: openCodeRuntimeProofSchema, authorizationEnvelope: repositoryRecoveryEnvelopeSchema }).strict();
type BeforeRecord = z.infer<typeof beforeRecordSchema>;
const probeRecordSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("verrail.repository-recovery-probe-record"),
  input: afterSelectionSchema, completion: z.record(z.string(), z.unknown()),
  staleCheckpoint: z.record(z.string(), z.unknown()), transitionEnvelope: repositoryRecoveryEnvelopeSchema,
  authorizationEnvelope: repositoryRecoveryEnvelopeSchema }).strict();
export interface RepositoryRecoveryReaderConfiguration {
  recoverySessionId: string;
  directory: string;
  observerPublicKey: string;
  readerPrivateKey: string;
  runtime: Parameters<typeof collectOpenCodeRuntimeWitnesses>[0];
}
type Options = RepositoryCiSourceOptions & { config: RepositoryRecoveryReaderConfiguration };

async function privateDirectory(directory: string) {
  if (!path.isAbsolute(directory) || await realpath(directory) !== directory) unavailable();
  const value = await stat(directory);
  if (!value.isDirectory() || value.uid !== process.getuid?.() || (value.mode & 0o077)) unavailable();
}
async function readPrivate(directory: string, filename: string) {
  await privateDirectory(directory);
  if (!filename.startsWith(`${directory}${path.sep}`) || await realpath(filename) !== filename) unavailable();
  let parent = path.dirname(filename);
  while (parent !== directory) { await privateDirectory(parent); parent = path.dirname(parent); }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o400 || before.nlink !== 1
      || before.size < 1 || before.size > 1024 * 1024) unavailable();
    const bytes = await file.readFile(), after = await file.stat();
    if (bytes.length !== before.size || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) unavailable();
    return { bytes, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } finally { await file.close(); }
}
async function publishPrivate(directory: string, filename: string, value: unknown) {
  await privateDirectory(directory);
  if (path.dirname(filename) !== directory) unavailable();
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length > 1024 * 1024) unavailable();
  const temporary = path.join(directory, `.recovery-reader-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await link(temporary, filename);
  } finally { await unlink(temporary); }
  return { contentHash: hash(bytes), bytes: bytes.length };
}
async function archivePrivate(directory: string, value: unknown) {
  await privateDirectory(directory);
  const parent = path.join(directory, "recovery-archive"), archive = path.join(parent, "sha256");
  for (const entry of [parent, archive]) { await mkdir(entry, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }); await privateDirectory(entry); }
  const bytes = Buffer.from(canonicalJson(value)), contentHash = hash(bytes), filename = path.join(archive, `${contentHash}.json`);
  try { await publishPrivate(archive, filename, value); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const actual = await readPrivate(archive, filename);
  if (!actual.bytes.equals(bytes)) unavailable();
  return { contentHash, bytes: bytes.length, contentRef: `private-recovery:sha256:${contentHash}` };
}
function recordPaths(config: RepositoryRecoveryReaderConfiguration) {
  const transport = repositoryRecoveryRuntimePaths(config.directory, config.recoverySessionId);
  return { ...transport, before: path.join(config.directory, `${config.recoverySessionId}-recovery.reader-before.json`),
    probe: path.join(config.directory, `${config.recoverySessionId}-recovery.reader-probe.json`),
    after: path.join(config.directory, `${config.recoverySessionId}-recovery.reader-after.json`) };
}
function publicReaderKey(config: RepositoryRecoveryReaderConfiguration) {
  return createPublicKey(config.readerPrivateKey).export({ type: "spki", format: "pem" }).toString();
}
async function authority(db: Db, access: DeliveryProofReaderAccess, config: RepositoryRecoveryReaderConfiguration) {
  if (access.schemaVersion !== 4) unavailable();
  await assertDeliveryProofReader(db, access);
  await privateDirectory(config.directory);
  z.string().uuid().parse(config.recoverySessionId);
  const manifest = openCodeRuntimeManifestSchema.parse(config.runtime.manifest);
  if (openCodeRuntimeDigest(manifest) !== config.runtime.manifestSha256) unavailable();
  return manifest;
}
function bindReady(ready: RepositoryRecoveryReady, config: RepositoryRecoveryReaderConfiguration) {
  const manifest = openCodeRuntimeManifestSchema.parse(config.runtime.manifest);
  const expected = manifest.components.find(value => value.component === "repository_executor")!;
  const { sha256, ...observation } = ready.old.observation;
  if (ready.recoverySessionId !== config.recoverySessionId || ready.candidateSessionId !== config.runtime.sessionId
    || ready.runtimeManifestSha256 !== config.runtime.manifestSha256 || ready.configurationSha256 !== expected.configurationSha256
    || ready.verifierBuildSha256 !== expected.verifierBuildSha256 || ready.observerExecutableSha256 !== manifest.observerExecutableSha256
    || ready.old.observation.kind !== "verrail.node-runtime-observation" || ready.old.observation.pid !== ready.old.process.pid
    || ready.old.process.pgid !== ready.old.process.pid || ready.old.process.sessionId !== ready.old.process.pid
    || ready.old.observation.candidateCommit !== manifest.candidateCommit || ready.old.observation.executableSha256 !== expected.executableSha256
    || ready.old.observation.manifestSha256 !== expected.sourceManifestSha256 || openCodeRuntimeDigest(observation) !== sha256
    || Date.parse(ready.observedAt) > Date.now() || Date.parse(ready.old.observation.observedAt) > Date.parse(ready.observedAt)) unavailable();
}
function verifyBefore(raw: unknown, config: RepositoryRecoveryReaderConfiguration) {
  const before = beforeRecordSchema.parse(raw);
  const ready = repositoryRecoveryReadySchema.parse(verifyRecoveryObserverEnvelope(before.readyEnvelope, config.observerPublicKey));
  bindReady(ready, config);
  const authorization = repositoryRecoveryAuthorizationSchema.parse(verifyRecoveryReaderEnvelope(before.authorizationEnvelope, publicReaderKey(config)));
  const { contextSha256, ...body } = before.checkpoint;
  if (digest(body) !== contextSha256 || authorization.beforeCheckpointSha256 !== contextSha256
    || authorization.preRuntimeProofSha256 !== digest(before.preRuntime) || authorization.oldReadySha256 !== digest(ready)
    || !equal(authorization.identity, before.checkpoint.durable.identity) || !equal(authorization.identity, ready.identity)
    || authorization.recoverySessionId !== config.recoverySessionId || authorization.nonce !== ready.nonce
    || authorization.beforeObservedAt !== before.checkpoint.observedAt
    || authorization.runtimeManifestSha256 !== config.runtime.manifestSha256 || authorization.candidateSessionId !== config.runtime.sessionId
    || authorization.configurationSha256 !== ready.configurationSha256
    || !ordered(ready.observedAt, authorization.beforeObservedAt, authorization.issuedAt, authorization.expiresAt)
    || Date.parse(authorization.expiresAt) - Date.parse(authorization.issuedAt) > 30_000) unavailable();
  const executor = before.preRuntime.witnesses.find(value => value.component === "repository_executor")!;
  const native = before.preRuntime.witnesses.find(value => value.component === "opencode")!;
  if (authorization.oldRuntimeWitnessEnvelopeSha256 !== executor.envelopeRef.contentHash
    || authorization.ownedCleanup.terminationEnvelopeSha256 !== native.envelopeRef.contentHash
    || authorization.ownedCleanup.outputReceiptSha256 !== before.checkpoint.durable.outputReceiptSha256
    || authorization.ownedCleanup.executionSessionId !== before.checkpoint.durable.executionSessionId
    || authorization.ownedCleanup.observerPid !== native.observerPid || authorization.ownedCleanup.nativePid !== native.observation.pid
    || authorization.ownedCleanup.terminatedAt !== native.termination?.finishedAt) unavailable();
  return { before, ready, authorization };
}
async function replayArchivedRuntime(before: BeforeRecord, config: RepositoryRecoveryReaderConfiguration) {
  const key = createPublicKey(config.runtime.publicKey);
  const witnesses = [];
  for (const summary of before.preRuntime.witnesses) {
    const ref = summary.envelopeRef;
    const raw = await readPrivate(config.runtime.directory, path.join(config.runtime.directory, "witness-archive", "sha256", `${ref.contentHash}.json`));
    if (raw.bytes.length !== ref.bytes || hash(raw.bytes) !== ref.contentHash) unavailable();
    const envelope = repositoryRecoveryEnvelopeSchema.parse(raw.value);
    const bytes = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "base64");
    if (key.asymmetricKeyType !== "ed25519" || bytes.toString("base64") !== envelope.payload || signature.toString("base64") !== envelope.signature
      || !verify(null, Buffer.concat([openCodeWitnessDomain, bytes]), key, signature)) unavailable();
    const witness = openCodeCandidateWitnessSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const { sha256, ...observation } = witness.observation;
    if (openCodeRuntimeDigest(observation) !== sha256) unavailable();
    witnesses.push({ ...witness, envelopeRef: ref });
  }
  const projected = projectOpenCodeRuntimeProof({ schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-observation",
    sessionId: before.preRuntime.sessionId, manifestSha256: before.preRuntime.manifestSha256, witnesses });
  if (!equal(projected, before.preRuntime)) unavailable();
}

/** Explicit operator step. Publishes a signed, single-use request only after actual before-state and runtime verification. */
export async function authorizeRepositoryRecovery(db: Db, access: DeliveryProofReaderAccess,
  raw: z.input<typeof repositoryRecoverySelectionSchema>, options: Options) {
  const { config } = options, selection = repositoryRecoverySelectionSchema.parse(raw);
  await authority(db, access, config);
  if (selection.workspaceId !== access.workspaceId) unavailable();
  const paths = recordPaths(config), readyEnvelope = repositoryRecoveryEnvelopeSchema.parse((await readPrivate(config.directory, paths.ready)).value);
  const ready = repositoryRecoveryReadySchema.parse(verifyRecoveryObserverEnvelope(readyEnvelope, config.observerPublicKey));
  bindReady(ready, config);
  const first = await collectRepositoryRecoveryCheckpoint(db, selection, options);
  if (!equal(first.durable.identity, ready.identity)) unavailable();
  const binding = first.durable.runtimeBinding;
  const observed = await collectOpenCodeRuntimeWitnesses(config.runtime, { identity: first.durable.identity,
    runtimeWindow: binding.runtimeWindow, httpSession: binding.httpSession });
  const preRuntime = projectOpenCodeRuntimeProof(observed), executor = observed.witnesses.find(value => value.component === "repository_executor")!;
  const native = observed.witnesses.find(value => value.component === "opencode")!;
  if (executor.observation.pid !== ready.old.process.pid || executor.observerPid !== ready.observerProcess.pid
    || executor.observation.kind !== "verrail.node-runtime-observation"
    || executor.observation.manifestSha256 !== ready.old.observation.manifestSha256
    || executor.observation.startedAt !== ready.old.observation.startedAt
    || native.observerPid !== binding.candidateRuntime.observerPid || native.observation.pid !== binding.candidateRuntime.nativePid
    || !native.termination) unavailable();
  const checkpoint = await collectRepositoryRecoveryCheckpoint(db, selection, options);
  if (!equal(first.durable, checkpoint.durable) || !equal(first.events, checkpoint.events)) unavailable();
  const issuedAt = new Date().toISOString();
  const authorization = repositoryRecoveryAuthorizationSchema.parse({ schemaVersion: 1, kind: "verrail.repository-recovery-authorize",
    recoverySessionId: config.recoverySessionId, nonce: ready.nonce, identity: ready.identity, candidateSessionId: ready.candidateSessionId,
    runtimeManifestSha256: ready.runtimeManifestSha256, configurationSha256: ready.configurationSha256,
    oldReadySha256: digest(ready), oldRuntimeWitnessEnvelopeSha256: executor.envelopeRef.contentHash,
    preRuntimeProofSha256: digest(preRuntime), beforeCheckpointSha256: checkpoint.contextSha256, beforeObservedAt: checkpoint.observedAt,
    issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 30_000).toISOString(), ownedCleanup: {
      basis: "candidate_executor_typed_output_receipt_and_signed_opencode_termination",
      outputReceiptSha256: checkpoint.durable.outputReceiptSha256, terminationEnvelopeSha256: native.envelopeRef.contentHash,
      executionSessionId: checkpoint.durable.executionSessionId, observerPid: native.observerPid, nativePid: native.observation.pid,
      terminatedAt: native.termination.finishedAt, checkedAt: issuedAt } });
  validateRecoveryAuthorization(authorization, ready);
  const authorizationEnvelope = signRecoveryReaderEnvelope(authorization, config.readerPrivateKey);
  const before = beforeRecordSchema.parse({ schemaVersion: 1, kind: "verrail.repository-recovery-before-record",
    readyEnvelope, checkpoint, preRuntime, authorizationEnvelope });
  verifyBefore(before, config);
  await replayArchivedRuntime(before, config);
  const archived = await publishPrivate(config.directory, paths.before, before);
  validateRecoveryAuthorization(authorization, ready);
  await publishPrivate(config.directory, paths.authorize, authorizationEnvelope);
  return { kind: "verrail.repository-recovery-authorization-published" as const,
    beforeCheckpointSha256: checkpoint.contextSha256, authorizationSha256: digest(authorization), beforeRecord: archived };
}

function bindTransition(raw: unknown, state: ReturnType<typeof verifyBefore>, config: RepositoryRecoveryReaderConfiguration) {
  const transition = repositoryRecoveryTransitionSchema.parse(verifyRecoveryObserverEnvelope(raw, config.observerPublicKey));
  validateRecoveryTransition(transition, state.ready, state.authorization);
  return transition;
}

/** Authorizes only two fixed operations against an independently read, already recovered Run. */
export async function authorizeRepositoryRecoveryProbes(db: Db, access: DeliveryProofReaderAccess,
  raw: z.input<typeof afterSelectionSchema>, oldAttemptId: string, options: Options) {
  const input = afterSelectionSchema.parse(raw), { config } = options;
  await authority(db, access, config);
  if (input.workspaceId !== access.workspaceId) unavailable();
  const paths = recordPaths(config), state = verifyBefore((await readPrivate(config.directory, paths.before)).value, config);
  await replayArchivedRuntime(state.before, config);
  const transitionEnvelope = repositoryRecoveryEnvelopeSchema.parse((await readPrivate(config.directory, paths.transition)).value);
  const transition = bindTransition(transitionEnvelope, state, config);
  const completion = await collectRepositoryRecoveryCompletion(db, state.before.checkpoint, input, options);
  const staleCheckpoint = await collectRepositoryStaleFenceProbeCheckpoint(db, state.ready.identity, oldAttemptId);
  const again = await collectRepositoryRecoveryCompletion(db, state.before.checkpoint, input, options);
  const staleAgain = await collectRepositoryStaleFenceProbeCheckpoint(db, state.ready.identity, oldAttemptId);
  if (!equal(completion, again) || !equal(staleCheckpoint, staleAgain)) unavailable();
  const now = new Date().toISOString(), ready = state.ready;
  const authorization = repositoryRecoveryProbeAuthorizationSchema.parse({ schemaVersion: 1,
    kind: "verrail.repository-recovery-probe-authorize", recoverySessionId: ready.recoverySessionId, nonce: ready.nonce,
    identity: ready.identity, candidateSessionId: ready.candidateSessionId, runtimeManifestSha256: ready.runtimeManifestSha256,
    configurationSha256: ready.configurationSha256, authorizationSha256: digest(state.authorization), transitionSha256: digest(transition),
    beforeCheckpointSha256: state.before.checkpoint.contextSha256, completionBaselineSha256: completion.contextSha256,
    staleCheckpointSha256: staleCheckpoint.contextSha256, olderAttempt: { runAttemptId: staleCheckpoint.oldAttemptId,
      leaseId: staleCheckpoint.oldLeaseId, fencingToken: staleCheckpoint.oldFencingToken,
      attemptNumber: staleCheckpoint.oldAttemptNumber, cursor: staleCheckpoint.nextCursor },
    baselineObservedAt: now, issuedAt: now, expiresAt: new Date(Date.parse(now) + 30_000).toISOString() });
  validateRecoveryProbeAuthorization(authorization, ready, transition);
  const authorizationEnvelope = signRecoveryReaderEnvelope(authorization, config.readerPrivateKey);
  const record = probeRecordSchema.parse({ schemaVersion: 1, kind: "verrail.repository-recovery-probe-record",
    input, completion, staleCheckpoint, transitionEnvelope, authorizationEnvelope });
  const archived = await publishPrivate(config.directory, paths.probe, record);
  validateRecoveryProbeAuthorization(authorization, ready, transition);
  await publishPrivate(config.directory, paths.probeAuthorize, authorizationEnvelope);
  return { kind: "verrail.repository-recovery-probe-authorization-published" as const,
    probeAuthorizationSha256: digest(authorization), probeRecord: archived };
}

async function replayProbes(db: Db, state: ReturnType<typeof verifyBefore>, options: Options) {
  const { config } = options, paths = recordPaths(config);
  const record = probeRecordSchema.parse((await readPrivate(config.directory, paths.probe)).value);
  if (!equal(record.transitionEnvelope, (await readPrivate(config.directory, paths.transition)).value)) unavailable();
  const transition = bindTransition(record.transitionEnvelope, state, config);
  const authorization = repositoryRecoveryProbeAuthorizationSchema.parse(verifyRecoveryReaderEnvelope(record.authorizationEnvelope, publicReaderKey(config)));
  validateRecoveryProbeAuthorization(authorization, state.ready, transition, false);
  for (const [value, expected] of [[record.completion, authorization.completionBaselineSha256],
    [record.staleCheckpoint, authorization.staleCheckpointSha256]] as const) {
    const { contextSha256, ...body } = value;
    if (contextSha256 !== expected || digest(body) !== contextSha256) unavailable();
  }
  const current = await collectRepositoryRecoveryCompletion(db, state.before.checkpoint, record.input, options);
  const baseline = await collectRepositoryStaleFenceProbeCheckpoint(db, state.ready.identity, authorization.olderAttempt.runAttemptId);
  if (!equal(current, record.completion) || !equal(baseline, record.staleCheckpoint)
    || !equal(authorization.olderAttempt, { runAttemptId: baseline.oldAttemptId, leaseId: baseline.oldLeaseId,
      fencingToken: baseline.oldFencingToken, attemptNumber: baseline.oldAttemptNumber, cursor: baseline.nextCursor })) unavailable();
  const readJournal = async (filename: string) => {
    const envelope = repositoryRecoveryEnvelopeSchema.parse((await readPrivate(config.directory, filename)).value);
    const journal = repositoryRecoveryProbeJournalSchema.parse(verifyRecoveryObserverEnvelope(envelope, config.observerPublicKey));
    const parsed = validateRecoveryProbeJournal(journal, state.ready, transition, authorization, publicReaderKey(config));
    return { envelope, journal, ...parsed };
  };
  const duplicate = await readJournal(paths.duplicateJournal), stale = await readJournal(paths.staleJournal);
  if (duplicate.request.operation !== "reconcile" || duplicate.response.operation !== "reconcile"
    || stale.request.operation !== "stale_heartbeat" || stale.response.operation !== "stale_heartbeat"
    || duplicate.request.challenge === stale.request.challenge
    || !ordered(duplicate.journal.after.observation.observedAt, stale.journal.before.observation.observedAt)) unavailable();
  const staleContext = await collectRepositoryStaleFenceContext(db, stale.request.probe);
  if (!equal(staleContext.probeCheckpoint, baseline) || !equal(staleContext.response, stale.response.result)
    || !ordered(stale.journal.issuedAt, staleContext.receiptCreatedAt, stale.journal.receivedAt)
    || !ordered(stale.journal.issuedAt, staleContext.auditOccurredAt, stale.journal.receivedAt)) unavailable();
  const after = await collectRepositoryRecoveryCompletion(db, state.before.checkpoint, record.input, options);
  if (!equal(current, after)) unavailable();
  return { record, transition, authorization, duplicate, stale, staleContext, completion: after };
}

/** Stop-new authorization requires actual signed operation journals plus independently unchanged DB state. */
export async function authorizeRepositoryRecoveryCompletion(db: Db, access: DeliveryProofReaderAccess,
  raw: z.input<typeof afterSelectionSchema>, options: Options) {
  const input = afterSelectionSchema.parse(raw), { config } = options;
  await authority(db, access, config);
  if (input.workspaceId !== access.workspaceId) unavailable();
  const paths = recordPaths(config), state = verifyBefore((await readPrivate(config.directory, paths.before)).value, config);
  await replayArchivedRuntime(state.before, config);
  const probes = await replayProbes(db, state, options), { completion, transition } = probes;
  if (!equal(probes.record.input, input)) unavailable();
  const now = new Date().toISOString(), ready = state.ready;
  const authorization = repositoryRecoveryCompletionAuthorizationSchema.parse({ schemaVersion: 1,
    kind: "verrail.repository-recovery-complete-authorize", recoverySessionId: ready.recoverySessionId, nonce: ready.nonce,
    identity: ready.identity, candidateSessionId: ready.candidateSessionId, runtimeManifestSha256: ready.runtimeManifestSha256,
    configurationSha256: ready.configurationSha256, authorizationSha256: digest(state.authorization), transitionSha256: digest(transition),
    probeAuthorizationSha256: digest(probes.authorization), duplicateJournalSha256: digest(probes.duplicate.journal),
    staleJournalSha256: digest(probes.stale.journal),
    beforeCheckpointSha256: state.before.checkpoint.contextSha256, afterCheckpointSha256: completion.contextSha256,
    afterObservedAt: now, issuedAt: now, expiresAt: new Date(Date.parse(now) + 30_000).toISOString() });
  validateRecoveryCompletion(authorization, ready, transition);
  const authorizationEnvelope = signRecoveryReaderEnvelope(authorization, config.readerPrivateKey);
  const record = { schemaVersion: 1, kind: "verrail.repository-recovery-after-record", input, completion,
    transitionEnvelope: probes.record.transitionEnvelope, authorizationEnvelope };
  const archived = await publishPrivate(config.directory, paths.after, record);
  validateRecoveryCompletion(authorization, ready, transition);
  await publishPrivate(config.directory, paths.complete, authorizationEnvelope);
  return { kind: "verrail.repository-recovery-completion-authorization-published" as const,
    completionAuthorizationSha256: digest(authorization), afterRecord: archived };
}

/** Internal authenticated recovery context. Active requirement and independent CI admission are still mandatory. */
export async function loadRepositoryRecoveryRuntimeContext(db: Db, access: DeliveryProofReaderAccess, options: Options) {
  const { config } = options;
  await authority(db, access, config);
  const paths = recordPaths(config), state = verifyBefore((await readPrivate(config.directory, paths.before)).value, config);
  if (state.ready.identity.workspaceId !== access.workspaceId) unavailable();
  await replayArchivedRuntime(state.before, config);
  const after = z.object({ schemaVersion: z.literal(1), kind: z.literal("verrail.repository-recovery-after-record"), input: afterSelectionSchema,
    completion: z.record(z.string(), z.unknown()), transitionEnvelope: repositoryRecoveryEnvelopeSchema,
    authorizationEnvelope: repositoryRecoveryEnvelopeSchema }).strict().parse((await readPrivate(config.directory, paths.after)).value);
  const transition = bindTransition(after.transitionEnvelope, state, config);
  const probes = await replayProbes(db, state, options);
  if (!equal(probes.record.input, after.input) || !equal(probes.transition, transition)) unavailable();
  const authorization = repositoryRecoveryCompletionAuthorizationSchema.parse(verifyRecoveryReaderEnvelope(after.authorizationEnvelope, publicReaderKey(config)));
  const terminalEnvelope = repositoryRecoveryEnvelopeSchema.parse((await readPrivate(config.directory, paths.final)).value);
  const terminal = repositoryRecoveryFinalSchema.parse(verifyRecoveryObserverEnvelope(terminalEnvelope, config.observerPublicKey));
  validateRecoveryFinal(terminal, state.ready, state.authorization, transition, authorization);
  const current = await collectRepositoryRecoveryCompletion(db, state.before.checkpoint, after.input, options);
  if (!equal(current, after.completion) || authorization.afterCheckpointSha256 !== current.contextSha256
    || authorization.probeAuthorizationSha256 !== digest(probes.authorization)
    || authorization.duplicateJournalSha256 !== digest(probes.duplicate.journal)
    || authorization.staleJournalSha256 !== digest(probes.stale.journal)
    || !ordered(probes.stale.journal.after.observation.observedAt, authorization.afterObservedAt)) unavailable();
  const originals = { before: state.before, probe: probes.record, after, ready: state.before.readyEnvelope,
    authorization: state.before.authorizationEnvelope, transition: after.transitionEnvelope,
    probeAuthorization: probes.record.authorizationEnvelope, duplicateJournal: probes.duplicate.envelope,
    staleJournal: probes.stale.envelope, completionAuthorization: after.authorizationEnvelope, final: terminalEnvelope };
  const archives = {} as Record<keyof typeof originals, Awaited<ReturnType<typeof archivePrivate>>>;
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) archives[name] = await archivePrivate(config.directory, originals[name]);
  return { schemaVersion: 1 as const, kind: "verrail.repository-recovery-runtime-context" as const, deliveryProof: false as const,
    remainingObligations: ["active_requirement", "fixed_ci"] as const,
    checkpoint: state.before.checkpoint, preRuntime: state.before.preRuntime, completion: current, transition, terminal,
    ready: state.ready, authorization: state.authorization, completionAuthorization: authorization, archives,
    probeAuthorization: probes.authorization, duplicateJournal: probes.duplicate.journal, staleJournal: probes.stale.journal,
    staleContext: probes.staleContext };
}
