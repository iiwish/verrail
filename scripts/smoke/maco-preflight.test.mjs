import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("local candidate configuration satisfies the unchanged maco policy checker", {
  skip: !process.env.VERRAIL_MACO_PREFLIGHT_PATH,
}, t => {
  const run = (command, args, options = {}) => spawnSync(command, args, {
    encoding: "utf8", timeout: 30_000, ...options,
  });
  const checked = (command, args, options) => {
    const result = run(command, args, options);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT);
  const context = JSON.parse(checked("docker", ["context", "inspect"]));
  assert.match(context[0].Endpoints.docker.Host, /^unix:\/\//);
  const images = {
    VERRAIL_CONTROL_IMAGE: "verrail-control-plane:local-check",
    VERRAIL_DOMAIN_IMAGE: "verrail-domain:local-check",
    VERRAIL_GATEWAY_IMAGE: "verrail-gateway:local-check",
    VERRAIL_TEMPORAL_IMAGE: "verrail-temporal:local-check",
  };
  const pinned = {};
  for (const [key, image] of Object.entries(images)) {
    const descriptor = JSON.parse(checked("docker", ["image", "inspect", "--format", "{{json .Descriptor}}", image]));
    assert.match(descriptor.digest, /^sha256:[a-f0-9]{64}$/);
    pinned[key] = `${image.split(":")[0]}@${descriptor.digest}`;
  }
  const env = { ...process.env, VERRAIL_PUBLIC_URL: "http://127.0.0.1:3271",
    VERRAIL_ALLOWED_HOSTNAMES: "127.0.0.1", VERRAIL_CHAT_MODEL: "fixture/test" };
  const directory = mkdtempSync(path.join(os.tmpdir(), "verrail-policy-fixture-"));
  const filename = path.join(directory, "compose.json");
  const check = (imageVariables, overlay = false, hostPaths = false) => {
    const args = ["compose", "-f", "docker/maco/compose.yaml"];
    if (overlay) args.push("-f", "docker/maco/bootstrap.compose.yaml");
    const config = checked("docker", [...args, "config", "--format", "json"], { env: { ...env, ...imageVariables } });
    writeFileSync(filename, config, { mode: 0o600 });
    const result = run("python3", [process.env.VERRAIL_MACO_PREFLIGHT_PATH, "--manifest", "deploy/maco.json",
      "--compose-json", filename, ...(hostPaths ? ["--check-host-paths"] : [])]);
    return { code: result.status, report: JSON.parse(result.stdout) };
  };
  try {
    for (const overlay of [false, true]) {
      assert.deepEqual(check(pinned, overlay), { code: 0, report: { ok: true, errors: [] } });
    }
    const unpinned = check(images);
    assert.equal(unpinned.code, 1);
    assert.equal(unpinned.report.ok, false);
    assert.equal(unpinned.report.errors.filter(error => error.includes("immutable image digest required")).length, 8);
    assert.notEqual(os.hostname(), "maco", "This is a local-only verification, not a host release check");
    const hostCheck = check(pinned, false, true);
    assert.equal(hostCheck.code, 1);
    assert.ok(hostCheck.report.errors.includes("Host path validation must run on maco"));
    t.diagnostic(`Local OCI indexes only, not published release references: ${JSON.stringify(pinned)}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
