import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "vendor-paperclip-runner.mjs",
);

test("vendors root and testing outputs while removing stale files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "paperclip-runner-vendor-"));
  try {
    const runnerDist = join(scratch, "runner-dist");
    const serverDist = join(scratch, "server-dist");
    mkdirSync(runnerDist, { recursive: true });
    mkdirSync(join(serverDist, "vendor/paperclip-runner"), { recursive: true });
    writeFileSync(
      join(runnerDist, "index.js"),
      "export const runtime = true;\n",
    );
    writeFileSync(
      join(runnerDist, "testing.js"),
      "export const testing = true;\n",
    );
    writeFileSync(
      join(serverDist, "vendor/paperclip-runner/stale.js"),
      "stale\n",
    );

    const result = invoke(runnerDist, serverDist);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(
        join(serverDist, "vendor/paperclip-runner/index.js"),
        "utf8",
      ),
      "export const runtime = true;\n",
    );
    assert.equal(
      readFileSync(
        join(serverDist, "vendor/paperclip-runner/testing.js"),
        "utf8",
      ),
      "export const testing = true;\n",
    );
    assert.equal(
      existsSync(join(serverDist, "vendor/paperclip-runner/stale.js")),
      false,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("fails before replacing an existing vendor when the runner build is absent", () => {
  const scratch = mkdtempSync(join(tmpdir(), "paperclip-runner-vendor-"));
  try {
    const runnerDist = join(scratch, "missing-runner-dist");
    const serverDist = join(scratch, "server-dist");
    mkdirSync(join(serverDist, "vendor/paperclip-runner"), { recursive: true });
    const existing = join(serverDist, "vendor/paperclip-runner/index.js");
    writeFileSync(existing, "existing\n");

    const result = invoke(runnerDist, serverDist);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /paperclip-runner build output is missing/);
    assert.equal(readFileSync(existing, "utf8"), "existing\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function invoke(runnerDist, serverDist) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PAPERCLIP_RUNNER_DIST: runnerDist,
      PAPERCLIP_SERVER_DIST: serverDist,
    },
  });
}
