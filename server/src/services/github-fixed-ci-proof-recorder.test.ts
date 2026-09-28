import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { createGitHubCiCollectionGuard, parseGitHubCiPolicies } from "./github-ci-proof-collector.js";
import { createGitHubFixedCiProofRecorder } from "./github-fixed-ci-proof-recorder.js";
import { createGitHubFixedCiProofClient } from "./github-fixed-ci-proof-client.js";
import { createGitHubCiReadDependencies } from "./github-ci-proof-adapters.js";

const uuid = (value: number) => `${String(value).padStart(8, "0")}-1111-4111-8111-111111111111`;
const sha = "a".repeat(64);
const commit = "b".repeat(40);
function setup() {
  const entry = {
    workspaceId: uuid(1), targetId: uuid(2), targetRevisionId: uuid(3), graphRevisionId: uuid(4),
    connectionId: uuid(5), bindingId: uuid(6), authorizedUserIds: ["actual-user"],
    policy: { repository: "owner/repo", repositoryId: 1, workflowId: 2,
      workflow: { path: ".github/workflows/verrail-candidate-verify.yml", sha: commit, sha256: sha },
      helper: { path: ".github/scripts/verrail-candidate-proof.mjs", sha256: sha },
      requiredJobs: [
        { name: "candidate_verify", steps: ["checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install", "proof_tests", "ts_tests", "ts_typecheck", "ts_build", "go_tests", "source_unchanged", "capture_results"] },
        { name: "candidate_report", steps: ["checkout", "setup_node", "report", "upload"] },
      ],
      artifactDownloadHosts: ["results.example.com"], maxAgeMs: 60_000, timeoutMs: 1000, maxPages: 2,
      maxResponseBytes: 100_000, maxArchiveBytes: 100_000, maxReportBytes: 10_000,
    },
  };
  let policy = JSON.stringify([entry]);
  const policySha256 = createHash("sha256").update(JSON.stringify(parseGitHubCiPolicies(policy)[0])).digest("hex");
  const context = { workspaceId: entry.workspaceId, targetId: entry.targetId, targetRevisionId: entry.targetRevisionId,
    graphRevisionId: entry.graphRevisionId, connectionId: entry.connectionId, bindingId: entry.bindingId,
    repository: entry.policy.repository, contextSha256: sha };
  const trust = { schemaVersion: 1 as const, ...context, policySha256, repositoryId: 1, workflowId: 2,
    workflowExecutionSha: commit, workflowSha256: sha, helperSha256: sha, maxAgeMs: 60_000 };
  const source = { criterionKey: "criterion-ci",
    source: { runId: uuid(7), runAttemptId: uuid(8), runEventId: uuid(9), runEventContentHash: sha,
      outputReceiptSha256: sha, artifactOrdinal: 0 },
    snapshot: { sourceSnapshotTreeSha: "c".repeat(40), sourceContentSha256: sha }, contextSha256: sha };
  const observation = { kind: "verrail.fixed-ci-observation", schemaVersion: 1, repository: "owner/repo", repositoryId: 1,
    providerRunId: "123", providerAttempt: 2, workflowExecutionSha: commit, testedCandidateSha: commit,
    workflowPath: entry.policy.workflow.path, workflowSha256: sha, helperSha256: sha, artifactId: "456",
    archiveSha256: sha, reportSha256: sha, verifiedAt: new Date().toISOString(),
    reference: "https://github.com/owner/repo/actions/runs/123/attempts/2", checks: [], unsupportedObligations: [], receiptSha256: sha };
  const loadContext = vi.fn(async () => context);
  const loadSourceContext = vi.fn(async () => source);
  const resolveCredential = vi.fn(async () => ({ connectionId: entry.connectionId, authorization: "Bearer fixture-only-credential" }));
  const read = vi.fn(async () => observation);
  const dependencies = { get: vi.fn() };
  const mapSource = vi.fn(async () => ({ version: 1 as const, commitTreeSha: "d".repeat(40), ...source.snapshot }));
  const audit = vi.fn(async () => ({ id: uuid(10) }));
  const record = vi.fn(async () => ({ schemaVersion: 1 as const, resourceType: "integration_run" as const, resourceId: uuid(11), replayed: false }));
  const options = { db: {} as Db, policyConfig: () => policy, loadContext, loadSourceContext, resolveCredential,
    createReader: () => ({ read }) as never, createReadDependencies: () => dependencies as never, mapSource,
    audit: audit as never, guard: createGitHubCiCollectionGuard(), proofClient: { trust, record } };
  const recorder = createGitHubFixedCiProofRecorder(options)!;
  const request = { workspaceId: entry.workspaceId, targetId: entry.targetId, idempotencyKey: "fixed-ci:recorder",
    actor: { actorType: "user" as const, actorId: "actual-user", actorSource: "session" as const },
    input: { runId: "123", runAttempt: 2, claimId: uuid(12), workNodeId: uuid(13), artifactRevisionId: uuid(14), requirementId: "fixed-ci" } };
  return { options, entry, trust, context, source, observation, loadContext, loadSourceContext, resolveCredential,
    read, dependencies, mapSource, audit, record, recorder, request, setPolicy: (value: string) => { policy = value; } };
}

describe("fixed CI proof recorder composition", () => {
  it("stays disabled without a dedicated capability client", () => {
    const f = setup(); expect(createGitHubFixedCiProofRecorder({ ...f.options, proofClient: null })).toBeNull();
    expect(f.resolveCredential).not.toHaveBeenCalled();
  });
  it("derives the dedicated command from actual session outputs and audits the initiating user separately", async () => {
    const f = setup(); await expect(f.recorder.record(f.request)).resolves.toMatchObject({ resourceType: "integration_run" });
    expect(f.read).toHaveBeenCalledWith({ runId: "123", runAttempt: 2, candidateSha: commit });
    expect(f.mapSource).toHaveBeenCalledWith(expect.objectContaining({ source: f.source.snapshot,
      testedCandidateSha: f.observation.testedCandidateSha, get: f.dependencies.get }));
    expect(f.loadSourceContext).toHaveBeenCalledTimes(3);
    expect(f.record).toHaveBeenCalledWith({ workspaceId: f.request.workspaceId, idempotencyKey: f.request.idempotencyKey,
      input: expect.objectContaining({ schemaVersion: 1, source: f.source.source, criterionKey: "criterion-ci",
        ci: expect.objectContaining({ providerRunId: "123", providerAttempt: 2, testedCommit: commit, observationSha256: sha }),
        mapping: { version: 1, commitTreeSha: "d".repeat(40), ...f.source.snapshot } }) });
    expect(f.audit).toHaveBeenCalledWith(f.options.db, expect.objectContaining({ actorType: "user", actorId: "actual-user",
      action: "github.fixed_ci_proof.collected", details: expect.objectContaining({ actorSource: "session" }) }));
    expect(JSON.stringify([f.record.mock.calls, f.audit.mock.calls])).not.toContain("fixture-only-credential");
    expect(f.audit.mock.invocationCallOrder[0]).toBeLessThan(f.record.mock.invocationCallOrder[0]);
  });
  it.each(["workspaceId", "targetId", "targetRevisionId", "graphRevisionId", "connectionId", "bindingId", "policySha256", "repository", "repositoryId", "workflowId", "workflowExecutionSha", "workflowSha256", "helperSha256", "maxAgeMs"])("rejects mismatched startup %s before source lookup and credentials", async key => {
    const f = setup(); Object.assign(f.trust, { [key]: "mismatch" });
    await expect(f.recorder.record(f.request)).rejects.toMatchObject({ status: 409 });
    expect(f.loadSourceContext).not.toHaveBeenCalled(); expect(f.resolveCredential).not.toHaveBeenCalled();
  });
  it.each([403, 404, 409, 422])("rejects unsupported/source preflight status %s before credentials or writes", async status => {
    const f = setup(); f.loadSourceContext.mockRejectedValue(new HttpError(status, "private-source-diagnostic"));
    await expect(f.recorder.record(f.request)).rejects.toMatchObject({ status, message: "GitHub fixed CI proof source or requirement is unavailable" });
    expect(f.resolveCredential).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  });
  it("rejects caller observations and missing idempotency before source or credentials", async () => {
    const f = setup();
    await expect(f.recorder.record({ ...f.request, input: { ...f.request.input, observation: f.observation } } as never)).rejects.toMatchObject({ status: 400 });
    await expect(f.recorder.record({ ...f.request, idempotencyKey: "" })).rejects.toMatchObject({ status: 400 });
    expect(f.loadSourceContext).not.toHaveBeenCalled(); expect(f.resolveCredential).not.toHaveBeenCalled();
  });
  it("sanitizes mapping failure without audit or proof persistence", async () => {
    const f = setup(); f.mapSource.mockRejectedValue(new Error("private-provider-response"));
    await expect(f.recorder.record(f.request)).rejects.toMatchObject({ status: 502, message: "GitHub fixed CI proof source mapping could not be verified" });
    expect(f.audit).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  });
  it("rejects source drift after provider reads without auditing or writing proof", async () => {
    const f = setup(); f.loadSourceContext.mockResolvedValueOnce(f.source).mockResolvedValue({ ...f.source, contextSha256: "b".repeat(64) });
    await expect(f.recorder.record(f.request)).rejects.toMatchObject({ status: 409 });
    expect(f.audit).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  });
  it("rechecks source after the initiating audit before the atomic domain command", async () => {
    const f = setup(); f.audit.mockImplementation(async () => { f.loadSourceContext.mockResolvedValue({ ...f.source, contextSha256: "b".repeat(64) }); return { id: uuid(10) }; });
    await expect(f.recorder.record(f.request)).rejects.toMatchObject({ status: 409 });
    expect(f.audit).toHaveBeenCalledTimes(1); expect(f.record).not.toHaveBeenCalled();
  });
  it("rechecks policy and connection after mapping without proof writes", async () => {
    const f = setup(); f.mapSource.mockImplementation(async () => { f.setPolicy("[]"); return { version: 1, commitTreeSha: "d".repeat(40), ...f.source.snapshot }; });
    await expect(f.recorder.record(f.request)).rejects.toMatchObject({ status: 409 });
    expect(f.audit).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled();
  });
  it("keeps collection guard held until domain persistence completes", async () => {
    const f = setup(); let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    f.record.mockImplementationOnce(async () => { await blocked; return { schemaVersion: 1, resourceType: "integration_run", resourceId: uuid(11), replayed: false }; });
    const pending = f.recorder.record(f.request);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(1));
    await expect(f.recorder.record(f.request)).rejects.toMatchObject({ status: 429 });
    finish(); await pending;
  });
  it("requires an inspectable audit before persistence and re-verifies on replay", async () => {
    const f = setup(); f.audit.mockRejectedValueOnce(new Error("private-audit-error"));
    await expect(f.recorder.record(f.request)).rejects.toMatchObject({ status: 503 }); expect(f.record).not.toHaveBeenCalled();
    f.record.mockResolvedValue({ schemaVersion: 1, resourceType: "integration_run", resourceId: uuid(11), replayed: true });
    await expect(f.recorder.record(f.request)).resolves.toMatchObject({ replayed: true });
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.mapSource).toHaveBeenCalledTimes(2);
  });
});

function reportZip(body: Buffer) {
  const name = Buffer.from("verrail-fixed-ci.json"); const checksum = crc32(body);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

describe("fixed CI actual reader, mapper and dedicated client composition", () => {
  it("reads the fixed report and exact provider tree, then emits a derived proof command only after mapping succeeds", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "verrail-recorder-composition-"));
    try {
      const exec = promisify(execFile);
      await exec("git", ["init", "--bare", "--quiet", "--template=", cwd]);
      const gitTree = (entries: string) => new Promise<string>((resolve, reject) => {
        const child = execFile("git", ["--git-dir", cwd, "mktree", "--missing"], (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
        child.stdin!.end(entries);
      });
      const codeSha = "e".repeat(40);
      const sourceTree = await gitTree(`100644 blob ${codeSha}\tcode.txt\n`);
      const emptyTree = await gitTree("");
      const fullTree = await gitTree(`040000 tree ${emptyTree}\t.verrail\n100644 blob ${codeSha}\tcode.txt\n`);
      const f = setup(); f.source.snapshot.sourceSnapshotTreeSha = sourceTree;
      const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
      f.entry.policy.workflow.sha256 = digest("fixture trusted workflow");
      f.entry.policy.helper.sha256 = digest("fixture trusted helper");
      f.setPolicy(JSON.stringify([f.entry]));
      const { contextSha256: _unused, ...trust } = f.trust;
      trust.policySha256 = digest(JSON.stringify(parseGitHubCiPolicies(JSON.stringify([f.entry]))[0]));
      trust.workflowSha256 = f.entry.policy.workflow.sha256; trust.helperSha256 = f.entry.policy.helper.sha256;
      const now = new Date(Date.now() - 1000).toISOString();
      const checks = ["ts_tests", "ts_typecheck", "ts_build", "go_tests"];
      const stepIds = f.entry.policy.requiredJobs[0]!.steps.filter(value => value !== "capture_results");
      const report = { schemaVersion: 1, kind: "verrail.fixed-ci", repository: "owner/repo",
        candidate: { sha: commit, ref: "refs/heads/codex/g2-7-candidate-fixture" },
        workflow: { ...f.entry.policy.workflow, ref: `owner/repo/${f.entry.policy.workflow.path}@refs/heads/codex/g2-7-candidate-fixture` },
        helper: f.entry.policy.helper, run: { id: "123", attempt: 2 },
        jobs: [{ id: "candidate_verify", result: "success", steps: stepIds.map(id => ({ id, outcome: "success", conclusion: "success" })) }],
        checks: checks.map(id => ({ id, status: "passed" })),
        unsupportedObligations: ["live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"] };
      const archive = reportZip(Buffer.from(JSON.stringify(report)));
      const run = { id: 123, run_attempt: 2, repository: { id: 1, full_name: "owner/repo" }, head_repository: { id: 1, full_name: "owner/repo" },
        workflow_id: 2, path: f.entry.policy.workflow.path, head_sha: commit, head_branch: "codex/g2-7-candidate-fixture",
        event: "push", status: "completed", conclusion: "success", created_at: now };
      const jobs = f.entry.policy.requiredJobs.map((job, index) => ({ id: index + 1, run_id: 123, head_sha: commit,
        name: job.name, status: "completed", conclusion: "success", completed_at: now,
        steps: job.steps.map((name, i) => ({ name, number: i + 1, status: "completed", conclusion: "success" })) }));
      const artifact = { id: 456, name: "verrail-fixed-ci-123-2", expired: false, size_in_bytes: archive.length,
        digest: `sha256:${digest(archive)}`, expires_at: new Date(Date.now() + 86400000).toISOString(),
        workflow_run: { id: 123, head_sha: commit, repository_id: 1, head_repository_id: 1 } };
      let tamper = false;
      const provider = vi.fn(async (url: string, init: RequestInit) => {
        expect(init.method).toBe("GET"); expect(init.redirect).toBe("manual");
        if (url.startsWith("https://results.example.com/")) {
          expect(new Headers(init.headers).has("authorization")).toBe(false);
          return new Response(archive);
        }
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-only-credential");
        const json = (value: unknown) => new Response(JSON.stringify(value));
        if (url.includes("/contents/")) return json({ encoding: "base64", content: Buffer.from(url.includes("workflows") ? "fixture trusted workflow" : "fixture trusted helper").toString("base64") });
        if (url.includes("/jobs?")) return json({ total_count: jobs.length, jobs });
        if (url.includes("/artifacts?")) return json({ total_count: 1, artifacts: [artifact] });
        if (url.endsWith("/456/zip")) return new Response(null, { status: 302, headers: { location: "https://results.example.com/archive?signed=fixture-private" } });
        if (url.endsWith(`/git/commits/${commit}`)) return json({ sha: commit, tree: { sha: fullTree } });
        if (url.endsWith(`/git/trees/${fullTree}`)) return json({ sha: fullTree, truncated: false,
          tree: [{ path: ".verrail", mode: "040000", type: "tree", sha: emptyTree },
            { path: "code.txt", mode: "100644", type: "blob", sha: tamper ? "f".repeat(40) : codeSha }] });
        expect(url).toBe("https://api.github.com/repos/owner/repo/actions/runs/123/attempts/2");
        return json(run);
      });
      const domain = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        expect(Object.keys(init!.headers!)).not.toContain("X-Verrail-Principal-Id");
        return new Response(JSON.stringify({ schemaVersion: 1, resourceType: "integration_run", resourceId: uuid(11), replayed: false }), { status: 201 });
      });
      const client = createGitHubFixedCiProofClient({ baseUrl: "http://127.0.0.1:1234", token: "fixture-proof-capability-never-a-live-secret",
        domainToken: "fixture-domain-token", trustConfig: JSON.stringify(trust), fetchImpl: domain })!;
      const recorder = createGitHubFixedCiProofRecorder({ ...f.options, createReader: undefined, mapSource: undefined,
        proofClient: client, createReadDependencies: options => createGitHubCiReadDependencies({ ...options, fetch: provider as typeof fetch }) })!;
      await expect(recorder.record(f.request)).resolves.toMatchObject({ resourceType: "integration_run" });
      expect(f.read).not.toHaveBeenCalled(); expect(f.mapSource).not.toHaveBeenCalled();
      expect(provider).toHaveBeenCalledTimes(9); expect(domain).toHaveBeenCalledTimes(1);
      const body = JSON.parse(domain.mock.calls[0]![1]!.body as string);
      expect(body).toMatchObject({ source: f.source.source,
        ci: { testedCommit: commit, archiveSha256: digest(archive), reportSha256: digest(JSON.stringify(report)) },
        mapping: { version: 1, commitTreeSha: fullTree, sourceSnapshotTreeSha: sourceTree, sourceContentSha256: sha } });
      expect(JSON.stringify([body, f.audit.mock.calls])).not.toMatch(/fixture-only-credential|fixture-private|fixture-proof-capability/);
      tamper = true;
      await expect(recorder.record(f.request)).rejects.toMatchObject({ status: 502 });
      expect(domain).toHaveBeenCalledTimes(1); expect(f.audit).toHaveBeenCalledTimes(1);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});
