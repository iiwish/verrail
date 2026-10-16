import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("native Linux repository sandbox blocks sockets and filesystem escapes", {
  skip: !process.env.VERRAIL_TEST_SANDBOX_IMAGE, timeout: 180_000,
}, () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const checked = (command, args, options = {}) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, ...options });
    assert.equal(result.status, 0, `${command} ${args[0]} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const context = JSON.parse(checked("docker", ["context", "inspect"]));
  assert.match(context[0].Endpoints.docker.Host, /^unix:\/\//, "Only a local Docker daemon is allowed");
  const arch = checked("docker", ["info", "--format", "{{.Architecture}}"]);
  const goarch = { aarch64: "arm64", arm64: "arm64", x86_64: "amd64", amd64: "amd64" }[arch];
  assert.ok(goarch, "Unsupported native architecture");
  const image = process.env.VERRAIL_TEST_SANDBOX_IMAGE;
  assert.equal(checked("docker", ["image", "inspect", image, "--format", "{{.Architecture}}"]), goarch,
    "Kernel policy must be tested natively, not under CPU emulation");
  const name = `verrail-sandbox-fixture-${randomUUID().slice(0, 8)}`;
  const directory = mkdtempSync(path.join(tmpdir(), name));
  try {
    const env = { ...process.env, GOOS: "linux", GOARCH: goarch, CGO_ENABLED: "0" };
    checked("go", ["build", "-trimpath", "-o", path.join(directory, "sandbox"), "./cmd/repository-sandbox"], {
      cwd: path.join(root, "services/domain-api"), env, timeout: 120_000,
    });
    checked("go", ["build", "-trimpath", "-o", path.join(directory, "probe"), path.join(root, "scripts/smoke/fixtures/offline-sandbox-probe.go")], { env });
    const common = ["run", "--rm", "--pull=never", "--name", name, "--user", "1000:1000", "--read-only",
      "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--network=none", "--pids-limit=64", "--memory=128m",
      "--tmpfs", "/work:rw,uid=1000,gid=1000,mode=0700,size=16m", "--tmpfs", "/other:rw,uid=1000,gid=1000,mode=0700,size=1m",
      "--mount", `type=bind,src=${path.join(directory, "sandbox")},dst=/usr/local/bin/repository-sandbox,readonly`,
      "--mount", `type=bind,src=${path.join(directory, "probe")},dst=/usr/local/bin/repository-probe,readonly`];
    // Prove these paths are accessible without Landlock under the same Docker policy.
    checked("docker", [...common, "--entrypoint", "/bin/sh", image, "-c", "test -r /etc/passwd && touch /other/baseline"]);
    const output = checked("docker", [...common, "--entrypoint", "/usr/local/bin/repository-sandbox", image,
      "/work", "/usr/local/bin/repository-probe"]);
    assert.equal(output, "OFFLINE_SANDBOX_PROBE_PASS");
  } finally {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
