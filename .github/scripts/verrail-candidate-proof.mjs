import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const WORKFLOW_PATH = ".github/workflows/verrail-candidate-verify.yml";
export const HELPER_PATH = ".github/scripts/verrail-candidate-proof.mjs";
export const REQUIRED_STEPS = Object.freeze([
  "checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install",
  "proof_tests", "ts_typecheck", "ts_tests", "ts_build", "go_tests", "source_unchanged",
]);
const CHECKS = ["ts_tests", "ts_typecheck", "ts_build", "go_tests"];
const TERMINAL = new Set(["success", "failure", "cancelled", "skipped"]);
const SHA = /^[a-f0-9]{40}$/;
const CANDIDATE_REF = /^refs\/heads\/codex\/g2-7-candidate-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
export const REQUIRED_GO_TESTS = Object.freeze([
  "TestFailedRunRecoveryUsesAuthoritativeObserverAndReplaysHistory",
  "TestTargetWorkflowSurvivesWorkerRestartAndReplaysLiveHistory",
  "TestRunWorkflowSurvivesWorkerRestartAndReplaysLiveHistory",
]);

export async function stopOwnedGoProcessGroup(pid, {
  kill = (processId, signal) => process.kill(processId, signal),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (pid === undefined) return;
  requireValue(Number.isSafeInteger(pid) && pid > 0, "owned Go process ID");
  function signalGroup(signal) {
    try { kill(-pid, signal); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  }
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (!signalGroup(signal)) return;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await sleep(100);
      if (!signalGroup(0)) return;
    }
  }
  throw new Error("Owned Go process group did not stop within ten seconds");
}

export function createGoTestValidator(expectedPackages) {
  const prefix = "github.com/verrail/verrail/services/domain-api/";
  requireValue(Array.isArray(expectedPackages) && expectedPackages.length > 0 && expectedPackages.length <= 1000, "Go package inventory bound");
  requireValue(expectedPackages.every(pkg => typeof pkg === "string" && pkg.startsWith(prefix) && /^[a-zA-Z0-9_./-]+$/.test(pkg)), "Go package inventory scope");
  const packages = new Map(expectedPackages.map(pkg => [pkg, "pending"]));
  requireValue(packages.size === expectedPackages.length, "duplicate Go package inventory");
  const tests = new Map();
  let events = 0;
  return {
    observeLine(line) {
      requireValue(typeof line === "string" && Buffer.byteLength(line) <= 1048576 && ++events <= 1000000, "Go event bounds");
      const event = JSON.parse(line);
      requireValue(event && typeof event === "object" && packages.has(event.Package), "Go event package");
      requireValue(["start", "run", "pass", "output", "pause", "cont"].includes(event.Action), "Go failed, skipped or unknown event");
      const hasTest = event.Test !== undefined;
      requireValue(!hasTest || (typeof event.Test === "string" && event.Test.length > 0 && event.Test.length <= 4096), "Go test name");
      if (event.Action === "output") return;
      const map = hasTest ? tests : packages;
      const key = hasTest ? `${event.Package}:${event.Test}` : event.Package;
      const previous = map.get(key);
      if (event.Action === "start" || event.Action === "run") {
        requireValue((hasTest && event.Action === "run" && previous === undefined && packages.get(event.Package) === "running") || (!hasTest && event.Action === "start" && previous === "pending"), "Go duplicate or invalid start");
        map.set(key, "running");
      } else if (event.Action === "pass") {
        requireValue(previous === "running", "Go pass without active execution");
        map.set(key, "passed");
      } else {
        requireValue(hasTest && previous === "running", "Go pause/continue without active test");
      }
      requireValue(tests.size <= 100000, "Go test inventory bound");
    },
    finish(exitCode) {
      requireValue(exitCode === 0, "Go process failed");
      requireValue([...packages.values()].every(status => status === "passed"), "Go incomplete package coverage");
      requireValue(tests.size > 0 && [...tests.values()].every(status => status === "passed"), "Go empty or incomplete test coverage");
      requireValue(REQUIRED_GO_TESTS.every(name => tests.get(`${prefix}internal/orchestration:${name}`) === "passed"), "Go required recovery test coverage");
      return { packages: packages.size, tests: tests.size, skipped: 0, requiredRecoveryTests: REQUIRED_GO_TESTS.length };
    },
  };
}

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid fixed-CI proof: ${message}`);
}

function contentHash(content) {
  requireValue(typeof content === "string" && content.length > 0 && Buffer.byteLength(content) <= 262144, "source content bound");
  return createHash("sha256").update(content).digest("hex");
}

export function createReport(input) {
  requireValue(input.repository === "iiwish/verrail" && input.eventName === "push", "repository or event");
  requireValue(typeof input.candidateRef === "string" && CANDIDATE_REF.test(input.candidateRef), "candidate branch");
  requireValue(SHA.test(input.candidateSha) && input.candidateSha === input.checkoutSha, "full candidate SHA equality");
  // Push uses the candidate workflow revision; trust is independently pinned by the reader's content hashes.
  requireValue(SHA.test(input.workflowSha) && input.workflowSha === input.candidateSha, "workflow execution SHA");
  requireValue(input.workflowRef === `${input.repository}/${WORKFLOW_PATH}@${input.candidateRef}`, "workflow ref");
  requireValue(typeof input.runId === "string" && /^[1-9][0-9]{0,19}$/.test(input.runId), "run ID");
  requireValue(typeof input.runAttempt === "string" && /^[1-9][0-9]{0,5}$/.test(input.runAttempt), "run attempt");
  requireValue(TERMINAL.has(input.jobResult), "terminal job result");
  requireValue(input.steps && typeof input.steps === "object" && !Array.isArray(input.steps) && Object.keys(input.steps).length <= 32, "steps bound");
  const steps = REQUIRED_STEPS.map(id => {
    const step = input.steps[id];
    requireValue(step && TERMINAL.has(step.outcome) && TERMINAL.has(step.conclusion), `required step ${id}`);
    return { id, outcome: step.outcome, conclusion: step.conclusion };
  });
  const allSuccessful = steps.every(step => step.outcome === "success" && step.conclusion === "success");
  requireValue(input.jobResult !== "success" || allSuccessful, "success job with failed, skipped or masked step");
  return {
    schemaVersion: 1,
    kind: "verrail.fixed-ci",
    repository: input.repository,
    candidate: { sha: input.candidateSha, ref: input.candidateRef },
    workflow: { path: WORKFLOW_PATH, sha: input.workflowSha, ref: input.workflowRef, sha256: contentHash(input.workflowContent) },
    helper: { path: HELPER_PATH, sha256: contentHash(input.helperContent) },
    run: { id: input.runId, attempt: Number(input.runAttempt) },
    jobs: [{ id: "candidate_verify", result: input.jobResult, steps }],
    checks: CHECKS.map(id => ({ id, status: input.jobResult === "success" && allSuccessful ? "passed" : "failed" })),
    unsupportedObligations: ["live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"],
  };
}

export function serializeReport(report) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  requireValue(Buffer.byteLength(text) <= 16384, "report size");
  return text;
}

function main() {
  const env = process.env;
  requireValue(typeof env.VERIFY_STEPS === "string" && Buffer.byteLength(env.VERIFY_STEPS) <= 16384, "steps JSON bound");
  const report = createReport({
    repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME,
    candidateSha: env.GITHUB_SHA, checkoutSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    candidateRef: env.GITHUB_REF, workflowSha: env.GITHUB_WORKFLOW_SHA, workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowContent: readFileSync(WORKFLOW_PATH, "utf8"), helperContent: readFileSync(HELPER_PATH, "utf8"),
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    jobResult: env.VERIFY_RESULT, steps: JSON.parse(env.VERIFY_STEPS),
  });
  writeFileSync("verrail-fixed-ci.json", serializeReport(report), { flag: "wx" });
  if (report.jobs[0].result !== "success") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid fixed-CI proof");
    process.exitCode = 1;
  }
}
