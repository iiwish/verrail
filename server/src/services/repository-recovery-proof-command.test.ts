import { generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { runRepositoryRecoveryReaderCommand } from "./repository-recovery-proof-command.js";
import { openCodeRuntimeDigest } from "./opencode-runtime-observation.js";
import type { DeliveryProofRecorderConfig } from "./delivery-proof-recorder.js";

const mocked = vi.hoisted(() => ({ authority: vi.fn(), before: vi.fn(), probe: vi.fn(), complete: vi.fn() }));
vi.mock("./delivery-proof-reader-access.js", () => ({ assertDeliveryProofReader: mocked.authority }));
vi.mock("./repository-recovery-proof-reader.js", () => ({ authorizeRepositoryRecovery: mocked.before,
  authorizeRepositoryRecoveryProbes: mocked.probe, authorizeRepositoryRecoveryCompletion: mocked.complete }));
afterEach(() => vi.resetAllMocks());
const id = "11111111-1111-4111-8111-111111111111", sha = "a".repeat(64);
function fixture() {
  const key = generateKeyPairSync("ed25519"), commit = "b".repeat(40);
  const manifest = { schemaVersion: 1 as const, kind: "verrail.opencode-runtime-manifest" as const, candidateCommit: commit,
    apiOriginSha256: sha, domainOriginSha256: sha, observerExecutableSha256: sha,
    components: (["server", "domain", "repository_executor", "opencode"] as const).map(component => ({ component,
      configurationSha256: sha, verifierBuildSha256: sha, executableSha256: sha,
      sourceManifestSha256: ["server", "repository_executor"].includes(component) ? sha : null })) };
  const config: DeliveryProofRecorderConfig = { trust: { schemaVersion: 1, ci: { schemaVersion: 1, workspaceId: id, targetId: id,
    targetRevisionId: id, graphRevisionId: id, connectionId: id, bindingId: id, repository: "fixture/repository", repositoryId: 1,
    workflowId: 2, workflowExecutionSha: commit, workflowSha256: sha, helperSha256: sha, policySha256: sha, maxAgeMs: 60000 },
    publicKey: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
    readerPolicySha256: sha, verifierBuildSha256: sha, runtimeManifestSha256: openCodeRuntimeDigest(manifest), maxAgeMs: 60000 },
    privateKey: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), domainOrigin: "http://127.0.0.1:54321",
    githubPolicy: "[]", githubAuthorization: "", runtime: { manifest, manifestSha256: openCodeRuntimeDigest(manifest),
      sessionId: id, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), directory: "/private/fixture" },
    recovery: { recoverySessionId: id, directory: "/private/fixture", observerPublicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString() } };
  const access = { schemaVersion: 4, workspaceId: id } as Parameters<typeof runRepositoryRecoveryReaderCommand>[1];
  const references = { targetId: id, targetRevisionId: id, graphRevisionId: id, claimId: id, workNodeId: id,
    artifactRevisionId: id, requirementId: "recovery" };
  mocked.authority.mockResolvedValue({ policySha256: sha }); mocked.before.mockResolvedValue({ phase: "before" });
  mocked.probe.mockResolvedValue({ phase: "probe" }); mocked.complete.mockResolvedValue({ phase: "complete" });
  return { db: {} as Db, access, config, references, storage: { getObject: vi.fn() } };
}
it("routes only fixed private commands and injects workspace/key/runtime from trusted config", async () => {
  const f = fixture();
  await runRepositoryRecoveryReaderCommand(f.db, f.access, { kind: "recovery-authorize", references: {
    targetId: id, targetRevisionId: id, graphRevisionId: id, runId: id, runAttemptId: id } }, f.config, f.storage);
  await runRepositoryRecoveryReaderCommand(f.db, f.access, { kind: "recovery-probe-authorize", references: f.references, oldAttemptId: id }, f.config, f.storage);
  await runRepositoryRecoveryReaderCommand(f.db, f.access, { kind: "recovery-complete-authorize", references: f.references }, f.config, f.storage);
  expect(mocked.before).toHaveBeenCalledOnce(); expect(mocked.probe).toHaveBeenCalledOnce(); expect(mocked.complete).toHaveBeenCalledOnce();
  expect(mocked.before.mock.calls[0]![2].workspaceId).toBe(id);
  expect(mocked.probe.mock.calls[0]![4].config.readerPrivateKey).toBe(f.config.privateKey);
});
it.each(["V3", "policy", "key", "manifest", "candidate", "target", "missing config", "caller path", "caller facts", "collector failure"])("fails closed for %s", async failure => {
  const f = fixture(), input: Record<string, unknown> = { kind: "recovery-complete-authorize", references: f.references };
  if (failure === "V3") Object.assign(f.access, { schemaVersion: 3 });
  if (failure === "policy") mocked.authority.mockResolvedValue({ policySha256: "f".repeat(64) });
  if (failure === "key") f.config.trust.publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  if (failure === "manifest") f.config.runtime.manifestSha256 = "f".repeat(64);
  if (failure === "candidate") f.config.trust.ci.workflowExecutionSha = "f".repeat(40);
  if (failure === "target") f.references.targetId = "22222222-2222-4222-8222-222222222222";
  if (failure === "missing config") delete f.config.recovery;
  if (failure === "caller path") input.directory = "/tmp/injected";
  if (failure === "caller facts") input.observation = { passed: true };
  if (failure === "collector failure") mocked.complete.mockRejectedValue(new Error("missing actual journal"));
  await expect(runRepositoryRecoveryReaderCommand(f.db, f.access, input, f.config, f.storage)).rejects.toThrow();
  if (failure !== "collector failure") expect(mocked.complete).not.toHaveBeenCalled();
});
