import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("repository entrypoint excludes concurrent containers and releases its lock", {
  skip: !process.env.VERRAIL_TEST_REPOSITORY_IMAGE, timeout: 120_000,
}, async () => {
  const docker = args => spawnSync("docker", args, { encoding: "utf8", timeout: 20_000 });
  const checked = args => {
    const result = docker(args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT);
  const context = JSON.parse(checked(["context", "inspect"]));
  assert.match(context[0].Endpoints.docker.Host, /^unix:\/\//);
  const image = process.env.VERRAIL_TEST_REPOSITORY_IMAGE;
  checked(["image", "inspect", image]);
  const version = checked(["run", "--rm", "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--entrypoint", "opencode", image, "--version"]);
  assert.equal(version, "1.17.13");
  checked(["run", "--rm", "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--entrypoint", "node", image,
    "--input-type=module", "-e", `
      import { access } from 'node:fs/promises';
      for (const file of ['repository-execution-main', 'repository-dispatch-worker', 'repository-dispatch-health', 'repository-bound-source', 'repository-container-command']) {
        await access('/app/server/dist/execution/' + file + '.js');
      }
      await access('/usr/bin/ssh');
      if (process.getuid() !== 1000) throw new Error('Unexpected executor user');
    `]);
  const name = `verrail-repository-lock-${randomUUID().slice(0, 8)}`;
  const directory = mkdtempSync(path.join(tmpdir(), name));
  const probe = path.join(directory, "python3");
  // Replace only the post-lock payload, not the image's actual entrypoint/flock.
  writeFileSync(probe, '#!/bin/sh\nprintf "LOCK_PAYLOAD_STARTED\\n"\nexec sleep "${VERRAIL_FIXTURE_HOLD_SECONDS:-0}"\n', { mode: 0o755 });
  const names = [`${name}-first`, `${name}-second`, `${name}-third`];
  let volumeCreated = false;
  try {
    checked(["volume", "create", name]);
    volumeCreated = true;
    // Ownership changes are restricted to this fresh, fixture-owned empty volume.
    checked(["run", "--rm", "--pull=never", "--network=none", "--read-only", "--user", "0:0",
      "--mount", `type=volume,src=${name},dst=/runtime`, "--entrypoint", "chown", image, "1000:1000", "/runtime"]);
    const args = (container, hold) => ["run", "--pull=never", "--init", "--name", container,
      "--network=none", "--read-only", "--user", "1000:1000", "--cap-drop=ALL", "--security-opt", "no-new-privileges",
      "--pids-limit=32", "--memory=128m", "--mount", `type=volume,src=${name},dst=/var/lib/verrail-repository`,
      "--mount", `type=bind,src=${probe},dst=/usr/local/bin/python3,readonly`,
      "--env", `VERRAIL_FIXTURE_HOLD_SECONDS=${hold}`];
    checked([...args(names[0], 60), "-d", image]);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (checked(["logs", names[0]]).includes("LOCK_PAYLOAD_STARTED")) { ready = true; break; }
      await delay(100);
    }
    assert.ok(ready, "First entrypoint never acquired the lock");
    const second = docker([...args(names[1], 0), image]);
    assert.equal(second.status, 1, second.stderr || second.stdout);
    assert.ok(!second.stdout.includes("LOCK_PAYLOAD_STARTED"), "Concurrent payload ran without exclusive ownership");
    checked(["stop", "--time", "2", names[0]]);
    assert.equal(checked([...args(names[2], 0), image]), "LOCK_PAYLOAD_STARTED");
  } finally {
    for (const container of names) docker(["rm", "-f", container]);
    if (volumeCreated) checked(["volume", "rm", name]);
    rmSync(directory, { recursive: true, force: true });
  }
});
