import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { test } from "node:test";

test(process.env.VERRAIL_TEST_NATIVE_OPENCODE_IMAGE
  ? "native Linux OpenCode edits files through the sandboxed repository MCP tool"
  : "native Linux command supervisor executes, times out and cancels sandboxed commands", {
  skip: !process.env.VERRAIL_TEST_NATIVE_NODE_IMAGE && !process.env.VERRAIL_TEST_NATIVE_OPENCODE_IMAGE, timeout: 180_000,
}, async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const checked = (command, args, options = {}) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options });
    assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT);
  assert.match(JSON.parse(checked("docker", ["context", "inspect"]))[0].Endpoints.docker.Host, /^unix:\/\//);
  const arch = checked("docker", ["info", "--format", "{{.Architecture}}"]);
  const goarch = { aarch64: "arm64", arm64: "arm64", x86_64: "amd64", amd64: "amd64" }[arch];
  assert.ok(goarch);
  const opencode = Boolean(process.env.VERRAIL_TEST_NATIVE_OPENCODE_IMAGE);
  const image = process.env.VERRAIL_TEST_NATIVE_OPENCODE_IMAGE ?? process.env.VERRAIL_TEST_NATIVE_NODE_IMAGE;
  assert.equal(checked("docker", ["image", "inspect", image, "--format", "{{.Architecture}}"]), goarch);
  const name = `verrail-native-command-${randomUUID().slice(0, 8)}`;
  const directory = mkdtempSync(path.join(tmpdir(), name));
  try {
    checked("go", ["build", "-trimpath", "-o", path.join(directory, "sandbox"), "./cmd/repository-sandbox"], {
      cwd: path.join(root, "services/domain-api"), timeout: 120_000,
      env: { ...process.env, GOOS: "linux", GOARCH: goarch, CGO_ENABLED: "0" },
    });
    await build({ entryPoints: [path.join(root, `scripts/smoke/fixtures/repository-${opencode ? "opencode" : "command"}-native.ts`)],
      outfile: path.join(directory, "fixture.mjs"), bundle: true, platform: "node", target: "node24", format: "esm" });
    const result = checked("docker", ["run", "--rm", "--pull=never", "--init", "--name", name,
      "--user", "1000:1000", "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--network=none",
      "--pids-limit=128", "--memory=1g", "--tmpfs", "/work:rw,uid=1000,gid=1000,mode=0700,size=16m",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
      "--mount", `type=bind,src=${path.join(directory, "sandbox")},dst=/usr/local/bin/repository-sandbox,readonly`,
      "--mount", `type=bind,src=${path.join(directory, "fixture.mjs")},dst=/fixture.mjs,readonly`,
      "--entrypoint", "node", image, "/fixture.mjs"]);
    assert.equal(result, opencode ? "REPOSITORY_NATIVE_OPENCODE_PASS" : "REPOSITORY_NATIVE_COMMAND_PASS");
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
