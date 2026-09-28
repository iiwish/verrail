import assert from "node:assert/strict";
import { spawn } from "node:child_process";

export async function sampleConnections(container, workload) {
  assert.match(container, /^verrail-compose-fixture-[a-f0-9]{8}-postgres$/);
  const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1"],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  let notifyReady;
  const ready = new Promise(resolve => { notifyReady = resolve; });
  child.stdout.on("data", chunk => {
    output += chunk;
    if (output.includes("READY\n")) notifyReady();
  });
  child.stderr.on("data", chunk => { errors += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Connection sampler failed: ${errors}`)));
  });
  // Refresh PostgreSQL's statistics snapshot for every observation in this DO block.
  child.stdin.end(`CREATE TEMP TABLE fixture_samples (connections integer);
    SELECT 'READY';
    DO $$ BEGIN FOR sample IN 1..900 LOOP
      PERFORM pg_stat_clear_snapshot();
      INSERT INTO fixture_samples SELECT count(*) FROM pg_stat_activity
        WHERE usename='verrail_test_app' AND datname='verrail_test';
      PERFORM pg_sleep(0.05);
    END LOOP; END $$;
    SELECT json_build_object('peak', max(connections), 'samples', count(*)) FROM fixture_samples;`);
  const timer = setTimeout(() => child.kill("SIGKILL"), 70_000);
  try {
    await Promise.race([ready, finished.then(() => { throw new Error("Sampler exited before readiness"); })]);
    await workload();
    await finished;
    return JSON.parse(output.trim().split("\n").at(-1));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await finished.catch(() => {});
  }
}
