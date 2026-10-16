import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { authorizeRepositoryRecovery, authorizeRepositoryRecoveryProbes, authorizeRepositoryRecoveryCompletion, loadRepositoryRecoveryRuntimeContext } from "./repository-recovery-proof-reader.js";
import { syntheticCandidateWitnesses } from "../__tests__/helpers/opencode-candidate-witness.js";
import { observationFixtureId as id, observationFixtureHash as hash, observationFixtureTime as time } from "../__tests__/helpers/repository-execution-observation.js";
import { openCodeRuntimeDigest as digest, openCodeWitnessDomain } from "./opencode-runtime-observation.js";
import { repositoryRecoveryRuntimePaths, signRecoveryObserverEnvelope, verifyRecoveryReaderEnvelope } from "./repository-recovery-runtime-observation.js";
import { projectRepositoryRecoveryProof, repositoryRecoveryProofSchema } from "./repository-recovery-proof-projection.js";

const mocked = vi.hoisted(() => ({ authority: vi.fn(), checkpoint: vi.fn(), completion: vi.fn(), runtime: vi.fn(),
  staleCheckpoint: vi.fn(), staleContext: vi.fn() }));
vi.mock("./delivery-proof-reader-access.js", () => ({ assertDeliveryProofReader: mocked.authority }));
vi.mock("./repository-recovery-proof-context.js", async importOriginal => ({
  ...await importOriginal<typeof import("./repository-recovery-proof-context.js")>(),
  collectRepositoryRecoveryCheckpoint: mocked.checkpoint, collectRepositoryRecoveryCompletion: mocked.completion,
}));
vi.mock("./opencode-runtime-observation.js", async importOriginal => ({
  ...await importOriginal<typeof import("./opencode-runtime-observation.js")>(), collectOpenCodeRuntimeWitnesses: mocked.runtime,
}));
vi.mock("./repository-stale-fence-proof-context.js", () => ({
  collectRepositoryStaleFenceProbeCheckpoint: mocked.staleCheckpoint, collectRepositoryStaleFenceContext: mocked.staleContext,
}));
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const keys = () => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString() };
};
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "verrail-recovery-reader-unit-")));
  roots.push(directory); await chmod(directory, 0o700);
  const observer = keys(), reader = keys(), sha = "a".repeat(64);
  const manifest = { schemaVersion: 1 as const, kind: "verrail.opencode-runtime-manifest" as const, candidateCommit: "b".repeat(40),
    apiOriginSha256: sha, domainOriginSha256: sha, observerExecutableSha256: sha,
    components: (["server", "domain", "repository_executor", "opencode"] as const).map(component => ({ component,
      configurationSha256: sha, verifierBuildSha256: sha, executableSha256: sha,
      sourceManifestSha256: ["server", "repository_executor"].includes(component) ? sha : null })) };
  const manifestSha256 = digest(manifest), runtime = syntheticCandidateWitnesses(1, manifestSha256);
  const executor = runtime.witnesses.find(value => value.component === "repository_executor")!;
  if (executor.observation.kind !== "verrail.node-runtime-observation") throw new Error("wrong fixture runtime");
  executor.observerPid = 300;
  const native = runtime.witnesses.find(value => value.component === "opencode")!;
  const archive = path.join(directory, "witness-archive", "sha256");
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await chmod(path.dirname(archive), 0o700);
  for (const witness of runtime.witnesses) {
    const { envelopeRef: _, ...body } = witness, bytes = Buffer.from(canonicalJson(body));
    const envelope = Buffer.from(canonicalJson({ schemaVersion: 1, payload: bytes.toString("base64"),
      signature: sign(null, Buffer.concat([openCodeWitnessDomain, bytes]), observer.privateKey).toString("base64") }));
    witness.envelopeRef = { contentHash: hash(envelope), bytes: envelope.length, contentRef: `private-witness:sha256:${hash(envelope)}` };
    await writeFile(path.join(archive, `${hash(envelope)}.json`), envelope, { mode: 0o400 });
  }
  const identity = native.executionIdentity!, processIdentity = { bootId: id, pid: 200, pgid: 200, sessionId: 200, startTicks: "10" };
  const ready = { schemaVersion: 1 as const, kind: "verrail.repository-recovery-runtime-ready" as const,
    recoverySessionId: id, nonce: id, identity, candidateSessionId: id, runtimeManifestSha256: manifestSha256,
    configurationSha256: sha, verifierBuildSha256: sha, observerExecutableSha256: sha,
    observerProcess: { ...processIdentity, pid: 300, pgid: 300, sessionId: 300, startTicks: "9" },
    old: { process: processIdentity, observation: executor.observation }, observedAt: new Date().toISOString() };
  const config = { recoverySessionId: id, directory, observerPublicKey: observer.publicKey, readerPrivateKey: reader.privateKey,
    runtime: { directory, publicKey: observer.publicKey, sessionId: id, manifest, manifestSha256 } };
  const paths = repositoryRecoveryRuntimePaths(directory, id);
  const publish = async (filename: string, value: unknown) => {
    // Unit fixtures deliberately replace their own signed files for negative cases.
    await rm(filename, { force: true });
    await writeFile(filename, canonicalJson(value), { mode: 0o400, flag: "wx" });
  };
  await publish(paths.ready, signRecoveryObserverEnvelope(ready, observer.privateKey));
  const durable = { identity, controllerId: id, requestSha256: sha, dispatchSha256: sha, outputReceiptSha256: sha,
    attemptInventorySha256: sha, dispatchInventorySha256: sha, sourceBindingSha256: sha,
    executionObservationSha256: sha, executionLogSha256: sha, executionSessionId: native.httpSession!.sessionId,
    candidateSessionId: id, runtimeManifestSha256: manifestSha256,
    runtimeBinding: { runtimeWindow: { startedAt: time(0), finishedAt: time(8) },
      httpSession: { ...native.httpSession!, completedAt: time(6) }, candidateRuntime: {
        kind: "verrail.opencode-session-bound", nativePid: native.observation.pid, observerPid: native.observerPid,
        sessionId: id, manifestSha256, executionIdentitySha256: digest(identity), httpSession: native.httpSession! } },
    finishedAt: time(9), artifactCount: 1 };
  const checkpoint = () => {
    const body = { schemaVersion: 1, kind: "verrail.repository-recovery-checkpoint", phase: "before_registration",
      observedAt: new Date().toISOString(), durable, events: [{ id, cursor: 1, eventType: "started", sha256: sha }] };
    return { ...body, contextSha256: digest(body) };
  };
  const completionBody = { schemaVersion: 1, kind: "verrail.repository-recovery-completion", durable,
    sourceContextSha256: sha, eventsSha256: sha, artifactsSha256: sha, authoritativeResultSha256: sha };
  const completion = { ...completionBody, contextSha256: digest(completionBody) };
  const staleBody = { schemaVersion: 1, kind: "verrail.repository-stale-fence-probe-checkpoint", identity,
    oldAttemptId: randomUUID(), oldAttemptNumber: 1, oldLeaseId: randomUUID(), oldFencingToken: 1, nextCursor: 3,
    oldAttemptSha256: sha, oldLeaseSha256: sha, oldEventsSha256: sha, currentAttemptSha256: sha,
    currentRunSha256: sha, currentLeaseSha256: sha };
  const staleCheckpoint = { ...staleBody, contextSha256: digest(staleBody) };
  mocked.authority.mockResolvedValue({ schemaVersion: 4 }); mocked.checkpoint.mockImplementation(async () => checkpoint());
  mocked.runtime.mockResolvedValue(runtime); mocked.completion.mockResolvedValue(completion);
  mocked.staleCheckpoint.mockResolvedValue(staleCheckpoint);
  const access = { schemaVersion: 4 as const, workspaceId: id, roleName: "verrail_proof_ro_aaaaaaaaaaaa", schemaName: "fixture",
    databaseUrl: "postgres://synthetic.invalid", expiresAt: new Date(Date.now() + 60000).toISOString(), policySha256: sha };
  const selection = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, runId: id, runAttemptId: id };
  const afterSelection = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id,
    claimId: id, workNodeId: id, artifactRevisionId: id, requirementId: "synthetic-recovery" };
  const options = { config, storage: { getObject: vi.fn() }, repository: { repository: "fixture/repository", connectionId: id, bindingId: id } };
  return { directory, observer, reader, runtime, executor, native, ready, paths, publish, durable, checkpoint, completion, staleCheckpoint,
    config, access, selection, afterSelection, options, db: {} as Db };
}
async function transitionFixture() {
  const f = await fixture(); await authorizeRepositoryRecovery(f.db, f.access, f.selection, f.options);
  const auth = verifyRecoveryReaderEnvelope(JSON.parse(await readFile(f.paths.authorize, "utf8")), f.reader.publicKey);
  if (auth.kind !== "verrail.repository-recovery-authorize") throw new Error("wrong fixture phase");
  const now = new Date().toISOString(), next = structuredClone(f.ready.old), old = structuredClone(f.ready.old);
  next.process = { ...next.process, pid: 201, pgid: 201, sessionId: 201, startTicks: "20" };
  const { sha256: _, ...body } = next.observation;
  const nextBody = { ...body, pid: 201, observerSessionId: randomUUID(), startedAt: now, observedAt: now };
  next.observation = { ...nextBody, sha256: digest(nextBody) };
  const oldBody = { ...body, observedAt: now };
  old.observation = { ...oldBody, sha256: digest(oldBody) };
  const transition = { schemaVersion: 1 as const, kind: "verrail.repository-recovery-runtime-transition" as const,
    recoverySessionId: id, nonce: id, identity: f.ready.identity, candidateSessionId: id,
    runtimeManifestSha256: f.ready.runtimeManifestSha256, configurationSha256: f.ready.configurationSha256,
    oldReadySha256: digest(f.ready), authorizationSha256: digest(auth), beforeCheckpointSha256: auth.beforeCheckpointSha256,
    old, oldStopped: { process: f.ready.old.process, requestedSignal: "SIGTERM" as const,
      termSentAt: now, killSentAt: null, stoppedAt: now, processGroupGone: true as const, processReaped: true as const },
    ownedCleanup: { observerPid: f.native.observerPid, nativePid: f.native.observation.pid, checkedAt: now,
      processGroupsGone: true as const, basis: auth.ownedCleanup.basis, outputReceiptSha256: auth.ownedCleanup.outputReceiptSha256,
      terminationEnvelopeSha256: auth.ownedCleanup.terminationEnvelopeSha256 }, next, observedAt: now };
  await f.publish(f.paths.transition, signRecoveryObserverEnvelope(transition, f.observer.privateKey));
  return { ...f, auth, transition };
}
async function probeFixture() {
  const f = await transitionFixture();
  await authorizeRepositoryRecoveryProbes(f.db, f.access, f.afterSelection, f.staleCheckpoint.oldAttemptId, f.options);
  const authorizationEnvelope = JSON.parse(await readFile(f.paths.probeAuthorize, "utf8"));
  const authorization = verifyRecoveryReaderEnvelope(authorizationEnvelope, f.reader.publicKey);
  if (authorization.kind !== "verrail.repository-recovery-probe-authorize") throw new Error("wrong fixture phase");
  const journal = (operation: "reconcile" | "stale_heartbeat") => {
    const now = new Date().toISOString(), challenge = randomUUID();
    const request = { schemaVersion: 1, kind: "verrail.repository-recovery-ipc-request", recoverySessionId: id,
      nonce: id, identity: f.ready.identity, challenge, authorization: authorizationEnvelope, issuedAt: now,
      expiresAt: new Date(Math.min(Date.parse(now) + 10000, Date.parse(authorization.expiresAt))).toISOString(), operation,
      probe: operation === "reconcile" ? null : { workspaceId: id, runId: id, runAttemptId: f.staleCheckpoint.oldAttemptId,
        idempotencyKey: `recovery-stale:${challenge}`, input: { leaseId: f.staleCheckpoint.oldLeaseId,
          fencingToken: 1, cursor: 3, eventType: "heartbeat", emittedAt: now.replace(/\.\d{3}Z$/, "Z") } } };
    const requestBytes = canonicalJson(request), result = operation === "reconcile" ? { status: "registered" } : {
      schemaVersion: 1, runId: id, runAttemptId: f.staleCheckpoint.oldAttemptId, cursor: 3, eventType: "heartbeat",
      authoritative: false, rejectionCode: "STALE_FENCING_TOKEN", runStatus: "succeeded", attemptStatus: "failed",
      leaseStatus: "expired", replayed: false };
    const response = { schemaVersion: 1, kind: "verrail.repository-recovery-ipc-response", challenge,
      requestSha256: hash(Buffer.from(requestBytes)), executorPid: f.transition.next.process.pid, completedAt: now, operation, result };
    const responseBytes = canonicalJson(response), { sha256: _, ...body } = f.transition.next.observation;
    const snapshot = { ...f.transition.next, observation: { ...body, observedAt: now, sha256: digest({ ...body, observedAt: now }) } };
    const value = { schemaVersion: 1 as const, kind: "verrail.repository-recovery-probe-journal" as const,
      recoverySessionId: id, nonce: id, identity: f.ready.identity, candidateSessionId: id,
      runtimeManifestSha256: f.ready.runtimeManifestSha256, configurationSha256: f.ready.configurationSha256,
      probeAuthorizationSha256: digest(authorization), transitionSha256: digest(f.transition), operation,
      executor: f.transition.next.process, before: snapshot, after: snapshot, request: requestBytes,
      requestSha256: hash(Buffer.from(requestBytes)), requestBytes: Buffer.byteLength(requestBytes), response: responseBytes,
      responseSha256: hash(Buffer.from(responseBytes)), responseBytes: Buffer.byteLength(responseBytes), issuedAt: now, receivedAt: now };
    return { value, request, response };
  };
  const duplicate = journal("reconcile"), stale = journal("stale_heartbeat");
  await f.publish(f.paths.duplicateJournal, signRecoveryObserverEnvelope(duplicate.value, f.observer.privateKey));
  await f.publish(f.paths.staleJournal, signRecoveryObserverEnvelope(stale.value, f.observer.privateKey));
  const staleContext = { probeCheckpoint: f.staleCheckpoint, response: stale.response.result,
    receiptCreatedAt: stale.value.receivedAt, auditOccurredAt: stale.value.receivedAt, contextSha256: "a".repeat(64),
    requestHash: "a".repeat(64), idempotencyKey: stale.request.probe!.idempotencyKey,
    receiptId: randomUUID(), receiptSha256: "a".repeat(64), auditId: randomUUID(), auditSha256: "a".repeat(64) };
  mocked.staleContext.mockResolvedValue(staleContext);
  return { ...f, probeAuthorization: authorization, duplicate, stale, staleContext };
}
it("publishes authorization only after two stable real-data calls and four archived signed witnesses", async () => {
  const f = await fixture();
  await authorizeRepositoryRecovery(f.db, f.access, f.selection, f.options);
  expect(mocked.checkpoint).toHaveBeenCalledTimes(2); expect(mocked.runtime).toHaveBeenCalledOnce();
  const auth = verifyRecoveryReaderEnvelope(JSON.parse(await readFile(f.paths.authorize, "utf8")), f.reader.publicKey);
  expect(auth).toMatchObject({ kind: "verrail.repository-recovery-authorize", ownedCleanup: {
    basis: "candidate_executor_typed_output_receipt_and_signed_opencode_termination", outputReceiptSha256: f.durable.outputReceiptSha256 } });
  expect(auth).not.toHaveProperty("commandCleanupWitnessSha256");
  const before = JSON.parse(await readFile(path.join(f.directory, `${id}-recovery.reader-before.json`), "utf8"));
  expect(auth).toMatchObject({ preRuntimeProofSha256: digest(before.preRuntime), beforeCheckpointSha256: before.checkpoint.contextSha256 });
  await expect(authorizeRepositoryRecovery(f.db, f.access, f.selection, f.options)).rejects.toThrow();
});
it.each(["old authority", "ready signature", "ready identity", "old pid", "before drift", "missing archive", "archive bytes"])("cannot authorize %s", async failure => {
  const f = await fixture();
  if (failure === "old authority") Object.assign(f.access, { schemaVersion: 3 });
  if (failure === "ready signature") await f.publish(f.paths.ready, signRecoveryObserverEnvelope(f.ready, keys().privateKey));
  if (failure === "ready identity") {
    f.ready.identity = { ...f.ready.identity, fencingToken: 3 };
    await f.publish(f.paths.ready, signRecoveryObserverEnvelope(f.ready, f.observer.privateKey));
  }
  if (failure === "old pid") f.executor.observation.pid = 999;
  if (failure === "before drift") mocked.checkpoint.mockResolvedValueOnce(f.checkpoint()).mockImplementation(async () => ({ ...f.checkpoint(), durable: { ...f.durable, dispatchSha256: "b".repeat(64) } }));
  if (failure === "missing archive") await rm(path.join(f.directory, "witness-archive"), { recursive: true });
  if (failure === "archive bytes") {
    const file = path.join(f.directory, "witness-archive", "sha256", `${f.native.envelopeRef.contentHash}.json`);
    await chmod(file, 0o600); await writeFile(file, "{}"); await chmod(file, 0o400);
  }
  await expect(authorizeRepositoryRecovery(f.db, f.access, f.selection, f.options)).rejects.toThrow();
  await expect(readFile(f.paths.authorize)).rejects.toMatchObject({ code: "ENOENT" });
});
it("authenticates actual operation journals and unchanged data without claiming active requirement or CI admission", async () => {
  const f = await probeFixture();
  await authorizeRepositoryRecoveryCompletion(f.db, f.access, f.afterSelection, f.options);
  const auth = verifyRecoveryReaderEnvelope(JSON.parse(await readFile(f.paths.complete, "utf8")), f.reader.publicKey);
  if (auth.kind !== "verrail.repository-recovery-complete-authorize") throw new Error("wrong fixture phase");
  const now = new Date().toISOString(), { sha256: _, ...body } = f.transition.next.observation;
  const terminal = { schemaVersion: 1 as const, kind: "verrail.repository-recovery-runtime-final" as const,
    recoverySessionId: id, nonce: id, identity: f.ready.identity, candidateSessionId: id,
    runtimeManifestSha256: f.ready.runtimeManifestSha256, configurationSha256: f.ready.configurationSha256,
    oldReadySha256: digest(f.ready), authorizationSha256: digest(f.auth), transitionSha256: digest(f.transition),
    completionAuthorizationSha256: digest(auth), beforeCheckpointSha256: f.auth.beforeCheckpointSha256,
    afterCheckpointSha256: f.completion.contextSha256, oldStopped: f.transition.oldStopped,
    next: { ...f.transition.next, observation: { ...body, observedAt: now, sha256: digest({ ...body, observedAt: now }) } },
    nextStopped: { process: f.transition.next.process, requestedSignal: "SIGTERM" as const, termSentAt: now,
      killSentAt: null, stoppedAt: now, processGroupGone: true as const, processReaped: true as const },
    ownedCleanup: { ...f.transition.ownedCleanup, checkedAt: now }, observedAt: now };
  await f.publish(f.paths.final, signRecoveryObserverEnvelope(terminal, f.observer.privateKey));
  const result = await loadRepositoryRecoveryRuntimeContext(f.db, f.access, f.options);
  expect(result.deliveryProof).toBe(false);
  expect(result.remainingObligations).toEqual(["active_requirement", "fixed_ci"]);
  expect(result.staleContext).toEqual(f.staleContext);
  const projection = projectRepositoryRecoveryProof(result);
  if (process.env.VERRAIL_RECOVERY_PROJECTION_INTEROP === "1") process.stdout.write(`RECOVERY_PROJECTION_INTEROP ${JSON.stringify({ synthetic: true, projection })}\n`);
  expect(Buffer.byteLength(canonicalJson(projection))).toBeLessThan(16000);
  for (const ref of Object.values(projection.archives)) {
    const bytes = await readFile(path.join(f.directory, "recovery-archive", "sha256", `${ref.contentHash}.json`));
    expect(hash(bytes)).toBe(ref.contentHash); expect(bytes.length).toBe(ref.bytes);
  }
  expect(repositoryRecoveryProofSchema.safeParse({ ...projection, archives: { ...projection.archives,
    final: { ...projection.archives.final, contentRef: `private-recovery:sha256:${"f".repeat(64)}` } } }).success).toBe(false);
  expect(projectRepositoryRecoveryProof(await loadRepositoryRecoveryRuntimeContext(f.db, f.access, f.options))).toEqual(projection);
  for (const mutate of [
    (value: typeof terminal) => { value.next.observation.candidateCommit = "f".repeat(40); },
    (value: typeof terminal) => { value.next.process.startTicks = "999"; },
    (value: typeof terminal) => { value.next.observation.observerSessionId = f.ready.old.observation.observerSessionId; },
    (value: typeof terminal) => { value.nonce = randomUUID(); },
    (value: typeof terminal) => { value.afterCheckpointSha256 = "f".repeat(64); },
  ]) {
    const changed = structuredClone(terminal); mutate(changed);
    const { sha256: _, ...observation } = changed.next.observation;
    changed.next.observation.sha256 = digest(observation);
    await f.publish(f.paths.final, signRecoveryObserverEnvelope(changed, f.observer.privateKey));
    await expect(loadRepositoryRecoveryRuntimeContext(f.db, f.access, f.options)).rejects.toThrow();
  }
  await f.publish(f.paths.final, signRecoveryObserverEnvelope(terminal, f.observer.privateKey));
  mocked.completion.mockResolvedValue({ ...f.completion, contextSha256: "b".repeat(64) });
  await expect(loadRepositoryRecoveryRuntimeContext(f.db, f.access, f.options)).rejects.toThrow();
});
it.each(["unsigned transition", "wrong birth", "after drift", "mutated before"])("cannot authorize completion after %s", async failure => {
  const f = await probeFixture();
  if (failure === "unsigned transition") await f.publish(f.paths.transition, f.transition);
  if (failure === "wrong birth") {
    f.transition.oldStopped.process = { ...f.transition.oldStopped.process, startTicks: "999" };
    await f.publish(f.paths.transition, signRecoveryObserverEnvelope(f.transition, f.observer.privateKey));
  }
  if (failure === "after drift") mocked.completion.mockResolvedValueOnce(f.completion).mockResolvedValue({ ...f.completion, contextSha256: "b".repeat(64) });
  if (failure === "mutated before") {
    const file = path.join(f.directory, `${id}-recovery.reader-before.json`), value = JSON.parse(await readFile(file, "utf8"));
    value.checkpoint.durable.outputReceiptSha256 = "b".repeat(64);
    await chmod(file, 0o600); await writeFile(file, canonicalJson(value)); await chmod(file, 0o400);
  }
  await expect(authorizeRepositoryRecoveryCompletion(f.db, f.access, f.afterSelection, f.options)).rejects.toThrow();
  await expect(readFile(f.paths.complete)).rejects.toMatchObject({ code: "ENOENT" });
});
it("does not substitute repeated data reads for execution journals", async () => {
  const f = await transitionFixture();
  await authorizeRepositoryRecoveryProbes(f.db, f.access, f.afterSelection, f.staleCheckpoint.oldAttemptId, f.options);
  await expect(authorizeRepositoryRecoveryCompletion(f.db, f.access, f.afterSelection, f.options)).rejects.toThrow();
  await expect(readFile(f.paths.complete)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["replayed response", "foreign challenge", "wrong request hash", "noncanonical request", "old state drift",
  "current state drift", "receipt predates journal", "audit predates journal", "unsigned journal", "same challenge", "missing duplicate"])("rejects probe %s", async failure => {
  const f = await probeFixture(), journal = structuredClone(f.stale.value);
  const response = JSON.parse(journal.response), request = JSON.parse(journal.request);
  if (failure === "replayed response") response.result.replayed = true;
  if (failure === "foreign challenge") response.challenge = randomUUID();
  if (failure === "wrong request hash") response.requestSha256 = "f".repeat(64);
  if (failure === "same challenge") {
    request.challenge = f.duplicate.request.challenge; request.probe.idempotencyKey = `recovery-stale:${request.challenge}`;
    response.challenge = request.challenge;
  }
  journal.request = canonicalJson(request); journal.requestBytes = Buffer.byteLength(journal.request);
  journal.requestSha256 = hash(Buffer.from(journal.request));
  if (failure === "same challenge") response.requestSha256 = journal.requestSha256;
  journal.response = canonicalJson(response); journal.responseBytes = Buffer.byteLength(journal.response);
  journal.responseSha256 = hash(Buffer.from(journal.response));
  if (failure === "noncanonical request") {
    journal.request = JSON.stringify(request, null, 1); journal.requestBytes = Buffer.byteLength(journal.request);
    journal.requestSha256 = hash(Buffer.from(journal.request));
  }
  await f.publish(f.paths.staleJournal, failure === "unsigned journal" ? journal : signRecoveryObserverEnvelope(journal, f.observer.privateKey));
  if (failure === "old state drift") mocked.staleContext.mockResolvedValue({ ...f.staleContext,
    probeCheckpoint: { ...f.staleCheckpoint, oldEventsSha256: "f".repeat(64) } });
  if (failure === "current state drift") mocked.staleCheckpoint.mockResolvedValue({ ...f.staleCheckpoint, currentRunSha256: "f".repeat(64) });
  if (failure === "receipt predates journal") mocked.staleContext.mockResolvedValue({ ...f.staleContext, receiptCreatedAt: time(0) });
  if (failure === "audit predates journal") mocked.staleContext.mockResolvedValue({ ...f.staleContext, auditOccurredAt: time(0) });
  if (failure === "missing duplicate") await rm(f.paths.duplicateJournal);
  await expect(authorizeRepositoryRecoveryCompletion(f.db, f.access, f.afterSelection, f.options)).rejects.toThrow();
  await expect(readFile(f.paths.complete)).rejects.toMatchObject({ code: "ENOENT" });
});
