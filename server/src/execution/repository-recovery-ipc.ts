import { createHash, createPublicKey } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, verrailRepositoryDispatches, verrailRunAttempts, verrailRuns, verrailExecutionLeases } from "@paperclipai/db";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { readPrivateProofJson } from "../services/delivery-proof-observation.js";
import { openCodeCandidateIdentitySchema } from "../services/opencode-runtime-observation.js";
import { recoveryRuntimeDigest, repositoryRecoveryProbeAuthorizationSchema, repositoryRecoveryIpcRequestSchema,
  repositoryRecoveryIpcResponseSchema, verifyRecoveryReaderEnvelope, validateRecoveryIpcRequest,
  recoveryIpcConfigurationSchema, type RecoveryIpcConfiguration, type RepositoryRecoveryIpcRequest } from "../services/repository-recovery-runtime-observation.js";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { reconcileRepositoryCompletion } from "./repository-reconciliation.js";
import { validateRepositoryResult } from "./repository-result.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export { recoveryIpcConfigurationSchema, type RecoveryIpcConfiguration };
const unavailable = () => new Error("REPOSITORY_RECOVERY_IPC_UNAVAILABLE");
const bytesHash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export function validateRecoveryIpcParent(config: RecoveryIpcConfiguration, facts: {
  platform: string; connected: boolean; executable: string; executableSha256: string; argv: string[]; entrypointSha256: string;
}) {
  recoveryIpcConfigurationSchema.parse(config);
  const key = createPublicKey(config.readerPublicKey);
  if (facts.platform !== "linux" || !facts.connected || key.asymmetricKeyType !== "ed25519"
    || bytesHash(key.export({ type: "spki", format: "der" })) !== config.readerPublicKeySha256
    || facts.executable !== config.observerExecutable || facts.executableSha256 !== config.observerExecutableSha256
    || canonicalJson(facts.argv) !== canonicalJson([config.observerExecutable, config.observerEntrypoint])
    || facts.entrypointSha256 !== config.observerEntrypointSha256) throw unavailable();
}
export async function loadRecoveryIpcConfiguration(env: NodeJS.ProcessEnv = process.env): Promise<RecoveryIpcConfiguration | null> {
  const file = env.VERRAIL_RECOVERY_IPC_FILE, expected = env.VERRAIL_RECOVERY_IPC_SHA256;
  if (!file && !expected) return null;
  if (!file || !expected || !path.isAbsolute(file) || !process.connected || !process.send || process.platform !== "linux") throw unavailable();
  hash.parse(expected);
  const config = recoveryIpcConfigurationSchema.parse(await readPrivateProofJson(file));
  if (recoveryRuntimeDigest(config) !== expected || await realpath(path.dirname(file)) !== path.dirname(file)) throw unavailable();
  const executable = await realpath(`/proc/${process.ppid}/exe`);
  if (await realpath(config.observerEntrypoint) !== config.observerEntrypoint || (await stat(config.observerEntrypoint)).size > 16 * 1024 * 1024
    || (await stat(executable)).size > 512 * 1024 * 1024) throw unavailable();
  const command = await readFile(`/proc/${process.ppid}/cmdline`);
  if (command.length > 8192 || command.at(-1) !== 0) throw unavailable();
  validateRecoveryIpcParent(config, { platform: process.platform, connected: process.connected,
    executable, executableSha256: bytesHash(await readFile(executable)), argv: command.toString("utf8").slice(0, -1).split("\0"),
    entrypointSha256: bytesHash(await readFile(config.observerEntrypoint)) });
  return config;
}

type Identity = z.infer<typeof openCodeCandidateIdentitySchema>;
const sameIdentity = (request: RepositoryExecutionRequest, identity: Identity) => {
  if (canonicalJson(openCodeCandidateIdentitySchema.parse(Object.fromEntries(Object.keys(identity).map(key =>
    [key, request[key as keyof RepositoryExecutionRequest]])))) !== canonicalJson(identity)) throw unavailable();
};
export async function readRecoveryCurrentState(db: Db, identity: Identity, signal: AbortSignal) {
  signal.throwIfAborted();
  const [row] = await db.select({ run: verrailRuns, attempt: verrailRunAttempts, lease: verrailExecutionLeases, dispatch: verrailRepositoryDispatches })
    .from(verrailRunAttempts)
    .innerJoin(verrailRuns, and(eq(verrailRuns.id, verrailRunAttempts.runId), eq(verrailRuns.workspaceId, verrailRunAttempts.workspaceId)))
    .innerJoin(verrailExecutionLeases, and(eq(verrailExecutionLeases.runAttemptId, verrailRunAttempts.id), eq(verrailExecutionLeases.workspaceId, verrailRunAttempts.workspaceId)))
    .leftJoin(verrailRepositoryDispatches, and(eq(verrailRepositoryDispatches.runAttemptId, verrailRunAttempts.id), eq(verrailRepositoryDispatches.workspaceId, verrailRunAttempts.workspaceId)))
    .where(and(eq(verrailRunAttempts.id, identity.runAttemptId), eq(verrailRunAttempts.workspaceId, identity.workspaceId),
      eq(verrailRuns.id, identity.runId), eq(verrailRuns.targetId, identity.targetId), eq(verrailRuns.targetRevisionId, identity.targetRevisionId),
      eq(verrailRuns.graphRevisionId, identity.graphRevisionId), eq(verrailRuns.workNodeId, identity.workNodeId),
      eq(verrailRuns.agentVersionId, identity.agentVersionId), eq(verrailRuns.deploymentRevisionId, identity.deploymentRevisionId),
      eq(verrailRunAttempts.agentVersionId, identity.agentVersionId), eq(verrailRunAttempts.deploymentRevisionId, identity.deploymentRevisionId),
      eq(verrailRunAttempts.fencingToken, identity.fencingToken), eq(verrailExecutionLeases.id, identity.leaseId),
      eq(verrailExecutionLeases.fencingToken, identity.fencingToken))).limit(1);
  signal.throwIfAborted();
  if (!row || row.run.attemptCount !== row.attempt.attemptNumber || row.run.kind !== "agent"
    || row.attempt.runtimeProfile !== "repository_sandbox" || row.attempt.executorPrincipalType !== "service"
    || row.attempt.executorPrincipalId !== "verrail-repository-runner" || row.lease.executorPrincipalId !== "verrail-repository-runner") throw unavailable();
  if (!row.dispatch) {
    if (row.lease.status !== "offered" || row.run.status !== "queued" || row.attempt.status !== "pending") throw unavailable();
    return { status: "offered" as const, row };
  }
  if (row.dispatch.status !== "succeeded") throw unavailable();
  const request = repositoryExecutionRequestSchema.parse(row.dispatch.input); sameIdentity(request, identity);
  if (bytesHash(JSON.stringify(request)) !== row.dispatch.requestHash) throw unavailable();
  const result = validateRepositoryResult(row.dispatch.result, request);
  if (row.run.status === "running" && row.attempt.status === "running" && row.lease.status === "active") {
    return { status: "durable" as const, row, request, result };
  }
  if (row.run.status !== "succeeded" || row.attempt.status !== "succeeded" || row.lease.status !== "released"
    || canonicalJson(validateRepositoryResult(row.attempt.result?.repositoryOutput, request)) !== canonicalJson(result)) throw unavailable();
  return { status: "registered" as const, row, request, result };
}

export async function runRecoveryIpcOperation(options: { db: Db; domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
  request: RepositoryRecoveryIpcRequest; signal: AbortSignal }): Promise<unknown> {
  const { request, signal } = options, state = await readRecoveryCurrentState(options.db, request.identity, signal);
  if (state.status !== "registered") throw unavailable();
  if (request.operation === "reconcile") {
    return reconcileRepositoryCompletion({ db: options.db, domainApi: options.domainApi,
      workspaceId: request.identity.workspaceId, runAttemptId: request.identity.runAttemptId, signal }, "succeeded");
  }
  const { probe } = request;
  const [old] = await options.db.select({ attempt: verrailRunAttempts, lease: verrailExecutionLeases }).from(verrailRunAttempts)
    .innerJoin(verrailExecutionLeases, and(eq(verrailExecutionLeases.runAttemptId, verrailRunAttempts.id), eq(verrailExecutionLeases.workspaceId, verrailRunAttempts.workspaceId)))
    .where(and(eq(verrailRunAttempts.id, probe.runAttemptId), eq(verrailRunAttempts.workspaceId, probe.workspaceId),
      eq(verrailRunAttempts.runId, probe.runId), eq(verrailExecutionLeases.id, probe.input.leaseId))).limit(1);
  const authorization = repositoryRecoveryProbeAuthorizationSchema.parse(JSON.parse(Buffer.from(request.authorization.payload, "base64").toString("utf8")));
  if (!old || old.attempt.attemptNumber !== authorization.olderAttempt.attemptNumber || old.attempt.attemptNumber >= state.row.attempt.attemptNumber
    || old.attempt.fencingToken !== probe.input.fencingToken || old.lease.fencingToken !== probe.input.fencingToken
    || old.attempt.lastEventCursor + 1 !== probe.input.cursor || !["failed", "superseded"].includes(old.attempt.status)
    || !["expired", "revoked"].includes(old.lease.status) || !old.attempt.startedAt || !old.attempt.finishedAt || !old.lease.releasedAt
    || old.attempt.agentVersionId !== request.identity.agentVersionId || old.attempt.deploymentRevisionId !== request.identity.deploymentRevisionId
    || old.attempt.executorPrincipalType !== "service" || old.attempt.executorPrincipalId !== "verrail-repository-runner"
    || old.attempt.runtimeProfile !== "repository_sandbox" || old.lease.runtimeProfile !== "repository_sandbox"
    || old.lease.executorPrincipalId !== "verrail-repository-runner") throw unavailable();
  signal.throwIfAborted();
  // Preserve Go's exact payload-free field order for the independent receipt hash.
  return options.domainApi.reportRunEvent({ workspaceId: probe.workspaceId, runId: probe.runId, runAttemptId: probe.runAttemptId,
    principalType: "service", principalId: "verrail-repository-runner", idempotencyKey: probe.idempotencyKey, signal,
    input: { leaseId: probe.input.leaseId, fencingToken: probe.input.fencingToken, cursor: probe.input.cursor,
      eventType: "heartbeat", emittedAt: probe.input.emittedAt } });
}

export function createRecoveryIpcHandler(options: { config: RecoveryIpcConfiguration; signal: AbortSignal; executorPid: number;
  execute: (request: RepositoryRecoveryIpcRequest, signal: AbortSignal) => Promise<unknown>; send: (raw: string) => Promise<void>; fail: () => void }) {
  let active = false, failed = false;
  const operations = new Set<string>(), challenges = new Set<string>();
  async function bounded<T>(work: () => Promise<T>, signal: AbortSignal) {
    signal.throwIfAborted();
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(unavailable()); signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try { return await Promise.race([work(), aborted]); }
    finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
  }
  return async (raw: unknown) => {
    try {
      if (failed || active || options.signal.aborted || typeof raw !== "string" || Buffer.byteLength(raw) > 8192) throw unavailable();
      const request = repositoryRecoveryIpcRequestSchema.parse(JSON.parse(raw));
      if (canonicalJson(request) !== raw) throw unavailable();
      const authorization = repositoryRecoveryProbeAuthorizationSchema.parse(verifyRecoveryReaderEnvelope(request.authorization, options.config.readerPublicKey));
      validateRecoveryIpcRequest(request, authorization);
      if (request.recoverySessionId !== options.config.recoverySessionId || canonicalJson(request.identity) !== canonicalJson(options.config.identity)
        || operations.has(request.operation) || challenges.has(request.challenge) || operations.size >= 2
        || (request.operation === "stale_heartbeat" && !operations.has("reconcile"))) throw unavailable();
      active = true; operations.add(request.operation); challenges.add(request.challenge);
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Date.parse(request.expiresAt) - Date.now()))]);
      const result = await bounded(() => options.execute(request, signal), signal); signal.throwIfAborted();
      const response = repositoryRecoveryIpcResponseSchema.parse({ schemaVersion: 1, kind: "verrail.repository-recovery-ipc-response",
        operation: request.operation, challenge: request.challenge, requestSha256: bytesHash(raw), executorPid: options.executorPid,
        completedAt: new Date().toISOString(), result });
      const bytes = canonicalJson(response); if (Buffer.byteLength(bytes) > 8192) throw unavailable();
      await bounded(() => options.send(bytes), signal); signal.throwIfAborted();
    } catch { failed = true; options.fail(); }
    finally { active = false; }
  };
}

export function waitForRecoveryAbort(...signals: AbortSignal[]) {
  return new Promise<void>(resolve => {
    const done = () => { for (const signal of signals) signal.removeEventListener("abort", done); resolve(); };
    if (signals.some(signal => signal.aborted)) return done();
    for (const signal of signals) signal.addEventListener("abort", done, { once: true });
  });
}

export function installRecoveryIpc(options: { config: RecoveryIpcConfiguration; db: Db;
  domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">; controller: AbortController }) {
  if (!process.connected || !process.send) { options.controller.abort(unavailable()); throw unavailable(); }
  const { signal } = options.controller;
  const receive = createRecoveryIpcHandler({ config: options.config, signal, executorPid: process.pid,
    execute: (request, currentSignal) => runRecoveryIpcOperation({ ...options, request, signal: currentSignal }),
    send: raw => new Promise<void>((resolve, reject) => process.send!(raw, error => error ? reject(error) : resolve())),
    fail: () => options.controller.abort(unavailable()) });
  const listener = (raw: unknown) => { void receive(raw); };
  const disconnected = () => options.controller.abort(unavailable());
  process.on("message", listener);
  process.once("disconnect", disconnected);
  const waitForAbort = () => waitForRecoveryAbort(signal);
  return {
    close: () => { process.removeListener("message", listener); process.removeListener("disconnect", disconnected); }, waitForAbort,
    beforeTerminalReport: async (request: RepositoryExecutionRequest, result: unknown, currentSignal: AbortSignal) => {
      sameIdentity(request, options.config.identity);
      const state = await readRecoveryCurrentState(options.db, options.config.identity, currentSignal);
      if (state.status !== "durable" || canonicalJson(state.result) !== canonicalJson(result)) throw unavailable();
      await waitForRecoveryAbort(signal, currentSignal); currentSignal.throwIfAborted(); throw unavailable();
    },
  };
}
