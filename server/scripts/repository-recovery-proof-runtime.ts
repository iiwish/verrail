import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { link, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { readPrivateProofJson } from "../src/services/delivery-proof-observation.js";
import { launchObservedNodeRuntime } from "../src/services/verrail-runtime-observation.js";
import { openCodeCandidateWitnessSchema, openCodeCheckpointRequestSchema, openCodeWitnessDomain, openCodeWitnessPrefix } from "../src/services/opencode-runtime-observation.js";
import { repositoryRecoveryRuntimeConfigurationSchema, repositoryRecoveryReadySchema, repositoryRecoveryAuthorizationSchema,
  repositoryRecoveryCompletionAuthorizationSchema, repositoryRecoveryTransitionSchema, repositoryRecoveryFinalSchema,
  recoveryRuntimeDigest, readLinuxProcessIdentity, processGroupExists, signRecoveryObserverEnvelope,
  verifyRecoveryReaderEnvelope, stopRecoveryOwnedNode, validateRecoveryAuthorization, validateRecoveryCompletion,
  repositoryRecoveryRuntimePaths, validateRecoveryTransition, validateRecoveryFinal,
  repositoryRecoveryProbeAuthorizationSchema, repositoryRecoveryIpcRequestSchema, repositoryRecoveryProbeJournalSchema,
  validateRecoveryProbeAuthorization, validateRecoveryProbeJournal, recoveryIpcConfigurationSchema, validateRecoveryIpcConfigurationBinding,
  type RecoveryProcessIdentity, type RecoveryStoppedProcess, type RepositoryRecoveryAuthorization } from "../src/services/repository-recovery-runtime-observation.js";

// A private reader authorizes this bounded completed-dispatch drill. No model/request can command a restart.
const fail = () => new Error("REPOSITORY_RECOVERY_RUNTIME_UNAVAILABLE");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Runtime = { runtime: Awaited<ReturnType<typeof launchObservedNodeRuntime>>; identity?: RecoveryProcessIdentity;
  stopped?: RecoveryStoppedProcess; stopping: boolean; exited: boolean;
  pending?: { resolve: (raw: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } };
const children: Runtime[] = [];
let fatal = false, normalEnabled = false, normalPending: Promise<void> | undefined;
let poll: NodeJS.Timeout | undefined;
const deadline = Date.now() + 600_000;
process.on("SIGTERM", () => { fatal = true; }); process.on("SIGINT", () => { fatal = true; });
try {
  if (process.platform !== "linux" || process.argv.length !== 2 || process.execArgv.length
    || Object.keys(process.env).some(name => /^(NODE_(?!ENV$)|LD_|DYLD_)/.test(name) && process.env[name])) throw fail();
  const file = process.env.VERRAIL_RECOVERY_OBSERVER_CONFIG;
  if (!file || !path.isAbsolute(file) || await realpath(path.dirname(file)) !== path.dirname(file)) throw fail();
  const config = repositoryRecoveryRuntimeConfigurationSchema.parse(await readPrivateProofJson(file));
  if (hash(await readFile(fileURLToPath(import.meta.url))) !== config.verifierBuildSha256
    || hash(await readFile(process.execPath)) !== config.observerExecutableSha256
    || !path.isAbsolute(config.directory) || await realpath(config.directory) !== config.directory) throw fail();
  const metadata = await stat(config.directory);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077) throw fail();
  const readerKey = createPublicKey(config.readerPublicKey), signingKey = createPrivateKey(config.privateKey);
  if (readerKey.asymmetricKeyType !== "ed25519" || signingKey.asymmetricKeyType !== "ed25519"
    || hash(readerKey.export({ type: "spki", format: "der" })) !== config.readerPublicKeySha256) throw fail();
  const ipcFile = config.node.env.VERRAIL_RECOVERY_IPC_FILE;
  if (!ipcFile || !path.isAbsolute(ipcFile) || await realpath(path.dirname(ipcFile)) !== path.dirname(ipcFile)) throw fail();
  const ipcConfig = recoveryIpcConfigurationSchema.parse(await readPrivateProofJson(ipcFile));
  validateRecoveryIpcConfigurationBinding(ipcConfig, config, { configurationSha256: config.node.env.VERRAIL_RECOVERY_IPC_SHA256,
    executable: await realpath(process.execPath), entrypoint: fileURLToPath(import.meta.url) });
  const prefix = path.join(config.directory, `${config.recoverySessionId}-recovery`);
  const paths = repositoryRecoveryRuntimePaths(config.directory, config.recoverySessionId);
  const normalPrefix = openCodeWitnessPrefix(config.directory, config.candidateSessionId, "repository_executor");
  for (const target of [prefix, normalPrefix]) await writeFile(`${target}.owner`, String(process.pid), { flag: "wx", mode: 0o600 });
  const common = { schemaVersion: 1 as const, recoverySessionId: config.recoverySessionId, nonce: randomUUID(), identity: config.identity,
    candidateSessionId: config.candidateSessionId, runtimeManifestSha256: config.runtimeManifestSha256,
    configurationSha256: recoveryRuntimeDigest({ engine: "node", config: config.node }) };
  const checkDeadline = () => { if (fatal || Date.now() >= deadline) throw fail(); };
  async function immutableJson(filename: string, value: unknown) {
    const bytes = canonicalJson(value); if (Buffer.byteLength(bytes) > 1024 * 1024) throw fail();
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o400 });
      await link(temporary, filename); // Atomic publication that refuses an existing destination.
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  async function publishRecovery(name: "ready" | "transition" | "duplicateJournal" | "staleJournal" | "final", payload: Parameters<typeof signRecoveryObserverEnvelope>[0]) {
    const envelope = signRecoveryObserverEnvelope(payload, config.privateKey);
    await immutableJson(paths[name], envelope);
  }
  async function archiveReader(name: "verifiedAuthorization" | "verifiedProbeAuthorization" | "verifiedCompletion", envelope: unknown) {
    // Store the exact verified envelope, not just a caller-provided digest.
    await immutableJson(paths[name], envelope);
  }
  async function readAuthorization(name: "authorize" | "probeAuthorize" | "complete") {
    while (true) {
      checkDeadline();
      try {
        const envelope = await readPrivateProofJson(paths[name]);
        const value = verifyRecoveryReaderEnvelope(envelope, config.readerPublicKey);
        return { value, envelope };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await sleep(50);
    }
  }
  async function launch() {
    const owned: Runtime = { runtime: undefined as never, stopping: false, exited: false };
    owned.runtime = await launchObservedNodeRuntime(config.node, {
      stdout: process.stdout, stderr: process.stderr,
      onMessage: raw => {
        const pending = owned.pending;
        if (!pending || typeof raw !== "string" || Buffer.byteLength(raw) > 8192) { fatal = true; pending?.reject(fail()); return; }
        clearTimeout(pending.timer); owned.pending = undefined; pending.resolve(raw);
      },
      onExit: () => { owned.exited = true; if (!owned.stopping) fatal = true; },
      stopProcessGroup: async child => {
        if (!owned.identity) {
          // Startup failure cleanup still uses the launch-owned ChildProcess, never a supplied PID.
          if (child.exitCode !== null || child.signalCode !== null) throw fail();
          owned.identity = await readLinuxProcessIdentity(child.pid!);
        }
        owned.stopped = await stopRecoveryOwnedNode(child, owned.identity);
      },
    });
    children.push(owned);
    const observed = await snapshot(owned);
    owned.identity = observed.process;
    return owned;
  }
  async function snapshot(owned: Runtime) {
    checkDeadline();
    const observation = await owned.runtime.checkpoint(), identity = await readLinuxProcessIdentity(observation.pid);
    if (identity.pgid !== identity.pid || identity.sessionId !== identity.pid
      || (owned.identity && canonicalJson(owned.identity) !== canonicalJson(identity))
      || observation.candidateCommit !== config.node.candidateCommit || observation.executableSha256 !== config.node.executableSha256
      || observation.manifestSha256 !== config.sourceManifestSha256) throw fail();
    return { process: identity, observation };
  }
  async function stop(owned: Runtime) {
    owned.stopping = true;
    if (owned.pending) { clearTimeout(owned.pending.timer); owned.pending.reject(fail()); owned.pending = undefined; }
    await owned.runtime.stop();
    if (!owned.stopped || !owned.exited || processGroupExists(owned.stopped.process.pgid)) throw fail();
    return owned.stopped;
  }
  function verifyOwnedCleanup(auth: RepositoryRecoveryAuthorization) {
    const value = auth.ownedCleanup;
    // Commands are the verified executor's stop-ack receipt basis, not a direct Docker/cgroup observation here.
    if (processGroupExists(value.observerPid) || processGroupExists(value.nativePid)) throw fail();
    return { observerPid: value.observerPid, nativePid: value.nativePid, checkedAt: new Date().toISOString(), processGroupsGone: true as const,
      basis: value.basis, outputReceiptSha256: value.outputReceiptSha256, terminationEnvelopeSha256: value.terminationEnvelopeSha256 };
  }
  const old = await launch(), first = await snapshot(old);
  const ready = repositoryRecoveryReadySchema.parse({ ...common, kind: "verrail.repository-recovery-runtime-ready",
    observerProcess: await readLinuxProcessIdentity(process.pid), verifierBuildSha256: config.verifierBuildSha256,
    observerExecutableSha256: config.observerExecutableSha256, old: first, observedAt: new Date().toISOString() });
  await publishRecovery("ready", ready);
  let lastNormalWitnessSha256: string | undefined;
  const normalEnvelope = async (suffix: "ready" | "witness", payload: unknown) => {
    const bytes = Buffer.from(canonicalJson(payload)), envelope = { schemaVersion: 1, payload: bytes.toString("base64"),
      signature: sign(null, Buffer.concat([openCodeWitnessDomain, bytes]), signingKey).toString("base64") };
    if (envelope.payload.length > 900_000) throw fail();
    const temporary = `${normalPrefix}.${suffix}.${randomUUID()}.tmp`;
    await writeFile(temporary, canonicalJson(envelope), { flag: "wx", mode: 0o600 });
    await rename(temporary, `${normalPrefix}.${suffix}.json`);
    if (suffix === "witness") lastNormalWitnessSha256 = recoveryRuntimeDigest(envelope);
  };
  await normalEnvelope("ready", { schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-ready", component: "repository_executor",
    sessionId: config.candidateSessionId, manifestSha256: config.runtimeManifestSha256, verifierBuildSha256: config.verifierBuildSha256, observerPid: process.pid });
  let lastRequest: string | undefined;
  normalEnabled = true;
  poll = setInterval(() => {
    if (!normalEnabled || normalPending) return;
    normalPending = (async () => {
      let raw: unknown;
      try { raw = await readPrivateProofJson(`${normalPrefix}.checkpoint.json`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const request = openCodeCheckpointRequestSchema.parse(raw);
      if (lastRequest === request.requestId) return;
      if (Date.now() < Date.parse(request.requestedAt) || Date.now() - Date.parse(request.requestedAt) > 12_000) throw fail();
      lastRequest = request.requestId;
      const current = await snapshot(old);
      await normalEnvelope("witness", openCodeCandidateWitnessSchema.parse({ schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-witness",
        component: "repository_executor", phase: "checkpoint", sessionId: config.candidateSessionId, requestId: request.requestId,
        manifestSha256: config.runtimeManifestSha256, verifierBuildSha256: config.verifierBuildSha256,
        observerExecutableSha256: config.observerExecutableSha256, configurationSha256: common.configurationSha256, observerPid: process.pid,
        observation: current.observation, executionIdentity: null, httpSession: null, termination: null,
        launch: { rootSha256: hash(config.node.root), argvSha256: recoveryRuntimeDigest([config.node.entrypoint]), environmentSha256: recoveryRuntimeDigest(config.node.env) } }));
    })().catch(() => { fatal = true; }).finally(() => { normalPending = undefined; });
  }, 50);
  const authorized = await readAuthorization("authorize"), authorization = repositoryRecoveryAuthorizationSchema.parse(authorized.value);
  validateRecoveryAuthorization(authorization, ready);
  await archiveReader("verifiedAuthorization", authorized.envelope);
  normalEnabled = false; clearInterval(poll); poll = undefined; await normalPending;
  checkDeadline();
  if (authorization.oldRuntimeWitnessEnvelopeSha256 !== lastNormalWitnessSha256
    || recoveryRuntimeDigest(await readPrivateProofJson(`${normalPrefix}.witness.json`)) !== lastNormalWitnessSha256) throw fail();
  const oldSnapshot = await snapshot(old); verifyOwnedCleanup(authorization);
  validateRecoveryAuthorization(authorization, ready);
  const oldStopped = await stop(old), oldCleanup = verifyOwnedCleanup(authorization);
  const next = await launch(), nextSnapshot = await snapshot(next);
  if (nextSnapshot.process.bootId !== oldSnapshot.process.bootId
    || nextSnapshot.process.pid === oldSnapshot.process.pid || nextSnapshot.process.startTicks === oldSnapshot.process.startTicks
    || Date.parse(nextSnapshot.observation.startedAt) < Date.parse(oldStopped.stoppedAt)
    || nextSnapshot.observation.observerSessionId === oldSnapshot.observation.observerSessionId) throw fail();
  const transition = repositoryRecoveryTransitionSchema.parse({ ...common, kind: "verrail.repository-recovery-runtime-transition",
    oldReadySha256: recoveryRuntimeDigest(ready), authorizationSha256: recoveryRuntimeDigest(authorization),
    beforeCheckpointSha256: authorization.beforeCheckpointSha256, old: oldSnapshot, oldStopped, ownedCleanup: oldCleanup,
    next: nextSnapshot, observedAt: new Date().toISOString() });
  validateRecoveryTransition(transition, ready, authorization);
  await publishRecovery("transition", transition);
  const authorizedProbes = await readAuthorization("probeAuthorize");
  const probeAuthorization = repositoryRecoveryProbeAuthorizationSchema.parse(authorizedProbes.value);
  validateRecoveryProbeAuthorization(probeAuthorization, ready, transition);
  await archiveReader("verifiedProbeAuthorization", authorizedProbes.envelope);
  const journals = [];
  for (const operation of ["reconcile", "stale_heartbeat"] as const) {
    const before = await snapshot(next);
    validateRecoveryProbeAuthorization(probeAuthorization, ready, transition);
    const issuedAt = new Date().toISOString(), challenge = randomUUID(), older = probeAuthorization.olderAttempt;
    const request = repositoryRecoveryIpcRequestSchema.parse({ schemaVersion: 1, kind: "verrail.repository-recovery-ipc-request",
      recoverySessionId: config.recoverySessionId, nonce: common.nonce, identity: config.identity, challenge,
      authorization: authorizedProbes.envelope, issuedAt,
      expiresAt: new Date(Math.min(Date.now() + 10_000, Date.parse(probeAuthorization.expiresAt))).toISOString(), operation,
      probe: operation === "reconcile" ? null : { workspaceId: config.identity.workspaceId, runId: config.identity.runId,
        runAttemptId: older.runAttemptId, idempotencyKey: `recovery-stale:${challenge}`,
        input: { leaseId: older.leaseId, fencingToken: older.fencingToken, cursor: older.cursor, eventType: "heartbeat",
          emittedAt: issuedAt.replace(/\.\d{3}Z$/, "Z") } } });
    const requestBytes = canonicalJson(request);
    if (Buffer.byteLength(requestBytes) > 8192 || next.pending) throw fail();
    const response = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { next.pending = undefined; reject(fail()); }, Math.max(1, Date.parse(request.expiresAt) - Date.now()));
      next.pending = { resolve, reject, timer };
      try { next.runtime.send(requestBytes); } catch { clearTimeout(timer); next.pending = undefined; reject(fail()); }
    });
    const receivedAt = new Date().toISOString(), after = await snapshot(next);
    const journal = repositoryRecoveryProbeJournalSchema.parse({ ...common, kind: "verrail.repository-recovery-probe-journal",
      probeAuthorizationSha256: recoveryRuntimeDigest(probeAuthorization), transitionSha256: recoveryRuntimeDigest(transition),
      operation, executor: nextSnapshot.process, before, after, request: requestBytes, requestSha256: hash(requestBytes),
      requestBytes: Buffer.byteLength(requestBytes), response, responseSha256: hash(response), responseBytes: Buffer.byteLength(response), issuedAt, receivedAt });
    validateRecoveryProbeJournal(journal, ready, transition, probeAuthorization, config.readerPublicKey);
    await publishRecovery(operation === "reconcile" ? "duplicateJournal" : "staleJournal", journal);
    journals.push(journal);
  }
  const completed = await readAuthorization("complete"), completion = repositoryRecoveryCompletionAuthorizationSchema.parse(completed.value);
  validateRecoveryCompletion(completion, ready, transition);
  if (completion.probeAuthorizationSha256 !== recoveryRuntimeDigest(probeAuthorization)
    || completion.duplicateJournalSha256 !== recoveryRuntimeDigest(journals[0])
    || completion.staleJournalSha256 !== recoveryRuntimeDigest(journals[1])) throw fail();
  await archiveReader("verifiedCompletion", completed.envelope);
  const finalSnapshot = await snapshot(next);
  if (Date.parse(finalSnapshot.observation.observedAt) < Date.parse(completion.afterObservedAt)) throw fail();
  validateRecoveryCompletion(completion, ready, transition);
  const nextStopped = await stop(next), finalCleanup = verifyOwnedCleanup(authorization);
  checkDeadline();
  const final = repositoryRecoveryFinalSchema.parse({ ...common, kind: "verrail.repository-recovery-runtime-final",
    oldReadySha256: transition.oldReadySha256, authorizationSha256: transition.authorizationSha256,
    transitionSha256: recoveryRuntimeDigest(transition), completionAuthorizationSha256: recoveryRuntimeDigest(completion),
    beforeCheckpointSha256: authorization.beforeCheckpointSha256, afterCheckpointSha256: completion.afterCheckpointSha256,
    oldStopped, next: finalSnapshot, nextStopped, ownedCleanup: finalCleanup, observedAt: new Date().toISOString() });
  validateRecoveryFinal(final, ready, authorization, transition, completion);
  await publishRecovery("final", final);
} catch {
  fatal = true; process.stderr.write("REPOSITORY_RECOVERY_RUNTIME_UNAVAILABLE\n");
} finally {
  normalEnabled = false; if (poll) clearInterval(poll); await normalPending;
  for (const owned of children.reverse()) {
    owned.stopping = true;
    if (owned.pending) { clearTimeout(owned.pending.timer); owned.pending.reject(fail()); owned.pending = undefined; }
    try { await owned.runtime.stop(); if (!owned.stopped || !owned.exited || processGroupExists(owned.stopped.process.pgid)) fatal = true; }
    catch { fatal = true; }
  }
}
process.exit(fatal ? 1 : 0);
