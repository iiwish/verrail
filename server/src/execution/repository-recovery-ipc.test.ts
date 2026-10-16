import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { createRecoveryIpcHandler, loadRecoveryIpcConfiguration, recoveryIpcConfigurationSchema, validateRecoveryIpcParent,
  waitForRecoveryAbort, installRecoveryIpc } from "./repository-recovery-ipc.js";
import { repositoryRecoveryProbeAuthorizationSchema, repositoryRecoveryIpcRequestSchema, repositoryRecoveryIpcResponseSchema,
  recoveryRuntimeDigest, signRecoveryReaderEnvelope, validateRecoveryIpcConfigurationBinding,
  type RepositoryRecoveryIpcRequest } from "../services/repository-recovery-runtime-observation.js";

const id = "11111111-1111-4111-8111-111111111111", oldId = "22222222-2222-4222-8222-222222222222", hash = "a".repeat(64);
function fixture() {
  const keys = generateKeyPairSync("ed25519"), privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const identity = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id,
    runId: id, runAttemptId: id, leaseId: id, fencingToken: 2, agentVersionId: id, deploymentRevisionId: id };
  const config = recoveryIpcConfigurationSchema.parse({ schemaVersion: 1, kind: "verrail.repository-recovery-ipc-config",
    recoverySessionId: id, identity, observerExecutable: "/private/node", observerExecutableSha256: hash,
    observerEntrypoint: "/private/observer.mjs", observerEntrypointSha256: hash,
    readerPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    readerPublicKeySha256: createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex") });
  const now = Date.now(), authorization = repositoryRecoveryProbeAuthorizationSchema.parse({ schemaVersion: 1,
    kind: "verrail.repository-recovery-probe-authorize", recoverySessionId: id, nonce: oldId, identity,
    candidateSessionId: oldId, runtimeManifestSha256: hash, configurationSha256: hash, authorizationSha256: hash,
    transitionSha256: hash, beforeCheckpointSha256: hash, completionBaselineSha256: hash, staleCheckpointSha256: hash,
    olderAttempt: { runAttemptId: oldId, leaseId: oldId, fencingToken: 1, attemptNumber: 1, cursor: 3 },
    baselineObservedAt: new Date(now - 2000).toISOString(), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 20000).toISOString() });
  const request = (operation: "reconcile" | "stale_heartbeat", duration = 5000) => {
    const issuedAt = new Date().toISOString(), challenge = randomUUID();
    return repositoryRecoveryIpcRequestSchema.parse({ schemaVersion: 1, kind: "verrail.repository-recovery-ipc-request",
      recoverySessionId: id, nonce: oldId, identity, operation, challenge, authorization: signRecoveryReaderEnvelope(authorization, privateKey),
      issuedAt, expiresAt: new Date(Date.now() + duration).toISOString(),
      probe: operation === "reconcile" ? null : { workspaceId: id, runId: id, runAttemptId: oldId, idempotencyKey: `recovery-stale:${challenge}`,
        input: { leaseId: oldId, fencingToken: 1, cursor: 3, eventType: "heartbeat", emittedAt: issuedAt.replace(/\.\d{3}Z$/, "Z") } } });
  };
  const execute = vi.fn<(request: RepositoryRecoveryIpcRequest, signal: AbortSignal) => Promise<unknown>>(async request => request.operation === "reconcile" ? { status: "registered" } : {
    schemaVersion: 1, runId: id, runAttemptId: oldId, cursor: 3, eventType: "heartbeat", authoritative: false,
    rejectionCode: "STALE_FENCING_TOKEN", runStatus: "succeeded", attemptStatus: "superseded", leaseStatus: "revoked", replayed: false });
  const controller = new AbortController(), send = vi.fn(async (_raw: string) => {}), fail = vi.fn(() => controller.abort());
  const handler = createRecoveryIpcHandler({ config, signal: controller.signal, executorPid: 4301, execute, send, fail });
  return { config, authorization, privateKey, request, execute, send, fail, handler, controller };
}

it("is off by default and rejects a partial or unconnected opt-in", async () => {
  expect(await loadRecoveryIpcConfiguration({})).toBeNull();
  await expect(loadRecoveryIpcConfiguration({ VERRAIL_RECOVERY_IPC_FILE: "/not-opened", VERRAIL_RECOVERY_IPC_SHA256: hash })).rejects.toThrow();
});
it("does not install a handler after the inherited IPC parent has disconnected", () => {
  const controller = new AbortController();
  const descriptor = Object.getOwnPropertyDescriptor(process, "connected");
  Object.defineProperty(process, "connected", { value: false, configurable: true });
  try {
    expect(() => installRecoveryIpc({ controller } as never)).toThrow();
    expect(controller.signal.aborted).toBe(true);
  } finally { if (descriptor) Object.defineProperty(process, "connected", descriptor); else Reflect.deleteProperty(process, "connected"); }
});
it.each(["controller", "execution"])("releases the terminal hold when only the %s signal aborts and removes listeners", async which => {
  const controller = new AbortController(), execution = new AbortController();
  const first = vi.spyOn(controller.signal, "removeEventListener"), second = vi.spyOn(execution.signal, "removeEventListener");
  const waiting = waitForRecoveryAbort(controller.signal, execution.signal);
  (which === "controller" ? controller : execution).abort(); await waiting;
  expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  expect((which === "controller" ? execution : controller).signal.aborted).toBe(false);
});
it.each(["valid", "platform", "disconnected", "executable", "binary", "argv", "entry", "key"])("pins the actual launch parent: %s", mode => {
  const f = fixture(), facts = { platform: "linux", connected: true, executable: f.config.observerExecutable,
    executableSha256: hash, argv: [f.config.observerExecutable, f.config.observerEntrypoint], entrypointSha256: hash };
  if (mode === "platform") facts.platform = "darwin";
  if (mode === "disconnected") facts.connected = false;
  if (mode === "executable") facts.executable = "/foreign/node";
  if (mode === "binary") facts.executableSha256 = "b".repeat(64);
  if (mode === "argv") facts.argv.push("--eval=foreign");
  if (mode === "entry") facts.entrypointSha256 = "b".repeat(64);
  if (mode === "key") f.config.readerPublicKeySha256 = "b".repeat(64);
  if (mode === "valid") expect(() => validateRecoveryIpcParent(f.config, facts)).not.toThrow();
  else expect(() => validateRecoveryIpcParent(f.config, facts)).toThrow();
});
it.each(["valid", "hash", "session", "identity", "reader", "binary", "entry"])("checks private IPC configuration before launching any candidate: %s", mode => {
  const f = fixture(), config = { recoverySessionId: f.config.recoverySessionId, identity: structuredClone(f.config.identity),
    readerPublicKey: f.config.readerPublicKey, readerPublicKeySha256: f.config.readerPublicKeySha256,
    observerExecutableSha256: f.config.observerExecutableSha256, verifierBuildSha256: f.config.observerEntrypointSha256 };
  const actual = { configurationSha256: recoveryRuntimeDigest(f.config), executable: f.config.observerExecutable, entrypoint: f.config.observerEntrypoint };
  if (mode === "hash") actual.configurationSha256 = "b".repeat(64);
  if (mode === "session") config.recoverySessionId = oldId;
  if (mode === "identity") config.identity.runAttemptId = oldId;
  if (mode === "reader") config.readerPublicKeySha256 = "b".repeat(64);
  if (mode === "binary") config.observerExecutableSha256 = "b".repeat(64);
  if (mode === "entry") actual.entrypoint = "/foreign/observer.mjs";
  if (mode === "valid") expect(() => validateRecoveryIpcConfigurationBinding(f.config, config, actual)).not.toThrow();
  else expect(() => validateRecoveryIpcConfigurationBinding(f.config, config, actual)).toThrow();
});
it("runs only the two ordered fixed operations and returns canonical correlated IPC bytes", async () => {
  const f = fixture();
  for (const operation of ["reconcile", "stale_heartbeat"] as const) {
    const request = f.request(operation), raw = canonicalJson(request); await f.handler(raw);
    const response = repositoryRecoveryIpcResponseSchema.parse(JSON.parse(f.send.mock.lastCall![0]));
    expect(response).toMatchObject({ operation, challenge: request.challenge, executorPid: 4301, requestSha256: recoveryRuntimeDigest(request) });
    expect(canonicalJson(response)).toBe(f.send.mock.lastCall![0]);
  }
  expect(f.execute).toHaveBeenCalledTimes(2); expect(f.fail).not.toHaveBeenCalled();
});
it.each(["object", "oversize", "extra", "foreign-identity", "foreign-session", "signature", "expired", "long-expiry", "stale-first", "nonce", "foreign-cursor"])(
  "rejects %s before invoking an operation", async mode => {
    const f = fixture(), request = f.request(mode === "stale-first" || mode === "foreign-cursor" ? "stale_heartbeat" : "reconcile");
    if (mode === "foreign-identity") request.identity.workspaceId = oldId;
    if (mode === "foreign-session") request.recoverySessionId = oldId;
    if (mode === "signature") request.authorization.signature = Buffer.alloc(64).toString("base64");
    if (mode === "expired") request.expiresAt = new Date(Date.now() - 1).toISOString();
    if (mode === "long-expiry") request.expiresAt = new Date(Date.now() + 11000).toISOString();
    if (mode === "nonce") request.nonce = id;
    if (mode === "foreign-cursor" && request.operation === "stale_heartbeat") request.probe.input.cursor++;
    const raw: unknown = mode === "extra" ? { ...request, command: "arbitrary" } : request;
    await f.handler(mode === "object" ? request : mode === "oversize" ? "x".repeat(8193) : canonicalJson(raw));
    expect(f.execute).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.fail).toHaveBeenCalledOnce();
  });
it("rejects duplicate operations and challenge reuse instead of replaying them", async () => {
  const f = fixture(), first = f.request("reconcile"); await f.handler(canonicalJson(first));
  await f.handler(canonicalJson(first)); expect(f.execute).toHaveBeenCalledOnce(); expect(f.fail).toHaveBeenCalledOnce();
  const g = fixture(), request = g.request("reconcile"); await g.handler(canonicalJson(request));
  const second = g.request("stale_heartbeat"); second.challenge = request.challenge;
  second.probe!.idempotencyKey = `recovery-stale:${request.challenge}`;
  await g.handler(canonicalJson(second)); expect(g.execute).toHaveBeenCalledOnce(); expect(g.fail).toHaveBeenCalledOnce();
});
it("fails closed on a concurrent request and aborts the pending operation", async () => {
  const f = fixture(); f.execute.mockImplementation(async () => new Promise(() => {}));
  const first = f.handler(canonicalJson(f.request("reconcile")));
  await f.handler(canonicalJson(f.request("stale_heartbeat"))); await first;
  expect(f.execute).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled(); expect(f.controller.signal.aborted).toBe(true);
});
it.each(["execution", "send"])("bounds an unresponsive %s and never reports completion", async stage => {
  const f = fixture();
  if (stage === "execution") f.execute.mockImplementation(async () => new Promise(() => {}));
  else f.send.mockImplementation(async () => new Promise<void>(() => {}));
  await f.handler(canonicalJson(f.request("reconcile", 50)));
  expect(f.fail).toHaveBeenCalledOnce(); expect(f.controller.signal.aborted).toBe(true);
});
it("does not turn an inactive reconcile or authoritative old-fence response into a successful journal response", async () => {
  const f = fixture(); f.execute.mockResolvedValue({ status: "inactive" } as never);
  await f.handler(canonicalJson(f.request("reconcile"))); expect(f.send).not.toHaveBeenCalled(); expect(f.fail).toHaveBeenCalledOnce();
  const g = fixture(); await g.handler(canonicalJson(g.request("reconcile")));
  g.execute.mockResolvedValue({ authoritative: true } as never); await g.handler(canonicalJson(g.request("stale_heartbeat")));
  expect(g.send).toHaveBeenCalledOnce(); expect(g.fail).toHaveBeenCalledOnce();
});
