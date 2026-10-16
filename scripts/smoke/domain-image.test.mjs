import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("domain image is non-root and both services require external credentials", {
  skip: !process.env.VERRAIL_TEST_DOMAIN_IMAGE,
}, () => {
  const image = process.env.VERRAIL_TEST_DOMAIN_IMAGE;
  const run = (args) => spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only",
    "--platform", "linux/amd64", ...args], { encoding: "utf8", timeout: 30_000 });
  const identity = run(["--entrypoint", "id", image, "-u"]);
  assert.equal(identity.status, 0, identity.stderr);
  assert.equal(identity.stdout.trim(), "1000");
  for (const service of ["domain-api", "orchestration-worker"]) {
    const executable = run(["--entrypoint", "test", image, "-x", `/usr/local/bin/${service}`]);
    assert.equal(executable.status, 0, executable.stderr);
    const missing = run([image, service]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.trim(), "Invalid runtime secret configuration");
  }
});
