import { createHash, generateKeyPairSync } from "node:crypto";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { expect, it } from "vitest";
import { repositoryRecoveryReadySchema, repositoryRecoveryAuthorizationSchema, repositoryRecoveryTransitionSchema,
  repositoryRecoveryCompletionAuthorizationSchema, repositoryRecoveryFinalSchema, recoveryRuntimeDigest,
  signRecoveryReaderEnvelope, signRecoveryObserverEnvelope, verifyRecoveryReaderEnvelope, verifyRecoveryObserverEnvelope,
  validateRecoveryAuthorization, validateRecoveryCompletion, validateRecoveryTransition, validateRecoveryFinal,
  parseLinuxProcessIdentity, stopRecoveryOwnedNode, repositoryRecoveryRuntimePaths,
  repositoryRecoveryProbeAuthorizationSchema, repositoryRecoveryProbeJournalSchema,
  validateRecoveryProbeAuthorization, validateRecoveryProbeJournal } from "./repository-recovery-runtime-observation.js";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", hash = "a".repeat(64);
const identity = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id,
  runId: id, runAttemptId: id, leaseId: id, fencingToken: 2, agentVersionId: id, deploymentRevisionId: id };
const processIdentity = (pid: number, startTicks = String(pid)) => ({ bootId: id, pid, pgid: pid, sessionId: pid, startTicks });
function fixture() {
  const now = Date.now(), time = (offset: number) => new Date(now + offset).toISOString();
  const observe = (pid: number, started: number, observed: number, observerSessionId = id) => {
    const raw = { schemaVersion: 1, kind: "verrail.node-runtime-observation", assurance: "observed_main_thread_scripts",
      observerSessionId, pid, candidateCommit: "a".repeat(40), executableSha256: hash, manifestSha256: hash,
      startedAt: time(started), observedAt: time(observed), scripts: [{ path: "entry.mjs", sha256: hash }], generatedScriptSha256: [], limitations: ["synthetic_test"] };
    return { process: processIdentity(pid), observation: { ...raw, sha256: recoveryRuntimeDigest(raw) } };
  };
  const common = { schemaVersion: 1, recoverySessionId: id, nonce: other, identity, candidateSessionId: other,
    runtimeManifestSha256: hash, configurationSha256: hash };
  const ready = repositoryRecoveryReadySchema.parse({ ...common, kind: "verrail.repository-recovery-runtime-ready",
    observerProcess: processIdentity(4001), verifierBuildSha256: hash, observerExecutableSha256: hash,
    old: observe(4301, -3000, -1250), observedAt: time(-1200) });
  const authorization = repositoryRecoveryAuthorizationSchema.parse({ ...common, kind: "verrail.repository-recovery-authorize",
    oldReadySha256: recoveryRuntimeDigest(ready), oldRuntimeWitnessEnvelopeSha256: hash, preRuntimeProofSha256: hash,
    beforeCheckpointSha256: hash, beforeObservedAt: time(-900), issuedAt: time(-700), expiresAt: time(29000),
    ownedCleanup: { basis: "candidate_executor_typed_output_receipt_and_signed_opencode_termination",
      outputReceiptSha256: hash, terminationEnvelopeSha256: hash, executionSessionId: "ses_actual", observerPid: 9100, nativePid: 9200,
      terminatedAt: time(-1100), checkedAt: time(-800) } });
  const stop = (pid: number, term: number, end: number) => ({ process: processIdentity(pid), requestedSignal: "SIGTERM",
    termSentAt: time(term), killSentAt: null, stoppedAt: time(end), processGroupGone: true, processReaped: true });
  const cleanup = (at: number) => ({ observerPid: 9100, nativePid: 9200, checkedAt: time(at), processGroupsGone: true,
    basis: authorization.ownedCleanup.basis, outputReceiptSha256: hash, terminationEnvelopeSha256: hash });
  const transition = repositoryRecoveryTransitionSchema.parse({ ...common, kind: "verrail.repository-recovery-runtime-transition",
    oldReadySha256: recoveryRuntimeDigest(ready), authorizationSha256: recoveryRuntimeDigest(authorization), beforeCheckpointSha256: hash,
    old: observe(4301, -3000, -650), oldStopped: stop(4301, -600, -550), ownedCleanup: cleanup(-530),
    next: observe(4302, -500, -450, other), observedAt: time(-400) });
  const completion = repositoryRecoveryCompletionAuthorizationSchema.parse({ ...common, kind: "verrail.repository-recovery-complete-authorize",
    authorizationSha256: recoveryRuntimeDigest(authorization), transitionSha256: recoveryRuntimeDigest(transition),
    probeAuthorizationSha256: hash, duplicateJournalSha256: hash, staleJournalSha256: hash,
    beforeCheckpointSha256: hash, afterCheckpointSha256: hash, afterObservedAt: time(-350), issuedAt: time(-300), expiresAt: time(29000) });
  const final = repositoryRecoveryFinalSchema.parse({ ...common, kind: "verrail.repository-recovery-runtime-final",
    oldReadySha256: recoveryRuntimeDigest(ready), authorizationSha256: recoveryRuntimeDigest(authorization),
    transitionSha256: recoveryRuntimeDigest(transition), completionAuthorizationSha256: recoveryRuntimeDigest(completion),
    beforeCheckpointSha256: hash, afterCheckpointSha256: hash, oldStopped: transition.oldStopped,
    next: observe(4302, -500, -200, other), nextStopped: stop(4302, -100, -50), ownedCleanup: cleanup(-30), observedAt: time(-10) });
  return { ready, authorization, transition, completion, final, time };
}

function probeFixture(operation: "reconcile" | "stale_heartbeat" = "reconcile") {
  const f = fixture(), keys = generateKeyPairSync("ed25519"), privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const { kind: _kind, observerProcess: _process, verifierBuildSha256: _build, observerExecutableSha256: _exe,
    old: _old, observedAt: _at, ...common } = f.ready;
  const authorization = repositoryRecoveryProbeAuthorizationSchema.parse({ ...common, kind: "verrail.repository-recovery-probe-authorize",
    authorizationSha256: f.transition.authorizationSha256, transitionSha256: recoveryRuntimeDigest(f.transition),
    beforeCheckpointSha256: hash, completionBaselineSha256: hash, staleCheckpointSha256: hash,
    olderAttempt: { runAttemptId: other, leaseId: other, fencingToken: 1, attemptNumber: 1, cursor: 3 },
    baselineObservedAt: f.time(-390), issuedAt: f.time(-380), expiresAt: f.time(29000) });
  const request = { schemaVersion: 1, kind: "verrail.repository-recovery-ipc-request", recoverySessionId: id,
    nonce: common.nonce, identity, operation, challenge: other, issuedAt: f.time(-360), expiresAt: f.time(1000),
    authorization: signRecoveryReaderEnvelope(authorization, privateKey), probe: operation === "reconcile" ? null : {
      workspaceId: id, runId: id, runAttemptId: other, idempotencyKey: `recovery-stale:${other}`,
      input: { leaseId: other, fencingToken: 1, cursor: 3, eventType: "heartbeat", emittedAt: f.time(-360).replace(/\.\d{3}Z$/, "Z") } } };
  const raw = canonicalJson(request), bytesHash = (raw: string) => createHash("sha256").update(raw).digest("hex");
  const response = canonicalJson({ schemaVersion: 1, kind: "verrail.repository-recovery-ipc-response", operation, challenge: other,
    requestSha256: bytesHash(raw), executorPid: f.transition.next.process.pid, completedAt: f.time(-350),
    result: operation === "reconcile" ? { status: "registered" } : { schemaVersion: 1, runId: id, runAttemptId: other,
      cursor: 3, eventType: "heartbeat", authoritative: false, rejectionCode: "STALE_FENCING_TOKEN",
      runStatus: "succeeded", attemptStatus: "superseded", leaseStatus: "revoked", replayed: false } });
  const before = structuredClone(f.transition.next), after = structuredClone(f.transition.next);
  for (const [value, at] of [[before, -370], [after, -330]] as const) {
    value.observation.observedAt = f.time(at); const { sha256: _hash, ...observed } = value.observation;
    value.observation.sha256 = recoveryRuntimeDigest(observed);
  }
  const journal = repositoryRecoveryProbeJournalSchema.parse({ ...common, kind: "verrail.repository-recovery-probe-journal",
    probeAuthorizationSha256: recoveryRuntimeDigest(authorization), transitionSha256: recoveryRuntimeDigest(f.transition),
    operation, executor: f.transition.next.process, before, after, request: raw, requestSha256: bytesHash(raw), requestBytes: Buffer.byteLength(raw),
    response, responseSha256: bytesHash(response), responseBytes: Buffer.byteLength(response), issuedAt: request.issuedAt, receivedAt: f.time(-340) });
  return { ...f, probeAuthorization: authorization, journal, publicKey, bytesHash };
}

it.each(["reconcile", "stale_heartbeat"] as const)("validates actual-shape %s IPC journal between same-process source checkpoints", operation => {
  const f = probeFixture(operation); validateRecoveryProbeAuthorization(f.probeAuthorization, f.ready, f.transition);
  expect(validateRecoveryProbeJournal(f.journal, f.ready, f.transition, f.probeAuthorization, f.publicKey).request.operation).toBe(operation);
});
it.each(["challenge", "executor", "request-hash", "bytes", "extra-result", "old-source", "different-birth", "early-request", "late-response", "missing-auth", "foreign-cursor"])(
  "rejects %s in a journal even when outer/request/response hashes are recomputed", failure => {
    const f = probeFixture("stale_heartbeat"), journal = structuredClone(f.journal), request = JSON.parse(journal.request), response = JSON.parse(journal.response);
    if (failure === "challenge") response.challenge = id;
    if (failure === "executor") response.executorPid++;
    if (failure === "extra-result") response.result.extra = true;
    if (failure === "old-source") journal.after.observation.manifestSha256 = "b".repeat(64);
    if (failure === "different-birth") journal.after.process.startTicks = "999";
    if (failure === "early-request") { request.issuedAt = f.time(-380); journal.issuedAt = request.issuedAt; }
    if (failure === "late-response") journal.receivedAt = f.time(2000);
    if (failure === "missing-auth") request.authorization.signature = Buffer.alloc(64).toString("base64");
    if (failure === "foreign-cursor") request.probe.input.cursor++;
    journal.request = canonicalJson(request); journal.requestSha256 = f.bytesHash(journal.request); journal.requestBytes = Buffer.byteLength(journal.request);
    response.requestSha256 = failure === "request-hash" ? "b".repeat(64) : journal.requestSha256;
    journal.response = canonicalJson(response); journal.responseSha256 = f.bytesHash(journal.response); journal.responseBytes = Buffer.byteLength(journal.response);
    if (failure === "bytes") journal.responseBytes++;
    const { sha256: _hash, ...after } = journal.after.observation; journal.after.observation.sha256 = recoveryRuntimeDigest(after);
    expect(() => validateRecoveryProbeJournal(journal, f.ready, f.transition, f.probeAuthorization, f.publicKey)).toThrow();
  });

it("uses separate strict Ed25519 reader and observer domains", () => {
  const f = fixture(), keys = generateKeyPairSync("ed25519"), privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const reader = signRecoveryReaderEnvelope(f.authorization, privateKey), observer = signRecoveryObserverEnvelope(f.ready, privateKey);
  expect(verifyRecoveryReaderEnvelope(reader, publicKey)).toEqual(f.authorization);
  expect(verifyRecoveryObserverEnvelope(observer, publicKey)).toEqual(f.ready);
  expect(() => verifyRecoveryReaderEnvelope(observer, publicKey)).toThrow();
  expect(() => verifyRecoveryObserverEnvelope(reader, publicKey)).toThrow();
  expect(() => verifyRecoveryReaderEnvelope({ ...reader, payload: Buffer.from("{}").toString("base64") }, publicKey)).toThrow();
  expect(() => verifyRecoveryReaderEnvelope(reader, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString())).toThrow();
  expect(() => signRecoveryReaderEnvelope({ ...f.authorization, arbitrary: true } as never, privateKey)).toThrow();
});

it("binds reader checkpoints, full pre-runtime hash and distinct old/new lifespans without admitting a business proof", () => {
  const f = fixture(); validateRecoveryAuthorization(f.authorization, f.ready);
  validateRecoveryTransition(f.transition, f.ready, f.authorization); validateRecoveryCompletion(f.completion, f.ready, f.transition);
  validateRecoveryFinal(f.final, f.ready, f.authorization, f.transition, f.completion);
  expect(repositoryRecoveryRuntimePaths("/private/proof", id).complete).toBe(`/private/proof/${id}-recovery.complete.json`);
  expect(() => repositoryRecoveryRuntimePaths("relative", id)).toThrow();
  expect(() => repositoryRecoveryRuntimePaths("/private/proof", "../foreign")).toThrow();
});

it.each(["nonce", "fence", "ready", "expired", "future", "long-expiry", "cleanup-pid", "cleanup-time"])("rejects reader authorization with %s drift", failure => {
  const f = fixture(), value = structuredClone(f.authorization);
  if (failure === "nonce") value.nonce = id;
  if (failure === "fence") value.identity.fencingToken++;
  if (failure === "ready") value.oldReadySha256 = "b".repeat(64);
  if (failure === "expired") value.expiresAt = f.time(-1);
  if (failure === "future") value.issuedAt = f.time(1000);
  if (failure === "long-expiry") value.expiresAt = f.time(60000);
  if (failure === "cleanup-pid") value.ownedCleanup.nativePid = f.ready.old.process.pid;
  if (failure === "cleanup-time") value.ownedCleanup.terminatedAt = f.time(1000);
  expect(() => validateRecoveryAuthorization(value, f.ready)).toThrow();
});

it.each(["same-pid", "same-birth", "new-boot", "candidate", "source", "old-start", "old-start-time", "old-checkpoint-time", "stop-before-checkpoint", "unreaped", "pre-hash", "cleanup-hash", "late-cleanup"])(
  "rejects signed-shape restart facts with %s mismatch", failure => {
    const f = fixture(), value = structuredClone(f.transition);
    if (failure === "same-pid") value.next.process.pid = value.next.observation.pid = value.next.process.pgid = value.next.process.sessionId = value.old.process.pid;
    if (failure === "same-birth") value.next.process.startTicks = value.old.process.startTicks;
    if (failure === "new-boot") value.next.process.bootId = other;
    if (failure === "candidate") value.next.observation.candidateCommit = "b".repeat(40);
    if (failure === "source") value.next.observation.manifestSha256 = "b".repeat(64);
    if (failure === "old-start") value.old.process.startTicks = "999";
    if (failure === "old-start-time") value.old.observation.startedAt = f.time(-2500);
    if (failure === "old-checkpoint-time") value.old.observation.observedAt = f.time(-1000);
    if (failure === "stop-before-checkpoint") value.oldStopped.termSentAt = f.time(-1000);
    if (failure === "unreaped") (value.oldStopped as { processReaped: boolean }).processReaped = false;
    if (failure === "pre-hash") value.authorizationSha256 = "b".repeat(64);
    if (failure === "cleanup-hash") value.ownedCleanup.outputReceiptSha256 = "b".repeat(64);
    if (failure === "late-cleanup") value.ownedCleanup.checkedAt = f.time(-100);
    const { sha256: _hash, ...observation } = value.next.observation; value.next.observation.sha256 = recoveryRuntimeDigest(observation);
    const { sha256: _oldHash, ...oldObservation } = value.old.observation; value.old.observation.sha256 = recoveryRuntimeDigest(oldObservation);
    expect(() => validateRecoveryTransition(value, f.ready, f.authorization)).toThrow();
  });

it.each(["after-hash", "early-observation", "different-process", "different-start-time", "different-authorization", "reused-old", "future-final", "late-cleanup"])(
  "rejects final closure with %s mismatch", failure => {
    const f = fixture(), value = structuredClone(f.final);
    if (failure === "after-hash") value.afterCheckpointSha256 = "b".repeat(64);
    if (failure === "early-observation") value.next.observation.observedAt = f.time(-400);
    if (failure === "different-process") value.next.process.startTicks = "999";
    if (failure === "different-start-time") value.next.observation.startedAt = f.time(-480);
    if (failure === "different-authorization") value.completionAuthorizationSha256 = "b".repeat(64);
    if (failure === "reused-old") value.nextStopped.process = value.oldStopped.process;
    if (failure === "future-final") value.observedAt = f.time(1000);
    if (failure === "late-cleanup") value.ownedCleanup.checkedAt = f.time(1000);
    const { sha256: _hash, ...observation } = value.next.observation; value.next.observation.sha256 = recoveryRuntimeDigest(observation);
    expect(() => validateRecoveryFinal(value, f.ready, f.authorization, f.transition, f.completion)).toThrow();
  });

it.each(["authorization-window", "completion-window", "completion-before-issue"])("rejects historical %s even with recomputed chain hashes", failure => {
  const f = fixture();
  if (failure === "authorization-window") f.authorization.expiresAt = f.time(60000);
  if (failure === "completion-window") f.completion.expiresAt = f.time(60000);
  if (failure === "completion-before-issue") f.completion.afterObservedAt = f.time(-250);
  f.transition.authorizationSha256 = recoveryRuntimeDigest(f.authorization);
  f.completion.authorizationSha256 = f.transition.authorizationSha256;
  f.completion.transitionSha256 = recoveryRuntimeDigest(f.transition);
  f.final.authorizationSha256 = f.transition.authorizationSha256;
  f.final.transitionSha256 = f.completion.transitionSha256;
  f.final.completionAuthorizationSha256 = recoveryRuntimeDigest(f.completion);
  expect(() => validateRecoveryFinal(f.final, f.ready, f.authorization, f.transition, f.completion)).toThrow();
});

it("parses Linux process birth identity without trusting a reusable PID or command-name parentheses", () => {
  const fields = ["S", "1", "4301", "4301", ...Array(15).fill("0"), "1234567", "0"];
  expect(parseLinuxProcessIdentity(`4301 (node (fixture)) ${fields.join(" ")}\n`, `${id}\n`)).toEqual(processIdentity(4301, "1234567"));
  expect(() => parseLinuxProcessIdentity("4301 broken", id)).toThrow();
  expect(() => parseLinuxProcessIdentity(`4301 (node) ${fields.join(" ")}`, "not-a-boot-id")).toThrow();
});

it.each(["term", "kill", "wrong-birth-before-term", "wrong-boot-before-kill", "no-reap", "group-survives"])(
  "verifies every stop signal and both actual cleanup conditions: %s", async mode => {
    const process = processIdentity(4301), child = { pid: 4301, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
    let clock = Date.now(), alive = true, reads = 0; const signals: string[] = [];
    const dependencies = { now: () => clock, sleep: async (ms: number) => { clock += ms; }, groupExists: () => alive,
      readIdentity: async () => { reads++; return { ...process,
        ...(mode === "wrong-birth-before-term" ? { startTicks: "999" } : {}),
        ...(mode === "wrong-boot-before-kill" && reads === 2 ? { bootId: other } : {}) }; },
      signal: (_pid: number, signal: "SIGTERM" | "SIGKILL") => {
        signals.push(signal);
        if (mode === "term" || signal === "SIGKILL") {
          if (mode !== "group-survives") alive = false;
          if (mode !== "no-reap") child.signalCode = signal;
        }
        return true;
      } };
    if (mode === "term" || mode === "kill") {
      const value = await stopRecoveryOwnedNode(child, process, dependencies);
      expect(value.processGroupGone && value.processReaped).toBe(true);
      expect(signals).toEqual(mode === "term" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
    } else {
      await expect(stopRecoveryOwnedNode(child, process, dependencies)).rejects.toThrow();
      if (mode === "wrong-birth-before-term") expect(signals).toEqual([]);
      if (mode === "wrong-boot-before-kill") expect(signals).toEqual(["SIGTERM"]);
    }
  });
