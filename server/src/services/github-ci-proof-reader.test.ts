import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubCiProofReader, type GitHubCiTrustPolicy } from "./github-ci-proof-reader.js";

const sha = "a".repeat(40);
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const time = "2026-09-06T00:00:00.000Z";
const workflowPath = ".github/workflows/verrail-candidate-verify.yml";
const helperPath = ".github/scripts/verrail-candidate-proof.mjs";
const checkIds = ["ts_tests", "ts_typecheck", "ts_build", "go_tests"] as const;
const stepNames = ["checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install", "proof_tests", ...checkIds, "source_unchanged"];
const policy: GitHubCiTrustPolicy = {
  repository: "iiwish/verrail", repositoryId: 42, workflowId: 11,
  workflow: { path: workflowPath, sha, sha256: hash("trusted workflow") },
  helper: { path: helperPath, sha256: hash("trusted helper") },
  requiredJobs: [
    { name: "candidate_verify", steps: [...stepNames, "capture_results"] },
    { name: "candidate_report", steps: ["checkout", "setup_node", "report", "upload"] },
  ],
  artifactDownloadHosts: ["artifacts.githubusercontent.com"],
  maxAgeMs: 86_400_000, timeoutMs: 500, maxPages: 3, maxResponseBytes: 100_000,
  maxArchiveBytes: 100_000, maxReportBytes: 50_000,
};
const request = { runId: "123", runAttempt: 2, candidateSha: sha };

function fixture() {
  const report = {
    schemaVersion: 1, kind: "verrail.fixed-ci", repository: policy.repository,
    candidate: { sha, ref: "refs/heads/codex/g2-7-candidate-test" },
    workflow: { path: workflowPath, sha, ref: `iiwish/verrail/${workflowPath}@refs/heads/codex/g2-7-candidate-test`, sha256: policy.workflow.sha256 },
    helper: policy.helper, run: { id: "123", attempt: 2 },
    jobs: [{ id: "candidate_verify", result: "success", steps: stepNames.map(id => ({ id, outcome: "success", conclusion: "success" })) }],
    checks: checkIds.map(id => ({ id, status: "passed" })),
    unsupportedObligations: ["live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"],
  };
  const run = { id: 123, run_attempt: 2, repository: { id: 42, full_name: policy.repository }, head_repository: { id: 42, full_name: policy.repository }, workflow_id: 11, path: workflowPath, head_sha: sha, head_branch: "codex/g2-7-candidate-test", event: "push", status: "completed", conclusion: "success", created_at: time, updated_at: time };
  const jobs = policy.requiredJobs.map((j, index) => ({ id: index + 1, run_id: 123, run_attempt: 2, head_sha: sha, name: j.name, status: "completed", conclusion: "success", completed_at: time, steps: j.steps.map((name, i) => ({ name, number: i + 1, status: "completed", conclusion: "success" })) }));
  const archive = Buffer.from("bounded zip fixture");
  const artifact = { id: 456, name: "verrail-fixed-ci-123-2", expired: false, size_in_bytes: archive.length, digest: `sha256:${hash(archive)}`, expires_at: "2026-09-07T00:00:00.000Z", workflow_run: { id: 123, head_sha: sha, repository_id: 42, head_repository_id: 42 } };
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const get = vi.fn(async (path: string, init: { method: "GET"; redirect: "manual"; signal: AbortSignal }) => {
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("manual");
    if (path.includes("/contents/")) return json({ encoding: "base64", content: Buffer.from(path.includes("workflows") ? "trusted workflow" : "trusted helper").toString("base64") });
    if (path.includes("/jobs?")) return json({ total_count: jobs.length, jobs });
    if (path.includes("/artifacts?")) return json({ total_count: 1, artifacts: [artifact] });
    if (path.endsWith("/456/zip")) return new Response(null, { status: 302, headers: { location: "https://artifacts.githubusercontent.com/signed?token=do-not-emit" } });
    return json(run);
  });
  const publicGet = vi.fn(async () => new Response(archive));
  const decodeReportArchive = vi.fn(async () => [{ name: "verrail-fixed-ci.json", bytes: Buffer.from(JSON.stringify(report)) }]);
  const create = (overrides: Partial<GitHubCiTrustPolicy> = {}) => createGitHubCiProofReader({ ...policy, ...overrides }, { get, publicGet, decodeReportArchive, now: () => Date.parse(time) + 1000 });
  return { report, run, jobs, artifact, get, publicGet, decodeReportArchive, create, json, archive };
}

describe("GitHub fixed-CI proof reader", () => {
  it("returns only fixed-CI observations with stable source-derived time and sanitized replay", async () => {
    const f = fixture(); const reader = f.create();
    const one = await reader.read(request); const two = await reader.read(request);
    expect(two).toEqual(one);
    expect(one.kind).toBe("verrail.fixed-ci-observation");
    expect(one.verifiedAt).toBe(time);
    expect(one.workflowExecutionSha).toBe(sha);
    expect(one.testedCandidateSha).toBe(sha);
    expect(one.unsupportedObligations).toContain("live_codex");
    expect(JSON.stringify(one)).not.toMatch(/token|criterionProof|assertions/);
    expect(f.get.mock.calls.every(([path]) => path.startsWith("/repos/iiwish/verrail/"))).toBe(true);
  });

  it.each([
    ["wrong repository", (f: ReturnType<typeof fixture>) => { f.run.repository.full_name = "other/repo"; }],
    ["wrong repository id", (f: ReturnType<typeof fixture>) => { f.run.repository.id = 99; }],
    ["fork", (f: ReturnType<typeof fixture>) => { f.run.head_repository.id = 99; }],
    ["wrong workflow", (f: ReturnType<typeof fixture>) => { f.run.workflow_id = 99; }],
    ["wrong workflow path", (f: ReturnType<typeof fixture>) => { f.run.path = "evil.yml"; }],
    ["wrong commit", (f: ReturnType<typeof fixture>) => { f.run.head_sha = "b".repeat(40); }],
    ["wrong attempt", (f: ReturnType<typeof fixture>) => { f.run.run_attempt = 1; }],
    ["nonterminal", (f: ReturnType<typeof fixture>) => { f.run.status = "in_progress"; }],
    ["skipped step", (f: ReturnType<typeof fixture>) => { f.jobs[0]!.steps[0]!.conclusion = "skipped"; }],
    ["missing step", (f: ReturnType<typeof fixture>) => { f.jobs[0]!.steps.pop(); }],
    ["missing job", (f: ReturnType<typeof fixture>) => { f.jobs.pop(); }],
    ["wrong job attempt", (f: ReturnType<typeof fixture>) => { f.jobs[0]!.run_attempt = 1; }],
    ["expired artifact", (f: ReturnType<typeof fixture>) => { f.artifact.expired = true; }],
    ["artifact hash mismatch", (f: ReturnType<typeof fixture>) => { f.artifact.digest = `sha256:${"b".repeat(64)}`; }],
    ["report wrong commit", (f: ReturnType<typeof fixture>) => { f.report.candidate.sha = "b".repeat(40); }],
    ["report wrong workflow version", (f: ReturnType<typeof fixture>) => { f.report.workflow.sha256 = "b".repeat(64); }],
    ["report wrong attempt", (f: ReturnType<typeof fixture>) => { f.report.run.attempt = 1; }],
    ["report skips check", (f: ReturnType<typeof fixture>) => { f.report.checks.pop(); }],
    ["report lies about job", (f: ReturnType<typeof fixture>) => { f.report.jobs[0]!.result = "failure"; }],
  ])("rejects %s", async (_name, mutate) => {
    const f = fixture(); mutate(f); await expect(f.create().read(request)).rejects.toThrow();
  });

  it("rejects caller-selected verdict/assertion authority before any GET", async () => {
    const f = fixture();
    await expect(f.create().read({ ...request, verdict: "passed", assertions: ["live_codex"] } as typeof request)).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 302])("sanitizes provider HTTP %i without following API redirects", async status => {
    const f = fixture(); f.get.mockImplementation(async () => new Response("SECRET", { status, headers: { location: "https://evil.test/SECRET" } }));
    await expect(f.create().read(request)).rejects.toThrow(/^GitHub CI read failed:/);
    expect(f.publicGet).not.toHaveBeenCalled();
  });

  it("never forwards credential-bearing API requests to artifact redirects", async () => {
    const f = fixture(); await f.create().read(request);
    expect(f.publicGet).toHaveBeenCalledWith("https://artifacts.githubusercontent.com/signed?token=do-not-emit", expect.objectContaining({ method: "GET", redirect: "manual", credentials: "omit" }));
  });

  it("rejects an untrusted artifact host", async () => {
    const f = fixture(); const original = f.get.getMockImplementation()!;
    f.get.mockImplementation((p, init) => p.endsWith("/zip") ? Promise.resolve(new Response(null, { status: 302, headers: { location: "https://artifacts.githubusercontent.com.evil.test/" } })) : original(p, init));
    await expect(f.create().read(request)).rejects.toThrow(); expect(f.publicGet).not.toHaveBeenCalled();
  });

  it("rejects oversize, malformed and incomplete evidence", async () => {
    const f = fixture(); f.get.mockImplementation(async () => new Response("x".repeat(101)));
    await expect(f.create({ maxResponseBytes: 100 }).read(request)).rejects.toThrow();
    f.get.mockImplementation(async () => new Response("not json"));
    await expect(f.create().read(request)).rejects.toThrow();
  });

  it("bounds fetch even when injected transport ignores cancellation", async () => {
    const f = fixture(); f.get.mockImplementation(() => new Promise(() => {}));
    await expect(f.create({ timeoutMs: 10 }).read(request)).rejects.toThrow("timeout");
  });

  it("rejects stale observations and separately pinned workflow execution identity", async () => {
    const f = fixture(); await expect(f.create({ maxAgeMs: 100 }).read(request)).rejects.toThrow();
    await expect(f.create({ workflow: { ...policy.workflow, sha: "b".repeat(40) } }).read(request)).rejects.toThrow();
  });

  it("rejects a source hash mismatch independently of the self-reported hash", async () => {
    const f = fixture(); const original = f.get.getMockImplementation()!;
    f.get.mockImplementation((p, init) => p.includes("/contents/") ? Promise.resolve(f.json({ encoding: "base64", content: Buffer.from("tampered source").toString("base64") })) : original(p, init));
    await expect(f.create().read(request)).rejects.toThrow("untrusted source hash");
  });

  it("does not leak provider exceptions even when they mimic an internal error", async () => {
    const f = fixture(); f.get.mockRejectedValue(new Error("GitHub CI read failed: SECRET"));
    await expect(f.create().read(request)).rejects.toThrow("GitHub CI read failed: provider or decoder failure");
  });

  it("rejects archive size declarations, streamed overflows, redirected downloads and malformed reports", async () => {
    const declared = fixture(); declared.artifact.size_in_bytes = 100_001;
    await expect(declared.create().read(request)).rejects.toThrow("oversize archive");
    const streamed = fixture(); streamed.publicGet.mockImplementation(async () => new Response(Buffer.alloc(100_001)));
    await expect(streamed.create().read(request)).rejects.toThrow("oversize evidence");
    const redirected = fixture(); redirected.publicGet.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } }));
    await expect(redirected.create().read(request)).rejects.toThrow();
    const malformed = fixture(); malformed.decodeReportArchive.mockResolvedValue([{ name: "verrail-fixed-ci.json", bytes: Buffer.from("not JSON") }]);
    await expect(malformed.create().read(request)).rejects.toThrow("malformed report");
  });

  it("requires a separately bounded archive decoder and also bounds its timeout", async () => {
    const f = fixture(); await f.create().read(request);
    expect(f.decodeReportArchive).toHaveBeenCalledWith(f.archive, expect.objectContaining({ fileName: "verrail-fixed-ci.json", maxEntries: 1, maxUncompressedBytes: 50_000, signal: expect.any(AbortSignal) }));
    const stalled = fixture(); stalled.decodeReportArchive.mockImplementation(() => new Promise(() => {}));
    await expect(stalled.create({ timeoutMs: 50 }).read(request)).rejects.toThrow("timeout");
  });

  it("reads complete successful pagination and ignores response ordering on replay", async () => {
    const f = fixture(); const original = f.get.getMockImplementation()!;
    f.get.mockImplementation((p, init) => p.includes("/jobs?") ? Promise.resolve(f.json({ total_count: 2, jobs: [f.jobs[p.includes("page=2&") ? 1 : 0]] })) : original(p, init));
    const first = await f.create().read(request);
    f.jobs.reverse(); const next = await f.create().read(request);
    expect(next).toEqual(first);
  });

  it("snapshots server policy and rejects weakened required-step policy", async () => {
    const f = fixture();
    expect(() => f.create({ requiredJobs: policy.requiredJobs.map(j => ({ ...j, steps: [] })) })).toThrow("invalid required steps");
    const mutable = structuredClone(policy);
    const reader = createGitHubCiProofReader(mutable, { get: f.get, publicGet: f.publicGet, decodeReportArchive: f.decodeReportArchive, now: () => Date.parse(time) + 1000 });
    mutable.repository = "evil/repo";
    await expect(reader.read(request)).resolves.toHaveProperty("repository", "iiwish/verrail");
  });

  it("accepts documented attempt responses with branch-qualified workflow paths and no redundant job attempt", async () => {
    const f = fixture(); f.run.path = `${workflowPath}@${f.run.head_branch}`;
    for (const job of f.jobs) delete (job as { run_attempt?: number }).run_attempt;
    await expect(f.create().read(request)).resolves.toHaveProperty("providerAttempt", 2);
    expect(f.get.mock.calls.some(([p]) => p === "/repos/iiwish/verrail/actions/runs/123/attempts/2/jobs?page=1&per_page=100")).toBe(true);
    f.run.path = `${workflowPath}@refs/heads/${f.run.head_branch}`;
    await expect(f.create().read(request)).resolves.toHaveProperty("providerAttempt", 2);
    f.run.path = `${workflowPath}@other-branch`;
    await expect(f.create().read(request)).rejects.toThrow("workflow mismatch");
  });

  it("accepts successful GitHub generated steps but rejects failed post-action cleanup", async () => {
    const f = fixture();
    f.jobs[0]!.steps.push(...["Set up job", "Post checkout", "Post setup_node", "Complete job"].map((name, i) => ({ name, number: 50 + i, status: "completed", conclusion: "success" })));
    await expect(f.create().read(request)).resolves.toHaveProperty("kind", "verrail.fixed-ci-observation");
    f.jobs[0]!.steps.find(s => s.name === "Post checkout")!.conclusion = "failure";
    await expect(f.create().read(request)).rejects.toThrow("partial or failed steps");
  });

  it("does not accept an artifact author's assertion list as authority", async () => {
    const f = fixture(); Object.assign(f.report, { assertions: ["live_codex", "live_feishu"] });
    await expect(f.create().read(request)).rejects.toThrow("malformed report");
  });

  it("consumes all bounded pages, rather than accepting only page-one required jobs", async () => {
    const f = fixture(); const original = f.get.getMockImplementation()!;
    f.get.mockImplementation((p, init) => p.includes("/jobs?") ? Promise.resolve(f.json({ total_count: 3, jobs: p.includes("page=2&") ? [{ ...f.jobs[0], id: 3, name: "hidden_failure", conclusion: "failure" }] : f.jobs })) : original(p, init));
    await expect(f.create().read(request)).rejects.toThrow();
    expect(f.get.mock.calls.some(([p]) => p.includes("page=2&"))).toBe(true);
  });

  it("rejects pagination totals drifting, duplicate IDs, empty partial pages and over-budget pages", async () => {
    for (const mode of ["drift", "duplicate", "empty", "budget"]) {
      const f = fixture(); const original = f.get.getMockImplementation()!;
      f.get.mockImplementation((p, init) => p.includes("/jobs?") ? Promise.resolve(f.json({ total_count: mode === "drift" && p.includes("page=2&") ? 4 : 3, jobs: p.includes("page=2&") && mode === "empty" ? [] : [f.jobs[0]] })) : original(p, init));
      await expect(f.create({ maxPages: mode === "budget" ? 1 : 3 }).read(request)).rejects.toThrow();
    }
  });

  it("rejects unsafe/multiple archive entries and over-limit extracted JSON", async () => {
    for (const entries of [
      [{ name: "../verrail-fixed-ci.json", bytes: Buffer.from("{}") }],
      [{ name: "verrail-fixed-ci.json", bytes: Buffer.from("{}") }, { name: "extra", bytes: Buffer.from("x") }],
      [{ name: "verrail-fixed-ci.json", bytes: Buffer.alloc(50_001) }],
    ]) {
      const f = fixture(); f.decodeReportArchive.mockResolvedValue(entries);
      await expect(f.create().read(request)).rejects.toThrow();
    }
  });
});
