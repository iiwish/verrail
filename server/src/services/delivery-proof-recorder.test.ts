import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { repositoryExecutionRequestSchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { recordDeliveryProof, type DeliveryProofRecorderConfig } from "./delivery-proof-recorder.js";
import { parseGitHubCiPolicies } from "./github-ci-proof-policy.js";
import { deliveryObservationHash } from "./delivery-proof-observation.js";
import { projectOpenCodeRuntimeProof } from "./opencode-runtime-proof-projection.js";
import { loadOpenCodeExecutionProofContext } from "./opencode-execution-proof-context.js";
import { syntheticCandidateWitnesses } from "../__tests__/helpers/opencode-candidate-witness.js";
import { repositoryObservationFixture, observationFixtureId as id, observationFixtureHash as hash } from "../__tests__/helpers/repository-execution-observation.js";
import { persistRepositoryExecutionObservation } from "../execution/repository-execution-observation.js";
import { repositoryRequestSha256 } from "../execution/repository-output-receipt.js";
import { repositoryRecoveryProofSchema } from "./repository-recovery-proof-projection.js";

const mocked = vi.hoisted(() => ({ authority: vi.fn(), closed: vi.fn(), recovery: vi.fn(), legacy: vi.fn(), source: vi.fn(), ci: vi.fn(), mapping: vi.fn(), get: vi.fn() }));
vi.mock("./delivery-proof-reader-access.js", () => ({ assertDeliveryProofReader: mocked.authority }));
vi.mock("./opencode-delivery-proof-context.js", () => ({ loadOpenCodeDeliveryProofContext: mocked.closed }));
vi.mock("./repository-recovery-delivery-proof-context.js", () => ({ loadRepositoryRecoveryDeliveryProofContext: mocked.recovery }));
vi.mock("./github-ci-source-context.js", () => ({ loadCodexDeliverySourceContext: mocked.legacy, loadFeishuDeliverySourceContext: mocked.legacy }));
vi.mock("./github-ci-repository-source-context.js", () => ({ loadRepositoryCiSourceContext: mocked.source }));
vi.mock("./github-ci-proof-reader.js", () => ({ createGitHubCiProofReader: () => ({ read: mocked.ci }) }));
vi.mock("./github-ci-proof-adapters.js", () => ({ createGitHubCiReadDependencies: () => ({ get: mocked.get }) }));
vi.mock("./github-ci-source-mapping.js", () => ({ mapGitHubCiSource: mocked.mapping }));
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function database(rows: unknown[]) {
  const query = { from: () => query, innerJoin: () => query, where: () => query, limit: async () => rows };
  const tx = { select: () => query };
  return { ...tx, transaction: async (fn: (value: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "verrail-closed-proof-")); roots.push(directory); await chmod(directory, 0o700);
  const sha = "a".repeat(64), commit = "b".repeat(40), origin = "http://127.0.0.1:54321";
  const entry = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, connectionId: id, bindingId: id, authorizedUserIds: ["fixture-user"],
    policy: { repository: "fixture/repository", repositoryId: 1, workflowId: 2,
      workflow: { path: ".github/workflows/verrail-candidate-verify.yml", sha: commit, sha256: sha },
      helper: { path: ".github/scripts/verrail-candidate-proof.mjs", sha256: sha },
      requiredJobs: [{ name: "candidate_verify", steps: ["checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install", "proof_tests", "ts_tests", "ts_typecheck", "ts_build", "go_tests", "source_unchanged", "capture_results"] },
        { name: "candidate_report", steps: ["checkout", "setup_node", "report", "upload"] }], artifactDownloadHosts: ["results.example.invalid"],
      maxAgeMs: 60000, timeoutMs: 1000, maxPages: 2, maxResponseBytes: 100000, maxArchiveBytes: 100000, maxReportBytes: 10000 } };
  const policy = JSON.stringify([entry]), normalized = parseGitHubCiPolicies(policy)[0]!;
  const manifest = { schemaVersion: 1 as const, kind: "verrail.opencode-runtime-manifest" as const, candidateCommit: commit,
    apiOriginSha256: sha, domainOriginSha256: hash(origin), observerExecutableSha256: sha,
    components: (["server", "domain", "repository_executor", "opencode"] as const).map(component => ({ component,
      configurationSha256: sha, verifierBuildSha256: sha, executableSha256: sha,
      sourceManifestSha256: ["server", "repository_executor"].includes(component) ? sha : null })) };
  const manifestSha256 = deliveryObservationHash(manifest), runtime = syntheticCandidateWitnesses(1, manifestSha256);
  const vector = JSON.parse(await readFile(new URL("../../../services/domain-api/internal/target/testdata/repository-source-collector-v1.json", import.meta.url), "utf8"));
  const request = repositoryExecutionRequestSchema.parse(vector.request), observation = repositoryObservationFixture(request);
  const native = runtime.witnesses.find(item => item.component === "opencode")!;
  Object.assign(observation.execution.facts, { candidateRuntime: { kind: "verrail.opencode-session-bound", nativePid: native.observation.pid,
    observerPid: native.observerPid, sessionId: id, manifestSha256, executionIdentitySha256: deliveryObservationHash(native.executionIdentity), httpSession: native.httpSession } });
  const ref = await persistRepositoryExecutionObservation(observation);
  const receipt = vector.result.outputReceipt;
  receipt.executionObservation = ref; receipt.executionFacts = { ...observation.expected, cleanup: { ...observation.expected.cleanup, checkout: true },
    requestSha256: repositoryRequestSha256(request), exitCode: 0 }; receipt.finalizedAt = new Date().toISOString();
  const { sha256: _, ...unsignedReceipt } = receipt; receipt.sha256 = hash(canonicalJson(unsignedReceipt));
  const source = { criterionKey: "execution", source: { runId: id, runAttemptId: id, runEventId: id,
    runEventContentHash: sha, outputReceiptSha256: receipt.sha256, artifactOrdinal: 0 },
    snapshot: { sourceSnapshotTreeSha: receipt.artifacts[0].sourceSnapshot.snapshotTree, sourceContentSha256: receipt.artifacts[0].sourceSnapshot.sourceContentSha256 }, contextSha256: sha };
  mocked.source.mockResolvedValue(source);
  const storage = { getObject: vi.fn(async (_workspace: string, key: string) => {
    const body = observation.objects.get(key); if (!body) throw new Error("Not found");
    return { stream: Readable.from([body]), contentLength: body.length };
  }) };
  const selection = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, claimId: id,
    workNodeId: id, artifactRevisionId: id, requirementId: "opencode-proof", runId: id, runAttemptId: id };
  const closed = await loadOpenCodeExecutionProofContext(database([{ input: request, result: vector.result,
    requestHash: repositoryRequestSha256(request), leaseId: id, fencingToken: 2, finishedAt: new Date(), errorCode: null }]), selection,
  { storage, repository: { repository: entry.policy.repository, connectionId: id, bindingId: id } });
  mocked.closed.mockResolvedValue({ source, execution: closed.execution, runtime: projectOpenCodeRuntimeProof(runtime) });
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  const trust = { schemaVersion: 1 as const, ci: { schemaVersion: 1 as const, workspaceId: id, targetId: id, targetRevisionId: id,
    graphRevisionId: id, connectionId: id, bindingId: id, repository: entry.policy.repository, repositoryId: 1, workflowId: 2,
    workflowExecutionSha: commit, workflowSha256: sha, helperSha256: sha,
    policySha256: hash(JSON.stringify(normalized)), maxAgeMs: 60000 }, publicKey, readerPolicySha256: sha, verifierBuildSha256: sha,
    runtimeManifestSha256: manifestSha256, maxAgeMs: 60000 };
  const config: DeliveryProofRecorderConfig = { trust, privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    domainOrigin: origin, githubPolicy: policy, githubAuthorization: "Bearer synthetic-only", runtime: { directory,
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), sessionId: id, manifest, manifestSha256 } };
  const input = { kind: "opencode_execution" as const, idempotencyKey: "fixture-closed-proof", execution: { runId: id, runAttemptId: id },
    ci: { runId: "123", runAttempt: 1, claimId: id, workNodeId: id, artifactRevisionId: id, requirementId: "opencode-proof" } };
  mocked.authority.mockResolvedValue({ policySha256: sha });
  const ciReceipt = { kind: "verrail.fixed-ci-observation", schemaVersion: 1, repository: entry.policy.repository,
    repositoryId: 1, providerRunId: "123", providerAttempt: 1, workflowExecutionSha: commit, testedCandidateSha: commit,
    workflowPath: entry.policy.workflow.path, workflowSha256: sha, helperSha256: sha, artifactId: "456", archiveSha256: sha,
    reportSha256: sha, verifiedAt: new Date().toISOString(), reference: "https://github.com/fixture/repository/actions/runs/123/attempts/1",
    checks: ["ts_tests", "ts_typecheck", "ts_build", "go_tests"].map(check => ({ id: check, status: "passed" })),
    unsupportedObligations: ["live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"] };
  mocked.ci.mockResolvedValue({ ...ciReceipt, receiptSha256: hash(JSON.stringify(ciReceipt)) });
  mocked.mapping.mockResolvedValue({ version: 1, commitTreeSha: "c".repeat(40), ...source.snapshot });
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, resourceType: "integration_run", resourceId: id, replayed: false }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const db = database([{ id, owner: "fixture", name: "repository", connectionId: id, updatedAt: new Date(), authKind: "api_key" }]);
  const access = { schemaVersion: 3 as const, workspaceId: id, roleName: "verrail_proof_ro_aaaaaaaaaaaa", schemaName: "verrail_proof_ro_aaaaaaaaaaaa_facts",
    databaseUrl: "postgres://synthetic.invalid", expiresAt: new Date(Date.now() + 60000).toISOString(), policySha256: sha };
  const logs = { read: vi.fn() };
  return { db, access, input, config, logs, storage, fetcher, keys, source, receipt, request, result: vector.result };
}
it("signs only the complete rechecked context with fixed CI and never sends credentials or raw logs", async () => {
  const f = await fixture(); await recordDeliveryProof(f.db, f.access, f.input, f.config, f.logs, f.storage);
  expect(mocked.closed).toHaveBeenCalledTimes(2); expect(mocked.legacy).not.toHaveBeenCalled(); expect(f.logs.read).not.toHaveBeenCalled();
  const envelope = JSON.parse((f.fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string);
  const bytes = Buffer.from(envelope.payload, "base64"), payload = JSON.parse(bytes.toString()), observation = JSON.parse(payload.observationJson);
  expect(verify(null, Buffer.concat([Buffer.from("verrail.closed-delivery-proof.v1\0"), bytes]), f.keys.publicKey, Buffer.from(envelope.signature, "base64"))).toBe(true);
  expect(observation).toMatchObject({ kind: "opencode_execution", channel: null, execution: { outputReceiptSha256: f.receipt.sha256,
    usageStatus: "complete", costStatus: "unavailable" }, runtime: { kind: "verrail.opencode-candidate-runtime-proof" } });
  expect(payload.observationJson).not.toContain("synthetic-only"); expect(payload.observationJson).not.toContain("Fixture result");
  expect(Buffer.byteLength(payload.observationJson)).toBeLessThan(40000);
  if (process.env.VERRAIL_OPENCODE_PROOF_INTEROP === "1") process.stdout.write(`OPENCODE_CLOSED_PROOF_INTEROP ${JSON.stringify({
    synthetic: true, trust: f.config.trust, envelope, request: f.request, result: f.result })}\n`);
});
it.each(["old policy", "missing storage", "missing closed context", "context drift", "candidate drift", "caller observation"])("cannot sign after %s", async failure => {
  const f = await fixture(); let storage: typeof f.storage | undefined = f.storage;
  if (failure === "old policy") Object.assign(f.access, { schemaVersion: 2 });
  if (failure === "missing storage") storage = undefined;
  if (failure === "missing closed context") mocked.closed.mockRejectedValue(new Error("not independently observed"));
  if (failure === "context drift") mocked.closed.mockResolvedValueOnce(await mocked.closed()).mockImplementation(async () => { throw new Error("changed"); });
  if (failure === "candidate drift") f.config.runtime.manifest.candidateCommit = "f".repeat(40);
  if (failure === "caller observation") Object.assign(f.input, { observation: {} });
  await expect(recordDeliveryProof(f.db, f.access, f.input, f.config, f.logs, storage)).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("accepts a real V4 authority only under its separately pinned policy hash", async () => {
  const f = await fixture(), v4Hash = "4".repeat(64);
  Object.assign(f.access, { schemaVersion: 4, policySha256: v4Hash });
  mocked.authority.mockResolvedValue({ schemaVersion: 4, policySha256: v4Hash });
  await expect(recordDeliveryProof(f.db, f.access, f.input, f.config, f.logs, f.storage)).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  f.config.trust.readerPolicySha256 = v4Hash;
  await recordDeliveryProof(f.db, f.access, f.input, f.config, f.logs, f.storage);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
async function recoveryFixture() {
  const f = await fixture(), closed = structuredClone(await mocked.closed()); mocked.closed.mockClear();
  const data = JSON.parse(await readFile(new URL("../__tests__/helpers/repository-recovery-synthetic-projection.json", import.meta.url), "utf8"));
  expect(data.synthetic).toBe(true);
  const recovery = repositoryRecoveryProofSchema.parse(data.projection);
  recovery.runtimeManifestSha256 = f.config.runtime.manifestSha256;
  recovery.before.outputReceiptSha256 = closed.execution.outputReceiptSha256;
  recovery.before.executionObservationSha256 = closed.execution.executionObservation.contentHash;
  recovery.before.executionLogSha256 = closed.execution.logRef.contentHash;
  recovery.before.executionSessionId = closed.execution.sessionId;
  recovery.runtime.ownedCleanup.outputReceiptSha256 = closed.execution.outputReceiptSha256;
  recovery.runtime.ownedCleanup.terminationEnvelopeSha256 = closed.runtime.witnesses.find(
    (value: { component: string }) => value.component === "opencode").envelopeRef.contentHash;
  for (const witness of closed.runtime.witnesses) {
    if (witness.component !== "opencode") witness.observation.observedAt = recovery.before.observedAt;
    if (witness.component === "repository_executor") {
      witness.observerPid = recovery.runtime.observerProcess.pid;
      witness.observation.observerSessionId = recovery.runtime.old.observerSessionId;
    }
  }
  recovery.preRuntimeProofSha256 = deliveryObservationHash(closed.runtime);
  const stale = recovery.probes.stale;
  stale.requestHash = hash(JSON.stringify({ leaseId: recovery.probes.oldLeaseId, fencingToken: recovery.probes.oldFencingToken,
    cursor: recovery.probes.nextCursor, eventType: "heartbeat", emittedAt: stale.issuedAt.replace(/\.\d{3}Z$/, "Z") }));
  mocked.recovery.mockResolvedValue({ ...closed, recovery });
  Object.assign(f.access, { schemaVersion: 4 });
  f.config.recovery = { directory: f.config.runtime.directory, recoverySessionId: recovery.recoverySessionId,
    observerPublicKey: f.config.runtime.publicKey };
  return { ...f, input: { ...f.input, kind: "repository_recovery" as const }, closed, recovery };
}
it("signs recovery only through the complete recovery guard and nests the unchanged OpenCode component", async () => {
  const f = await recoveryFixture(); await recordDeliveryProof(f.db, f.access, f.input, f.config, f.logs, f.storage);
  expect(mocked.recovery).toHaveBeenCalledTimes(2); expect(mocked.closed).not.toHaveBeenCalled(); expect(mocked.legacy).not.toHaveBeenCalled();
  const envelope = JSON.parse((f.fetcher.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string);
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString()), observation = JSON.parse(payload.observationJson);
  expect(Object.keys(observation).sort()).toEqual(["delivery", "kind", "recovery", "schemaVersion"]);
  expect(observation.kind).toBe("repository_recovery");
  expect(observation.delivery.kind).toBe("opencode_execution"); expect(observation.delivery.references.kind).toBe("opencode_execution");
  expect(repositoryRecoveryProofSchema.parse(observation.recovery)).toEqual(f.recovery);
  expect(Buffer.byteLength(payload.observationJson)).toBeLessThan(40000);
  if (process.env.VERRAIL_RECOVERY_PROOF_INTEROP === "1") process.stdout.write(`RECOVERY_CLOSED_PROOF_INTEROP ${JSON.stringify({
    synthetic: true, trust: f.config.trust, envelope, request: f.request, result: f.result })}\n`);
  await recordDeliveryProof(f.db, f.access, f.input, f.config, f.logs, f.storage);
  expect(mocked.recovery).toHaveBeenCalledTimes(2);
});
it.each(["V3", "missing configuration", "missing closed chain", "changed journals", "oversize projection"])("rejects recovery %s", async failure => {
  const f = await recoveryFixture();
  if (failure === "V3") Object.assign(f.access, { schemaVersion: 3 });
  if (failure === "missing configuration") delete f.config.recovery;
  if (failure === "missing closed chain") mocked.recovery.mockRejectedValue(new Error("missing signed journal"));
  if (failure === "changed journals") mocked.recovery.mockResolvedValueOnce({ ...f.closed, recovery: f.recovery })
    .mockResolvedValue({ ...f.closed, recovery: { ...f.recovery, finalSha256: "f".repeat(64) } });
  if (failure === "oversize projection") mocked.recovery.mockResolvedValue({ ...f.closed, recovery: { ...f.recovery, extra: "x".repeat(40000) } });
  await expect(recordDeliveryProof(f.db, f.access, f.input, f.config, f.logs, f.storage)).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});
