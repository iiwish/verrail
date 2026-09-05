import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runner = path.join(repoRoot, "scripts", "run-verrail-acceptance.mjs");

function runAcceptanceRunner(portOverride) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "verrail-acceptance-runner-test-"));
  const fakeBin = path.join(fixtureRoot, "bin");
  const invocationLog = path.join(fixtureRoot, "invocation.json");
  const fakePnpm = path.join(fakeBin, process.platform === "win32" ? "pnpm.cmd" : "pnpm");

  try {
    mkdirSync(fakeBin, { recursive: true });
    if (process.platform === "win32") {
      writeFileSync(
        fakePnpm,
        "@echo off\r\nnode -e \"require('fs').writeFileSync(process.env.VERRAIL_FAKE_PNPM_LOG, JSON.stringify({ port: process.env.VERRAIL_ACCEPTANCE_PORT, home: process.env.PAPERCLIP_HOME }))\"\r\n",
      );
    } else {
      writeFileSync(
        fakePnpm,
        "#!/bin/sh\nnode -e 'require(\"fs\").writeFileSync(process.env.VERRAIL_FAKE_PNPM_LOG, JSON.stringify({ port: process.env.VERRAIL_ACCEPTANCE_PORT, home: process.env.PAPERCLIP_HOME }))'\n",
      );
      chmodSync(fakePnpm, 0o755);
    }

    const env = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      VERRAIL_FAKE_PNPM_LOG: invocationLog,
    };
    if (portOverride === undefined) {
      delete env.VERRAIL_ACCEPTANCE_PORT;
    } else {
      env.VERRAIL_ACCEPTANCE_PORT = portOverride;
    }

    const result = spawnSync(process.execPath, [runner], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr);

    const invocation = JSON.parse(readFileSync(invocationLog, "utf8"));
    return {
      invocation,
      homeExistsAfterExit: existsSync(invocation.home),
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("default execution propagates an allocated loopback port and cleans its home", () => {
  const { invocation, homeExistsAfterExit } = runAcceptanceRunner();
  const port = Number(invocation.port);

  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, "runner must assign a valid port");
  assert.equal(homeExistsAfterExit, false);
});

test("an explicit acceptance port is preserved", () => {
  const { invocation, homeExistsAfterExit } = runAcceptanceRunner("43123");

  assert.equal(invocation.port, "43123");
  assert.equal(homeExistsAfterExit, false);
});
