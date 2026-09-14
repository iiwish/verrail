import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("pinned Temporal image runs non-root and rejects absent database credentials", {
  skip: !process.env.VERRAIL_TEST_TEMPORAL_IMAGE,
}, () => {
  const image = process.env.VERRAIL_TEST_TEMPORAL_IMAGE;
  const run = (args) => spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--platform", "linux/amd64", ...args], {
    encoding: "utf8", timeout: 30_000,
  });
  const server = run(["--entrypoint", "temporal-server", image, "--version"]);
  assert.equal(server.status, 0, server.stderr);
  assert.match(server.stdout, /temporal version 1\.30\.1/);
  const sql = run(["--entrypoint", "temporal-sql-tool", image, "--version"]);
  assert.equal(sql.status, 0, sql.stderr);
  assert.match(sql.stdout, /1\.30\.1/);
  const uid = run(["--entrypoint", "id", image, "-u"]);
  assert.equal(uid.status, 0, uid.stderr);
  assert.equal(uid.stdout.trim(), "1000");
  const startup = run([image, "server"]);
  assert.equal(startup.status, 1);
  assert.equal(startup.stderr.trim(), "Temporal configuration or operation failed");
});
