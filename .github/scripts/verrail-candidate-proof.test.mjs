import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createReport, createGoTestValidator, REQUIRED_GO_TESTS, REQUIRED_STEPS, serializeReport, stopOwnedGoProcessGroup } from "./verrail-candidate-proof.mjs";

const sha = "a".repeat(40);
const ref = "refs/heads/codex/g2-7-candidate-t037";
function input() {
  return {
    repository: "iiwish/verrail", eventName: "push", candidateSha: sha, checkoutSha: sha,
    candidateRef: ref, workflowSha: sha,
    workflowRef: `iiwish/verrail/.github/workflows/verrail-candidate-verify.yml@${ref}`,
    workflowContent: "workflow fixture", helperContent: "helper fixture",
    runId: "123456789", runAttempt: "2", jobResult: "success",
    steps: Object.fromEntries(REQUIRED_STEPS.map(id => [id, { outcome: "success", conclusion: "success" }])),
  };
}

test("fixed CI report binds full identities, real steps and exactly four checks", () => {
  const report = createReport(input());
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "verrail.fixed-ci");
  assert.deepEqual(report.candidate, { sha, ref });
  assert.deepEqual(report.run, { id: "123456789", attempt: 2 });
  assert.equal(report.workflow.sha, sha);
  assert.match(report.workflow.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(report.workflow.sha256, report.helper.sha256);
  assert.deepEqual(report.checks, ["ts_tests", "ts_typecheck", "ts_build", "go_tests"].map(id => ({ id, status: "passed" })));
  assert.equal(report.jobs[0].id, "candidate_verify");
  assert.equal(report.jobs[0].steps.length, REQUIRED_STEPS.length);
  assert.deepEqual(report.unsupportedObligations, ["live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"]);
  assert.ok(Buffer.byteLength(serializeReport(report)) < 16384);
});

for (const [field, value] of [
  ["repository", "paperclipai/paperclip"], ["eventName", "pull_request_target"],
  ["candidateSha", "a".repeat(7)], ["checkoutSha", "b".repeat(40)],
  ["workflowSha", "b".repeat(40)], ["candidateRef", "refs/heads/master"],
  ["candidateRef", "refs/tags/codex/g2-7-candidate-x"], ["candidateRef", "refs/heads/codex/g2-7-candidate-"],
  ["workflowRef", "attacker/repo/.github/workflows/verrail-candidate-verify.yml@main"],
  ["runId", "0"], ["runId", "1e3"], ["runAttempt", "0"], ["runAttempt", "1.5"],
  ["jobResult", "in_progress"], ["steps", {}], ["workflowContent", ""], ["helperContent", ""],
]) {
  test(`rejects invalid ${field} ${JSON.stringify(value)}`, () => {
    assert.throws(() => createReport({ ...input(), [field]: value }));
  });
}

for (const outcome of ["failure", "skipped", "cancelled"]) {
  test(`does not turn ${outcome} into passed checks`, () => {
    const value = input();
    value.steps.ts_tests = { outcome, conclusion: outcome };
    value.jobResult = outcome === "skipped" ? "failure" : outcome;
    const report = createReport(value);
    assert.equal(report.jobs[0].result, value.jobResult);
    assert.ok(report.checks.every(check => check.status === "failed"));
  });
}

test("rejects success job with failed or masked step and missing coverage", () => {
  for (const mutation of [
    value => { value.steps.ts_tests.outcome = "failure"; },
    value => { delete value.steps.go_tests; },
    value => { value.steps.ts_tests.conclusion = "skipped"; },
    value => { value.steps.ts_tests.outcome = "unknown"; },
  ]) {
    const value = input(); mutation(value);
    assert.throws(() => createReport(value));
  }
});

test("bounds inputs and excludes step outputs and arbitrary assertions", () => {
  const value = input();
  value.steps.ts_tests.outputs = { secret: "do-not-copy" };
  value.assertions = ["live_recovery"];
  assert.doesNotMatch(serializeReport(createReport(value)), /do-not-copy|assertions/);
  assert.throws(() => createReport({ ...input(), workflowContent: "x".repeat(262145) }));
  assert.throws(() => serializeReport({ enormous: "x".repeat(16384) }));
});

test("workflow is bounded, SHA-pinned, pre-PR candidate-only and least privilege", () => {
  const workflow = readFileSync(new URL("../workflows/verrail-candidate-verify.yml", import.meta.url), "utf8");
  assert.match(workflow, /push:\n\s+branches:\n\s+- 'codex\/g2-7-candidate-\*'/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|pull_request|secrets\.|write-all|contents: write|id-token:|persist-credentials: true|continue-on-error|--no-frozen-lockfile|pnpm (?:publish|release)|git push/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.equal([...workflow.matchAll(/persist-credentials: false/g)].length, 2);
  assert.equal([...workflow.matchAll(/github\.repository == 'iiwish\/verrail'/g)].length, 2);
  assert.equal([...workflow.matchAll(/runs-on: ubuntu-24\.04/g)].length, 2);
  for (const line of workflow.split("\n").filter(line => line.includes("uses:"))) {
    assert.match(line, /uses: [\w/-]+@[a-f0-9]{40} # v[0-9.]+$/);
  }
  for (const id of REQUIRED_STEPS) assert.match(workflow, new RegExp(`id: ${id}\\n`));
  for (const command of ["pnpm install --frozen-lockfile", "pnpm -r typecheck", "pnpm test:run", "pnpm build", "startEmbeddedPostgresTestDatabase", "VERRAIL_TEST_DATABASE_URL: database.connectionString", "VERRAIL_TEST_TEMPORAL_ADDRESS: address", "createGoTestValidator(testPackages)"]) assert.ok(workflow.includes(command), command);
  assert.match(workflow, /node-version: '24\.20\.0'/);
  assert.match(workflow, /go-version: '1\.26\.0'/);
  assert.match(workflow, /needs: candidate_verify/);
  assert.match(workflow, /VERIFY_RESULT: \$\{\{ needs\.candidate_verify\.result \}\}/);
  assert.match(workflow, /STEPS_JSON: \$\{\{ toJSON\(steps\) \}\}/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: 7/);
  assert.match(workflow, /detached: true/);
  assert.match(workflow, /stopOwnedGoProcessGroup\(child\?\.pid\)/);
  assert.match(workflow, /const cleanupFailures = \[\]/);
  assert.match(workflow, /Isolated candidate PostgreSQL\/Temporal cleanup completed/);
  assert.doesNotMatch(workflow, /temporalStarted/);
});

function goEvents() {
  const pkg = "github.com/verrail/verrail/services/domain-api/internal/orchestration";
  return [{ Action: "start", Package: pkg }, ...REQUIRED_GO_TESTS.flatMap(Test => [
    { Action: "run", Package: pkg, Test }, { Action: "pass", Package: pkg, Test },
  ]), { Action: "pass", Package: pkg }];
}

function checkGo(events, code = 0) {
  const validator = createGoTestValidator(["github.com/verrail/verrail/services/domain-api/internal/orchestration"]);
  for (const event of events) validator.observeLine(JSON.stringify(event));
  return validator.finish(code);
}

test("Go JSON gate requires complete packages and every named Temporal recovery test", () => {
  assert.deepEqual(checkGo(goEvents()), { packages: 1, tests: 3, skipped: 0, requiredRecoveryTests: 3 });
});

test("Go JSON gate rejects skip, failure, missing recovery, empty and truncated coverage", () => {
  for (const event of ["skip", "fail"]) {
    const events = goEvents(); events[2].Action = event;
    assert.throws(() => checkGo(events));
  }
  assert.throws(() => checkGo(goEvents(), 1));
  assert.throws(() => checkGo([]));
  assert.throws(() => checkGo(goEvents().slice(0, -1)));
  assert.throws(() => checkGo(goEvents().filter(e => e.Test !== REQUIRED_GO_TESTS[0])));
  assert.throws(() => checkGo(goEvents().filter((_, index) => index !== 2)));
  assert.throws(() => checkGo(goEvents().map(e => ({ ...e, Package: "unrelated/package" }))));
  assert.throws(() => checkGo([...goEvents(), goEvents()[2]]));
});

test("Go JSON gate rejects malformed/oversized events and empty/duplicate inventories", () => {
  assert.throws(() => createGoTestValidator([]));
  assert.throws(() => createGoTestValidator(["unrelated/package"]));
  const pkg = goEvents()[0].Package;
  assert.throws(() => createGoTestValidator([pkg, pkg]));
  const validator = createGoTestValidator([pkg]);
  assert.throws(() => validator.observeLine("not JSON"));
  assert.throws(() => validator.observeLine(" ".repeat(1048577)));
});

test("owned Go shutdown handles absent/exited processes and TERM success", async () => {
  const signals = [];
  await stopOwnedGoProcessGroup(undefined, { kill() { assert.fail("no process exists"); } });
  await stopOwnedGoProcessGroup(123, { kill(pid, signal) {
    assert.equal(pid, -123); signals.push(signal);
    if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
  }, sleep: async () => {} });
  assert.deepEqual(signals, ["SIGTERM", 0]);
});

test("owned Go shutdown escalates with bounded waits and preserves permission errors", async () => {
  const signals = []; let waits = 0;
  await assert.rejects(stopOwnedGoProcessGroup(123, { kill(pid, signal) {
    assert.equal(pid, -123); signals.push(signal);
  }, sleep: async ms => { assert.equal(ms, 100); waits += 1; } }), /ten seconds/);
  assert.equal(waits, 100);
  assert.equal(signals.filter(signal => signal === "SIGTERM").length, 1);
  assert.equal(signals.filter(signal => signal === "SIGKILL").length, 1);
  await assert.rejects(stopOwnedGoProcessGroup(123, { kill() {
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  } }), /denied/);
});
