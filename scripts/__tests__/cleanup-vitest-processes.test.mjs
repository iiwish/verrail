import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupVitestProcessSessions, selectVitestProcessSessions } from "../cleanup-vitest-processes.mjs";

test("matches only Node supervisors inside the exact isolated test root", () => {
  const root = "/private/tmp/pcvt-123-1-ABC123";
  const script = `${root}/t/paperclip-acpx-skills-one/remote/.paperclip-runtime/acpx/process-sessions/paperclip-process-session-remote.mjs`;
  assert.deepEqual(selectVitestProcessSessions(root, [
    `1 node ${script}`, `2 /usr/local/bin/node ${script}`,
    `3 node ${script.replace("ABC123", "ABC123-other")}`,
    "4 node /workspace/server.js", `5 sh -c node ${script}`,
    `6 node ${script} --extra`, `7 node ${script.replace("paperclip-", "unrelated-")}`,
    `8 node ${script.replace("/acpx/", "/claude_local/")}`,
    `9 node ${script.replace("/acpx/", "/codex_local/")}`,
    `10 node ${script.replace("remote/", "../../../../outside/")}`,
  ].join("\n")), [1, 2, 8, 9]);
  assert.throws(() => selectVitestProcessSessions("/", ""), /isolated pcvt/);
  assert.throws(() => selectVitestProcessSessions("relative/pcvt-123-1-ABC123", ""), /isolated pcvt/);
});

test("terminates a real fixture supervisor without touching an unrelated child", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), `pcvt-${process.pid}-1-`));
  const script = path.join(root, "t/paperclip-process-session-one/.paperclip-runtime/acpx/process-sessions/paperclip-process-session-remote.mjs");
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, "console.log('ready'); setInterval(() => {}, 1000);\n");
  const fixture = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await once(fixture.stdout, "data");
    const ended = once(fixture, "exit");
    assert.deepEqual(cleanupVitestProcessSessions(root), [fixture.pid]);
    const [, signal] = await ended;
    assert.equal(signal, "SIGTERM");
    assert.doesNotThrow(() => process.kill(other.pid, 0));
  } finally {
    if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
    const otherEnded = once(other, "exit");
    other.kill();
    await otherEnded;
    rmSync(root, { recursive: true, force: true });
  }
});
