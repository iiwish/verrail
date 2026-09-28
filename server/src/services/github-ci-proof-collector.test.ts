import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createGitHubCiObservationCollector, createGitHubCiCollectionGuard, parseGitHubCiPolicies } from "./github-ci-proof-collector.js";

export const policyEntry = () => ({
  workspaceId: "11111111-1111-4111-8111-111111111111", targetId: "22222222-2222-4222-8222-222222222222",
  targetRevisionId: "33333333-3333-4333-8333-333333333333", graphRevisionId: "44444444-4444-4444-8444-444444444444",
  connectionId: "55555555-5555-4555-8555-555555555555", bindingId: "66666666-6666-4666-8666-666666666666", authorizedUserIds: ["real-user"],
  policy: {
    repository: "owner/repo", repositoryId: 1, workflowId: 2,
    workflow: { path: ".github/workflows/verrail-candidate-verify.yml", sha: "a".repeat(40), sha256: "b".repeat(64) },
    helper: { path: ".github/scripts/verrail-candidate-proof.mjs", sha256: "c".repeat(64) },
    requiredJobs: [
      { name: "candidate_verify", steps: ["checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install", "proof_tests", "ts_tests", "ts_typecheck", "ts_build", "go_tests", "source_unchanged", "capture_results"] },
      { name: "candidate_report", steps: ["checkout", "setup_node", "report", "upload"] },
    ],
    artifactDownloadHosts: ["results.example.com"], maxAgeMs: 60_000, timeoutMs: 1000, maxPages: 2,
    maxResponseBytes: 100_000, maxArchiveBytes: 100_000, maxReportBytes: 10_000,
  },
});

function setup() {
  const entry = policyEntry();
  let config: string | undefined = JSON.stringify([entry]);
  const context = { workspaceId: entry.workspaceId, targetId: entry.targetId, targetRevisionId: entry.targetRevisionId,
    graphRevisionId: entry.graphRevisionId, connectionId: entry.connectionId, bindingId: entry.bindingId,
    repository: entry.policy.repository, contextSha256: "d".repeat(64) };
  const loadContext = vi.fn(async () => context);
  const resolveCredential = vi.fn(async () => ({ connectionId: entry.connectionId, authorization: "Bearer test-only-secret" }));
  const observation = { kind: "verrail.fixed-ci-observation", receiptSha256: "e".repeat(64) };
  const read = vi.fn(async () => observation);
  const createReadDependencies = vi.fn();
  const audit = vi.fn(async () => ({ id: "audit-id" }));
  const collector = createGitHubCiObservationCollector({ db: {} as Db, policyConfig: () => config, loadContext,
    resolveCredential, createReadDependencies, createReader: () => ({ read }) as never, audit,
    guard: createGitHubCiCollectionGuard() });
  const request = { workspaceId: entry.workspaceId, targetId: entry.targetId,
    actor: { actorType: "user" as const, actorId: "real-user", actorSource: "session" as const }, input: { runId: "12", runAttempt: 1 } };
  return { entry, context, loadContext, resolveCredential, read, audit, createReadDependencies, collector, request, setConfig: (v: string | undefined) => { config = v; } };
}

describe("production GitHub CI collection", () => {
  it("rejects absent, malformed, ambiguous and unsafe policy before secrets", async () => {
    for (const raw of [undefined, "{", JSON.stringify([policyEntry(), policyEntry()]), " ".repeat(131073)]) {
      const s = setup(); s.setConfig(raw);
      await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 503 });
      expect(s.resolveCredential).not.toHaveBeenCalled(); expect(s.loadContext).not.toHaveBeenCalled();
    }
    const entry = policyEntry(); entry.policy.timeoutMs = 120001;
    expect(() => parseGitHubCiPolicies(JSON.stringify([entry]))).toThrow();
    expect(() => parseGitHubCiPolicies(JSON.stringify([{ ...policyEntry(), secret: "forbidden" }]))).toThrow();
  });
  it("rejects missing/unauthorized initiator and caller proof fields before secrets", async () => {
    const s = setup();
    for (const actorId of ["", "board", "other"]) {
      await expect(s.collector.collect({ ...s.request, actor: { ...s.request.actor, actorId } })).rejects.toMatchObject({ status: 403 });
    }
    await expect(s.collector.collect({ ...s.request, input: { ...s.request.input, candidateSha: "a".repeat(40) } } as never)).rejects.toMatchObject({ status: 400 });
    expect(s.resolveCredential).not.toHaveBeenCalled();
  });
  it("rejects invalid actor provenance and each mismatched context pin", async () => {
    for (const actor of [{ actorType: "agent", actorId: "real-user", actorSource: "session" }, { actorType: "user", actorId: "real-user" }]) {
      const s = setup();
      await expect(s.collector.collect({ ...s.request, actor } as never)).rejects.toMatchObject({ status: 403 });
      expect(s.resolveCredential).not.toHaveBeenCalled();
    }
    for (const key of ["workspaceId", "targetId", "targetRevisionId", "graphRevisionId", "connectionId", "bindingId", "repository"] as const) {
      const s = setup(); s.loadContext.mockResolvedValue({ ...s.context, [key]: "mismatch" });
      await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 409 });
      expect(s.resolveCredential).not.toHaveBeenCalled();
    }
  });
  it("rejects adapter-invalid policies before resolving credentials", async () => {
    for (const change of [
      { artifactDownloadHosts: ["archive.internal"] },
      { repository: `${"a".repeat(250)}/repository` },
    ]) {
      const s = setup(); Object.assign(s.entry.policy, change); s.setConfig(JSON.stringify([s.entry]));
      await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 503 });
      expect(s.resolveCredential).not.toHaveBeenCalled();
    }
  });
  it("uses actual initiator/source, rechecks context and audits only sanitized observation", async () => {
    const s = setup(); const result = await s.collector.collect(s.request);
    expect(s.resolveCredential).toHaveBeenCalledWith(expect.anything(), s.request.workspaceId, s.request.actor);
    expect(s.read).toHaveBeenCalledWith({ ...s.request.input, candidateSha: s.entry.policy.workflow.sha });
    expect(s.loadContext).toHaveBeenCalledTimes(3);
    expect(result.auditEventId).toBe("audit-id");
    expect(s.audit.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: "real-user", actorType: "user", details: expect.objectContaining({ actorSource: "session", verifier: "verrail/github-fixed-ci-reader/v1" }) })]));
    expect(JSON.stringify([result, s.audit.mock.calls])).not.toContain("test-only-secret");
  });
  it("rejects drift after credential resolution without network", async () => {
    const s = setup(); s.loadContext.mockResolvedValueOnce(s.context).mockResolvedValue({ ...s.context, contextSha256: "f".repeat(64) });
    await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 409 });
    expect(s.read).not.toHaveBeenCalled(); expect(s.audit).not.toHaveBeenCalled();
  });
  it("rejects wrong resolved connection and drift after read", async () => {
    const s = setup(); s.resolveCredential.mockResolvedValue({ connectionId: "wrong", authorization: "secret" });
    await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 409 }); expect(s.read).not.toHaveBeenCalled();
    const t = setup(); t.loadContext.mockResolvedValueOnce(t.context).mockResolvedValueOnce(t.context).mockResolvedValue({ ...t.context, contextSha256: "f".repeat(64) });
    await expect(t.collector.collect(t.request)).rejects.toMatchObject({ status: 409 }); expect(t.audit).not.toHaveBeenCalled();
  });
  it("rechecks operator authorization after network and fails closed on audit failure", async () => {
    const s = setup(); s.read.mockImplementation(async () => { s.setConfig(undefined); return {} as never; });
    await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 409 }); expect(s.audit).not.toHaveBeenCalled();
    const t = setup(); t.audit.mockRejectedValue(new Error("signed-url-secret"));
    await expect(t.collector.collect(t.request)).rejects.toMatchObject({ status: 503, message: "GitHub CI observation audit unavailable" });
  });
  it("sanitizes resolver and provider failures and releases concurrent slot", async () => {
    const s = setup(); s.resolveCredential.mockRejectedValueOnce(new Error("secret"));
    await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 503, message: "GitHub CI credential unavailable" });
    await expect(s.collector.collect(s.request)).resolves.toBeDefined();
  });
  it("does not expose raw database failures", async () => {
    const s = setup(); s.loadContext.mockRejectedValue(new Error("database-url-secret"));
    await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 503, message: "GitHub CI collection context unavailable" });
    expect(s.resolveCredential).not.toHaveBeenCalled();
  });
  it("sanitizes provider failure and releases the in-flight guard", async () => {
    const s = setup(); s.read.mockRejectedValueOnce(new Error("provider-body-signed-url"));
    await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 502, message: "GitHub CI observation could not be verified" });
    expect(s.audit).not.toHaveBeenCalled();
    await expect(s.collector.collect(s.request)).resolves.toBeDefined();
  });
  it("enforces concurrency before secret lookup and resets after completion", async () => {
    const s = setup(); let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    s.read.mockImplementationOnce(async () => { await blocked; return {} as never; });
    const first = s.collector.collect(s.request);
    await vi.waitFor(() => expect(s.read).toHaveBeenCalledTimes(1));
    await expect(s.collector.collect(s.request)).rejects.toMatchObject({ status: 429 });
    expect(s.resolveCredential).toHaveBeenCalledTimes(1);
    release(); await first;
    await expect(s.collector.collect(s.request)).resolves.toBeDefined();
  });
  it("bounds global/key concurrency, rate and cardinality with no early release", () => {
    let now = 0; const guard = createGitHubCiCollectionGuard(() => now);
    const release = guard.acquire("a"); expect(() => guard.acquire("a")).toThrow(); release(); release();
    for (let i = 0; i < 3; i++) guard.acquire("a")();
    expect(() => guard.acquire("a")).toThrow(); now += 60001; guard.acquire("a")();
    const releases = ["a", "b", "c", "d"].map(k => guard.acquire(k));
    expect(() => guard.acquire("e")).toThrow(); releases.forEach(fn => fn());
    for (let i = 0; i < 252; i++) guard.acquire(`key-${i}`)();
    expect(() => guard.acquire("overflow")).toThrow();
  });
});
