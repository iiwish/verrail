import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("gateway image runs pinned OpenCode non-root and fails closed without secrets", {
  skip: !process.env.VERRAIL_TEST_GATEWAY_IMAGE,
}, () => {
  const image = process.env.VERRAIL_TEST_GATEWAY_IMAGE;
  const run = (args) => spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only",
    "--platform", "linux/amd64", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777",
    "--tmpfs", "/home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=700",
    "--tmpfs", "/var/lib/verrail-gateway:rw,nosuid,nodev,uid=1000,gid=1000,mode=700", ...args], {
    encoding: "utf8", timeout: 30_000,
  });
  const uid = run(["--entrypoint", "id", image, "-u"]);
  assert.equal(uid.status, 0, uid.stderr);
  assert.equal(uid.stdout.trim(), "1000");
  const version = run(["--entrypoint", "opencode", image, "--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "1.17.13");
  const missing = run([image]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), "Execution gateway failed to start");
});
