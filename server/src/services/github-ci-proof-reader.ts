import { createHash } from "node:crypto";
import { z } from "zod";

const CHECKS = ["ts_tests", "ts_typecheck", "ts_build", "go_tests"] as const;
const UNSUPPORTED = ["live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"] as const;
const VERIFY_STEPS = ["checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install", "proof_tests", ...CHECKS, "source_unchanged"];
const REPORT_FILE = "verrail-fixed-ci.json";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const identifier = z.string().regex(/^[1-9][0-9]*$/).refine(v => Number.isSafeInteger(Number(v)));
const requestSchema = z.object({ runId: identifier, runAttempt: z.number().int().positive(), candidateSha: z.string().regex(SHA) }).strict();
type CollectionRequest = z.infer<typeof requestSchema>;

export interface GitHubCiTrustPolicy {
  repository: string;
  repositoryId: number;
  workflowId: number;
  workflow: { path: string; sha: string; sha256: string };
  helper: { path: string; sha256: string };
  requiredJobs: ReadonlyArray<{ name: string; steps: readonly string[] }>;
  artifactDownloadHosts: readonly string[];
  maxAgeMs: number;
  timeoutMs: number;
  maxPages: number;
  maxResponseBytes: number;
  maxArchiveBytes: number;
  maxReportBytes: number;
}

type ReadInit = { method: "GET"; redirect: "manual"; signal: AbortSignal };
export interface GitHubCiReadDependencies {
  // Server-owned authenticated adapter: paths are restricted to the pinned repository.
  // It MUST honor manual redirects and must never log credentials or response bodies.
  get(path: string, init: ReadInit): Promise<Response>;
  // Separate unauthenticated transport; never wrap get or inherit its headers/cookies.
  publicGet(url: string, init: ReadInit & { credentials: "omit" }): Promise<Response>;
  // Production ZIP adapter is intentionally not implemented here. Use a maintained
  // parser with streaming size limits, no disk extraction, links or encrypted entries.
  // Limits must be enforced DURING decompression, not only against returned entries.
  decodeReportArchive(bytes: Uint8Array, limits: {
    fileName: string; maxEntries: number; maxUncompressedBytes: number; signal: AbortSignal;
  }): Promise<Array<{ name: string; bytes: Uint8Array }>>;
  now?: () => number;
}

const reportSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("verrail.fixed-ci"), repository: z.string(),
  candidate: z.object({ sha: z.string().regex(SHA), ref: z.string() }).strict(),
  workflow: z.object({ path: z.string(), sha: z.string().regex(SHA), ref: z.string(), sha256: z.string().regex(DIGEST) }).strict(),
  helper: z.object({ path: z.string(), sha256: z.string().regex(DIGEST) }).strict(),
  run: z.object({ id: identifier, attempt: z.number().int().positive() }).strict(),
  jobs: z.array(z.object({ id: z.string(), result: z.enum(["success", "failure"]), steps: z.array(z.object({ id: z.string(), outcome: z.string(), conclusion: z.string() }).strict()).max(100) }).strict()).length(1),
  checks: z.array(z.object({ id: z.enum(CHECKS), status: z.enum(["passed", "failed"]) }).strict()).length(4),
  unsupportedObligations: z.array(z.enum(UNSUPPORTED)).length(6),
}).strict();

class GitHubCiReadError extends Error {
  constructor(code: string) { super(`GitHub CI read failed: ${code}`); }
}
function fail(code: string): never { throw new GitHubCiReadError(code); }
function ensure(condition: unknown, code: string): asserts condition { if (!condition) fail(code); }
function record(v: unknown): Record<string, unknown> {
  ensure(v !== null && typeof v === "object" && !Array.isArray(v), "malformed evidence");
  return v as Record<string, unknown>;
}
function positiveId(v: unknown): number { ensure(typeof v === "number" && Number.isSafeInteger(v) && v > 0, "invalid provider identity"); return v; }
function list(v: unknown): unknown[] { ensure(Array.isArray(v), "incomplete evidence"); return v; }
function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function timestamp(v: unknown) { ensure(typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)), "invalid evidence time"); return Date.parse(v); }
function exactSet(actual: readonly string[], expected: readonly string[]) { return actual.length === expected.length && new Set(actual).size === actual.length && expected.every(v => actual.includes(v)); }

function validatePolicy(p: GitHubCiTrustPolicy) {
  ensure(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) && !p.repository.split("/").some(s => s === "." || s === ".."), "invalid trust policy");
  positiveId(p.repositoryId); positiveId(p.workflowId);
  ensure(p.workflow.path === ".github/workflows/verrail-candidate-verify.yml" && p.helper.path === ".github/scripts/verrail-candidate-proof.mjs", "invalid trust policy");
  ensure(SHA.test(p.workflow.sha) && DIGEST.test(p.workflow.sha256) && DIGEST.test(p.helper.sha256), "invalid trust policy");
  ensure(exactSet(p.requiredJobs.map(j => j.name), ["candidate_verify", "candidate_report"]), "invalid required jobs");
  for (const job of p.requiredJobs) {
    const required = job.name === "candidate_verify" ? [...VERIFY_STEPS, "capture_results"] : ["checkout", "setup_node", "report", "upload"];
    ensure(job.steps.length <= 100 && new Set(job.steps).size === job.steps.length && required.every(s => job.steps.includes(s)), "invalid required steps");
  }
  for (const key of ["maxAgeMs", "timeoutMs", "maxPages", "maxResponseBytes", "maxArchiveBytes", "maxReportBytes"] as const) ensure(Number.isSafeInteger(p[key]) && p[key] > 0, "invalid limits");
  ensure(p.maxPages <= 20 && p.timeoutMs <= 120_000 && p.maxResponseBytes <= 2_000_000 && p.maxArchiveBytes <= 10_000_000 && p.maxReportBytes <= 1_000_000, "unsafe limits");
  ensure(p.artifactDownloadHosts.length > 0 && p.artifactDownloadHosts.every(h => /^[a-z0-9.-]+$/.test(h) && h !== "localhost" && !/^\d/.test(h)), "invalid artifact hosts");
}

export function createGitHubCiProofReader(serverOwnedPolicy: GitHubCiTrustPolicy, deps: GitHubCiReadDependencies) {
  const p = structuredClone(serverOwnedPolicy);
  validatePolicy(p);
  const base = `/repos/${p.repository}`;

  async function collect(input: CollectionRequest, signal: AbortSignal) {
    const now = (deps.now ?? Date.now)();
    async function body(response: Response, max: number) {
      ensure(!response.redirected, "redirect rejected");
      const size = response.headers.get("content-length");
      ensure(size === null || (/^\d+$/.test(size) && Number(size) <= max), "oversize evidence");
      ensure(response.body, "empty evidence");
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          ensure(!signal.aborted, "timeout");
          const part = await reader.read(); if (part.done) break;
          length += part.value.length; ensure(length <= max, "oversize evidence"); chunks.push(part.value);
        }
        return Buffer.concat(chunks, length);
      } finally { signal.removeEventListener("abort", cancel); void reader.cancel().catch(() => {}); }
    }
    async function get(path: string) {
      ensure(!signal.aborted, "timeout");
      const response = await deps.get(`${base}${path}`, { method: "GET", redirect: "manual", signal });
      ensure(!response.redirected, "redirect rejected");
      return response;
    }
    async function json(path: string) {
      const response = await get(path);
      ensure(response.status === 200, `provider HTTP ${response.status}`);
      try { return record(JSON.parse((await body(response, p.maxResponseBytes)).toString("utf8"))); }
      catch (error) { if (error instanceof GitHubCiReadError) throw error; fail("malformed evidence"); }
    }
    async function pages(path: string, key: string) {
      const result: Record<string, unknown>[] = []; const ids = new Set<number>(); let total: number | undefined;
      for (let page = 1; page <= p.maxPages; page++) {
        const payload = await json(`${path}?page=${page}&per_page=100`);
        ensure(Number.isSafeInteger(payload.total_count) && Number(payload.total_count) >= 0, "invalid pagination");
        if (total === undefined) total = Number(payload.total_count);
        ensure(payload.total_count === total && total <= 100 * p.maxPages, "incomplete pagination");
        const items = list(payload[key]); ensure(items.length <= 100, "invalid pagination");
        for (const item of items) {
          const row = record(item); const id = positiveId(row.id);
          ensure(!ids.has(id), "duplicate evidence"); ids.add(id); result.push(row);
        }
        ensure(result.length <= total, "inconsistent pagination");
        if (result.length === total) return result;
        ensure(items.length > 0, "incomplete pagination");
      }
      fail("pagination budget exceeded");
    }

    const runPath = `/actions/runs/${input.runId}/attempts/${input.runAttempt}`;
    const run = await json(runPath);
    for (const source of [record(run.repository), record(run.head_repository)]) ensure(source.id === p.repositoryId && source.full_name === p.repository, "repository mismatch");
    ensure(run.id === Number(input.runId) && run.run_attempt === input.runAttempt, "run attempt mismatch");
    // This v1 policy supports push only. For push, the execution revision and
    // candidate revision coincide, but remain separately named and independently pinned.
    ensure(run.event === "push" && typeof run.head_branch === "string" && /^codex\/g2-7-candidate-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(run.head_branch), "untrusted trigger");
    const workflowPaths = [p.workflow.path, `${p.workflow.path}@${run.head_branch}`, `${p.workflow.path}@refs/heads/${run.head_branch}`];
    ensure(run.workflow_id === p.workflowId && typeof run.path === "string" && workflowPaths.includes(run.path), "workflow mismatch");
    ensure(run.head_sha === input.candidateSha && run.head_sha === p.workflow.sha, "commit mismatch");
    ensure(run.status === "completed" && run.conclusion === "success", "run not successful");
    const createdAt = timestamp(run.created_at);
    for (const identity of [p.workflow, p.helper]) {
      const content = await json(`/contents/${identity.path}?ref=${p.workflow.sha}`);
      ensure(content.encoding === "base64" && typeof content.content === "string", "missing trusted source");
      const encoded = content.content.replace(/\s/g, "");
      ensure(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded), "malformed trusted source");
      ensure(digest(Buffer.from(encoded, "base64")) === identity.sha256, "untrusted source hash");
    }
    const jobs = await pages(`${runPath}/jobs`, "jobs");
    ensure(exactSet(jobs.map(j => String(j.name)), p.requiredJobs.map(j => j.name)), "unexpected or missing jobs");
    let completedAt = createdAt;
    for (const job of jobs) {
      // The exact-attempt endpoint binds membership. GitHub's job schema makes
      // the redundant run_attempt property optional; reject a conflicting value.
      ensure(job.run_id === Number(input.runId) && (job.run_attempt === undefined || job.run_attempt === input.runAttempt) && job.head_sha === input.candidateSha, "job identity mismatch");
      ensure(job.status === "completed" && job.conclusion === "success", "job not successful");
      const ended = timestamp(job.completed_at); ensure(ended >= createdAt && ended <= now, "invalid evidence time"); completedAt = Math.max(completedAt, ended);
      const steps = list(job.steps).map(record); ensure(steps.length <= 100, "oversize steps");
      ensure(new Set(steps.map(s => s.name)).size === steps.length && new Set(steps.map(s => s.number)).size === steps.length, "duplicate steps");
      for (const required of p.requiredJobs.find(j => j.name === job.name)!.steps) {
        const step = steps.find(s => s.name === required);
        ensure(step?.status === "completed" && step.conclusion === "success", "required step not successful");
      }
      ensure(steps.every(s => s.status === "completed" && s.conclusion === "success"), "partial or failed steps");
    }
    ensure(now - completedAt <= p.maxAgeMs, "expired evidence");
    const artifacts = await pages(`/actions/runs/${input.runId}/artifacts`, "artifacts");
    const matches = artifacts.filter(a => a.name === `verrail-fixed-ci-${input.runId}-${input.runAttempt}`);
    ensure(matches.length === 1, "missing or duplicate report"); const artifact = matches[0]!;
    ensure(artifact.expired === false && timestamp(artifact.expires_at) > now, "expired artifact");
    ensure(Number.isSafeInteger(artifact.size_in_bytes) && Number(artifact.size_in_bytes) > 0 && Number(artifact.size_in_bytes) <= p.maxArchiveBytes, "oversize archive");
    const binding = record(artifact.workflow_run);
    ensure(binding.id === Number(input.runId) && binding.head_sha === input.candidateSha && binding.repository_id === p.repositoryId && binding.head_repository_id === p.repositoryId, "artifact identity mismatch");
    ensure(typeof artifact.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(artifact.digest), "missing archive digest");
    let download = await get(`/actions/artifacts/${positiveId(artifact.id)}/zip`);
    if (download.status === 302) {
      const location = download.headers.get("location"); ensure(location, "missing artifact location");
      let url: URL; try { url = new URL(location); } catch { fail("invalid artifact location"); }
      ensure(url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && p.artifactDownloadHosts.includes(url.hostname), "untrusted artifact location");
      download = await deps.publicGet(url.toString(), { method: "GET", redirect: "manual", credentials: "omit", signal });
    }
    ensure(download.status === 200 && !download.redirected, "artifact redirect or HTTP failure");
    const archive = await body(download, p.maxArchiveBytes);
    ensure(`sha256:${digest(archive)}` === artifact.digest, "archive hash mismatch");
    const entries = await deps.decodeReportArchive(archive, { fileName: REPORT_FILE, maxEntries: 1, maxUncompressedBytes: p.maxReportBytes, signal });
    ensure(entries.length === 1 && entries[0]!.name === REPORT_FILE && entries[0]!.bytes instanceof Uint8Array && entries[0]!.bytes.length <= p.maxReportBytes, "invalid archive entries");
    const reportBytes = entries[0]!.bytes;
    let parsed: unknown; try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportBytes)); } catch { fail("malformed report"); }
    const validation = reportSchema.safeParse(parsed); ensure(validation.success, "malformed report"); const report = validation.data;
    ensure(report.repository === p.repository && report.run.id === input.runId && report.run.attempt === input.runAttempt && report.candidate.sha === input.candidateSha, "report identity mismatch");
    const ref = `refs/heads/${run.head_branch}`;
    ensure(report.candidate.ref === ref && report.workflow.ref === `${p.repository}/${p.workflow.path}@${ref}`, "report ref mismatch");
    ensure(report.workflow.path === p.workflow.path && report.workflow.sha === p.workflow.sha && report.workflow.sha256 === p.workflow.sha256 && report.helper.path === p.helper.path && report.helper.sha256 === p.helper.sha256, "report trust mismatch");
    ensure(exactSet(report.checks.map(c => c.id), CHECKS) && report.checks.every(c => c.status === "passed"), "incomplete fixed checks");
    ensure(exactSet(report.unsupportedObligations, UNSUPPORTED), "unsupported obligation mismatch");
    const reportedJob = report.jobs[0]!;
    ensure(reportedJob.id === "candidate_verify" && reportedJob.result === "success", "report job mismatch");
    ensure(exactSet(reportedJob.steps.map(s => s.id), VERIFY_STEPS) && reportedJob.steps.every(s => s.outcome === "success" && s.conclusion === "success"), "report steps mismatch");
    // Receipt content is source-derived and has no collection wall-clock timestamp,
    // signed download URL, raw report, logs, caller verdict or CriterionProof fields.
    const receipt = {
      kind: "verrail.fixed-ci-observation" as const, schemaVersion: 1 as const,
      repository: p.repository, repositoryId: p.repositoryId, providerRunId: input.runId, providerAttempt: input.runAttempt,
      workflowExecutionSha: p.workflow.sha, testedCandidateSha: input.candidateSha,
      workflowPath: p.workflow.path, workflowSha256: p.workflow.sha256, helperSha256: p.helper.sha256,
      artifactId: String(artifact.id), archiveSha256: digest(archive), reportSha256: digest(reportBytes),
      verifiedAt: new Date(completedAt).toISOString(),
      reference: `https://github.com/${p.repository}/actions/runs/${input.runId}/attempts/${input.runAttempt}`,
      checks: CHECKS.map(id => ({ id, status: "passed" as const })), unsupportedObligations: [...UNSUPPORTED],
    };
    return { ...receipt, receiptSha256: digest(Buffer.from(JSON.stringify(receipt))) };
  }

  return {
    async read(raw: CollectionRequest) {
      const parsed = requestSchema.safeParse(raw); ensure(parsed.success, "invalid collection request");
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          collect(parsed.data, controller.signal),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GitHubCiReadError("timeout")); }, p.timeoutMs); }),
        ]);
      } catch (error) {
        if (error instanceof GitHubCiReadError) throw error;
        fail("provider or decoder failure");
      } finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
