import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { test } from "node:test";

test("native Linux source scratch is private and kernel quota enforced", {
  skip: !process.env.VERRAIL_TEST_NATIVE_NODE_IMAGE, timeout: 90_000,
}, async () => {
  const checked = (args) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT);
  assert.match(JSON.parse(checked(["context", "inspect"]))[0].Endpoints.docker.Host, /^unix:\/\//);
  const arch = checked(["info", "--format", "{{.Architecture}}"]);
  const native = { aarch64: "arm64", arm64: "arm64", x86_64: "amd64", amd64: "amd64" }[arch];
  const image = process.env.VERRAIL_TEST_NATIVE_NODE_IMAGE;
  assert.ok(native);
  assert.equal(checked(["image", "inspect", image, "--format", "{{.Architecture}}"]), native);
  const name = `verrail-scratch-${randomUUID().slice(0, 8)}`;
  const directory = mkdtempSync(path.join(tmpdir(), name));
  try {
    await build({ entryPoints: [fileURLToPath(new URL("./fixtures/repository-scratch-native.ts", import.meta.url))],
      outfile: path.join(directory, "fixture.mjs"), bundle: true, platform: "node", target: "node24", format: "esm" });
    const output = checked(["run", "--rm", "--pull=never", "--name", name, "--user", "1000:1000",
      "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--network=none",
      "--pids-limit=32", "--memory=128m", "--tmpfs", "/scratch:rw,uid=1000,gid=1000,mode=0700,size=16m",
      "--tmpfs", "/oversized:rw,uid=1000,gid=1000,mode=0700,size=1g",
      "--tmpfs", "/tmp:rw,mode=1777,size=16m",
      "--mount", `type=bind,src=${path.join(directory, "fixture.mjs")},dst=/fixture.mjs,readonly`,
      "--entrypoint", "node", image, "/fixture.mjs"]);
    assert.equal(output, "REPOSITORY_SCRATCH_PASS");
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
