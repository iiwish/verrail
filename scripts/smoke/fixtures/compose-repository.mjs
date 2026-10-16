import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export async function verifyComposeRepository({ checked, compose, name, userId, identity, diagnostic,
  queryDatabase, commandProcesses }) {
  const script = readFileSync("scripts/smoke/fixtures/compose-repository-command.mjs", "utf8");
  const call = (action, input) => JSON.parse(checked(compose("exec", "-T", "control-plane", "python3",
    "/usr/local/lib/verrail/runtime_env.py", "node", "--import", "./server/node_modules/tsx/dist/loader.mjs",
    "--input-type=module", "-", action, userId, identity.workspaceId, JSON.stringify(input)), { input: script }));
  const observations = () => JSON.parse(checked(["exec", `${name}-provider`, "node", "-e",
    "fetch('http://127.0.0.1:8080/observations').then(r=>r.text()).then(t=>process.stdout.write(t))"]));
  const sql = queryDatabase ?? (input => checked(["exec", "-i", `${name}-postgres`, "psql", "-U", "postgres", "-d", "verrail_test",
    "-v", "ON_ERROR_STOP=1"], { input }));
  const wait = async (read, predicate, label, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    let value;
    do {
      try {
        value = read();
        if (predicate(value)) return value;
      } catch (error) {
        value = { readError: error.message };
      }
      assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (true);
  };
  const processes = commandProcesses ?? (() => JSON.parse(checked(compose("exec", "-T", "repository-executor", "node", "-e",
    `const f=require('node:fs'); console.log(JSON.stringify(f.readdirSync('/proc').filter(n=>/^\\d+$/.test(n)).flatMap(n=>{try {const a=f.readFileSync('/proc/'+n+'/cmdline','utf8').split('\\0'); return a[0].endsWith('/sleep') || a[0]==='sleep' ? [{pid:n,args:a}]:[]}catch{return []}})))`))));
  const results = [];
  for (const mode of ["success", "cancel", "recovery"]) {
    const prepared = call("prepare", { mode });
    // Query real Temporal history, not a direct Activities call or DB state alone.
    const workflowId = `verrail-target-v1:${identity.workspaceId}:${prepared.targetId}`;
    const query = () => JSON.parse(checked(compose("exec", "-T", "temporal", "temporal", "workflow", "query",
      "--address", "127.0.0.1:7233", "--namespace", "verrail-test", "--workflow-id", workflowId,
      "--type", "verrail.target.state.v1", "--output", "json")));
    // Outbox delivery can lag briefly behind HTTP graph activation.
    await new Promise(resolve => setTimeout(resolve, 3000));
    const targetState = await wait(query, value => JSON.stringify(value).includes(prepared.workNodeId), "Temporal did not retain ready repository node");
    const run = call("start", prepared);
    const read = () => call("state", run);
    if (mode === "success") {
      const completed = await wait(read, value => ["succeeded", "failed", "canceled"].includes(value.state.run_status), "Repository did not finish");
      assert.equal(completed.state.run_status, "succeeded", JSON.stringify(completed));
      assert.equal(completed.state.attempt_status, "succeeded");
      assert.equal(completed.state.lease_status, "released");
      assert.equal(completed.state.dispatch_status, "succeeded");
      assert.equal(completed.bound.length, 1);
      assert.equal(completed.state.input.source.baseCommit, prepared.baseCommit);
      assert.ok(completed.events.some(event => event.event_type === "succeeded"));
      const artifact = call("verify-output", run);
      const before = observations().repositoryRequests;
      checked(compose("restart", "repository-executor", "repository-recovery"), { timeout: 90000 });
      await new Promise(resolve => setTimeout(resolve, 7000));
      assert.equal(observations().repositoryRequests, before, "Restart replayed successful repository execution");
      assert.equal(call("state", run).artifacts.length, 1);
      results.push({ mode, runId: run.runId, targetState, completed, artifact, modelRequestsBefore: before, modelRequestsAfter: before });
    } else {
      const running = await wait(read, value => value.state.tool_calls === 1 || ["failed", "canceled"].includes(value.state.run_status), "Native command was not admitted");
      assert.equal(running.state.run_status, "running", JSON.stringify(running));
      await wait(processes, value => value.some(proc => proc.args[1] === "47"), "Native sandbox sleep did not start", 15000);
      if (mode === "recovery") {
        checked(compose("stop", "repository-recovery"));
        // Fail terminal registration only in the disposable database. Authority
        // checks and runtime cleanup still execute in the unchanged services.
        sql(`CREATE FUNCTION fixture_reject_termination() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.event_type='terminated' AND NEW.run_id='${run.runId}'::uuid THEN
            RAISE EXCEPTION 'FIXTURE_TERMINATION_TRANSPORT_LOST'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER fixture_reject_termination BEFORE INSERT ON verrail_run_events
          FOR EACH ROW EXECUTE FUNCTION fixture_reject_termination();`);
      }
      call("cancel", run);
      let receipt;
      if (mode === "recovery") {
        receipt = await wait(read, value => value.state.dispatch_status === "canceled", "Cleanup receipt not persisted", 20000);
        assert.equal(receipt.state.run_status, "cancel_requested");
        assert.equal(receipt.state.lease_status, "active");
        assert.equal(processes().length, 0, "Cleanup receipt preceded child exit");
        const before = observations().repositoryRequests;
        sql("DROP TRIGGER fixture_reject_termination ON verrail_run_events; DROP FUNCTION fixture_reject_termination();");
        checked(compose("start", "repository-recovery"));
        const completed = await wait(read, value => value.state.run_status === "canceled", "Recovery did not acknowledge cleanup", 25000);
        assert.equal(observations().repositoryRequests, before, "Recovery repeated model execution");
        results.push({ mode, runId: run.runId, targetState, receipt, completed, modelRequestsBefore: before, modelRequestsAfter: before });
      } else {
        const completed = await wait(read, value => value.state.run_status === "canceled", "Cancellation did not complete", 20000);
        results.push({ mode, runId: run.runId, targetState, completed });
      }
      const { completed } = results.at(-1);
      assert.equal(completed.state.attempt_status, "canceled");
      assert.equal(completed.state.lease_status, "released");
      assert.equal(completed.state.dispatch_status, "canceled");
      assert.equal(completed.artifacts.length, 0);
      assert.ok(completed.events.some(event => event.event_type === "terminated"));
      assert.equal(processes().length, 0);
    }
    diagnostic(`Repository ${mode}: ${run.runId} passed`);
  }
  assert.deepEqual([...new Set(observations().repositoryTools)], ["repository_execute_command"]);
  return results;
}
