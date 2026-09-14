import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Temporal uses limited roles and isolated schemas in one project database", {
  skip: !process.env.VERRAIL_TEST_TEMPORAL_IMAGE || !process.env.VERRAIL_TEST_POSTGRES_IMAGE,
  timeout: 360_000,
}, async () => {
  const docker = (args, options = {}) => spawnSync("docker", args, { encoding: "utf8", timeout: 60_000, ...options });
  const checked = (args, options) => {
    const result = docker(args, options);
    assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const context = JSON.parse(checked(["context", "inspect"]));
  assert.match(context[0].Endpoints.docker.Host, /^unix:\/\//, "Only a local Docker daemon is allowed");
  const name = "verrail-temporal-fixture-" + randomUUID().slice(0, 8);
  const directory = mkdtempSync(path.join(os.tmpdir(), name));
  const password = randomUUID();
  const temporal = process.env.VERRAIL_TEST_TEMPORAL_IMAGE;
  const workflows = process.env.VERRAIL_TEST_TEMPORAL_WORKFLOWS === "1";
  const common = ["--platform", "linux/amd64", "--network", name, "--read-only", "--tmpfs", "/tmp:rw,mode=1777"];
  try {
    checked(["network", "create", ...(workflows ? [] : ["--internal"]), name]);
    checked(["run", "-d", "--name", name + "-db", "--network", name, "--network-alias", "postgresql",
      "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_PASSWORD", process.env.VERRAIL_TEST_POSTGRES_IMAGE], {
      env: { ...process.env, POSTGRES_PASSWORD: password },
    });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (docker(["exec", name + "-db", "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, "Fixture PostgreSQL did not start");
    const psql = input => checked(["exec", "-i", name + "-db", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], { input });
    psql(`CREATE ROLE verrail_test_migrator LOGIN PASSWORD '${password}';
      CREATE ROLE verrail_test_app LOGIN PASSWORD '${password}';
      CREATE DATABASE verrail_test OWNER verrail_test_migrator;
      REVOKE ALL ON DATABASE verrail_test FROM PUBLIC;
      GRANT CONNECT ON DATABASE verrail_test TO verrail_test_app;`);
    const control = process.env.VERRAIL_TEST_CONTROL_IMAGE;
    if (!control) psql(`\\connect verrail_test
      SET ROLE verrail_test_migrator;
      CREATE SCHEMA verrail_temporal;
      CREATE SCHEMA verrail_visibility;
      GRANT USAGE ON SCHEMA verrail_temporal, verrail_visibility TO verrail_test_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA verrail_temporal GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO verrail_test_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA verrail_visibility GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO verrail_test_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA verrail_temporal GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO verrail_test_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA verrail_visibility GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO verrail_test_app;`);
    for (const role of ["migrator", "app"]) {
      // These are random fixture-only credentials on an internal disposable network.
      writeFileSync(path.join(directory, role + ".env"), `PGHOST=postgresql\nPGPORT=5432\nPGDATABASE=verrail_test\nPGUSER=verrail_test_${role}\nPGPASSWORD=${password}\n`, { mode: 0o644 });
    }
    const mount = role => ["--mount", `type=bind,source=${path.join(directory, role + ".env")},target=/run/postgres.env,readonly`, "-e", "VERRAIL_POSTGRES_ENV_FILE=/run/postgres.env"];
    if (control) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        checked(["run", "--rm", ...common, ...mount("migrator"), control,
          "node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "/app/server/maco-migrate.mjs"], { timeout: 90_000 });
      }
      const table = psql(`\\connect verrail_test
        SELECT to_regclass('public.verrail_conversation_invocations');
        SELECT has_schema_privilege('verrail_test_app', 'public', 'CREATE');`);
      assert.match(table, /verrail_conversation_invocations/);
      assert.match(table, /\n f\s*\n/);
      const bootstrap = ["run", "--rm", "-i", ...common, ...mount("migrator"),
        "-e", "PAPERCLIP_AUTH_DISABLE_SIGN_UP=true", control,
        "node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "/app/server/dist/first-operator-main.js"];
      const input = JSON.stringify({ name: "Fixture Operator", email: "operator@example.test", password: randomUUID() });
      const created = JSON.parse(checked(bootstrap, { input }));
      assert.equal(created.status, "created");
      assert.match(created.userId, /^[a-f0-9-]{36}$/);
      assert.deepEqual(JSON.parse(checked(bootstrap, { input })), { status: "already_initialized" });
      const wrongRole = docker(["run", "--rm", "-i", ...common, ...mount("app"),
        "-e", "PAPERCLIP_AUTH_DISABLE_SIGN_UP=true", control,
        "node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "/app/server/dist/first-operator-main.js"], { input });
      assert.equal(wrongRole.status, 1);
      assert.match(wrongRole.stderr, /^First operator bootstrap failed\s*$/);
      assert.equal(wrongRole.stdout, "");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      checked(["run", "--rm", ...common, ...mount("migrator"), temporal, "migrate"], { timeout: 90_000 });
    }
    checked(["run", "-d", "--name", name + "-server", "--network-alias", "temporal",
      ...(workflows ? ["-p", "127.0.0.1::7233"] : []), ...common, ...mount("app"), temporal, "server"]);
    ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (docker(["exec", name + "-server", "temporal", "operator", "cluster", "health", "--address", "127.0.0.1:7233", "--command-timeout", "2s"]).status === 0) { ready = true; break; }
      const running = checked(["inspect", "--format", "{{.State.Running}}", name + "-server"]);
      assert.equal(running, "true", checked(["logs", name + "-server"]));
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, "Temporal health did not become ready");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      checked(["run", "--rm", ...common, temporal, "namespace"]);
    }
    checked(["restart", "--time", "10", name + "-server"]);
    ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (docker(["exec", name + "-server", "temporal", "operator", "namespace", "describe", "--address", "127.0.0.1:7233", "--namespace", "verrail-test", "--command-timeout", "2s"]).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, "Persisted namespace was not available after Temporal restart");
    if (workflows) {
      checked(["exec", name + "-server", "temporal", "operator", "namespace", "create",
        "--address", "127.0.0.1:7233", "--namespace", "default"]);
      const ports = JSON.parse(checked(["inspect", "--format", "{{json .NetworkSettings.Ports}}", name + "-server"]));
      const binding = ports["7233/tcp"];
      assert.equal(binding.length, 1);
      assert.equal(binding[0].HostIp, "127.0.0.1");
      assert.match(binding[0].HostPort, /^\d+$/);
      const result = spawnSync("go", ["test", "./internal/orchestration", "-count=1", "-v",
        "-run", "^(TestFailedRunRecoveryUsesAuthoritativeObserverAndReplaysHistory|TestTargetWorkflowSurvivesWorkerRestartAndReplaysLiveHistory|TestRunWorkflowSurvivesWorkerRestartAndReplaysLiveHistory)$"], {
        cwd: path.resolve("services/domain-api"), encoding: "utf8", timeout: 150_000,
        env: { ...process.env, VERRAIL_TEST_TEMPORAL_ADDRESS: `127.0.0.1:${binding[0].HostPort}` },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal((result.stdout.match(/--- PASS:/g) ?? []).length, 3, result.stdout);
      assert.doesNotMatch(result.stdout, /--- SKIP:/);
      process.stdout.write(result.stdout);
    }
    const state = psql(`\\connect verrail_test
      SELECT curr_version FROM verrail_temporal.schema_version;
      SELECT curr_version FROM verrail_visibility.schema_version;
      DO $$ BEGIN
        IF (SELECT count(*) FROM pg_stat_activity WHERE usename = 'verrail_test_app') > 8 THEN
          RAISE EXCEPTION 'Temporal exceeds its proposed connection allocation';
        END IF;
      END $$;
      SELECT nspname FROM pg_namespace WHERE nspname LIKE 'verrail_%' ORDER BY nspname;`);
    assert.match(state, /verrail_temporal/);
    assert.match(state, /verrail_visibility/);
  } finally {
    docker(["rm", "-f", name + "-server", name + "-db"]);
    docker(["network", "rm", name]);
    rmSync(directory, { recursive: true, force: true });
  }
});
