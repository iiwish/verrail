import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRepositoryCommand } from "./repository-command.js";

let root: string;
let launcher: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "verrail-command-test-"));
  launcher = join(root, "fixture-launcher");
  // This fixture tests process supervision only, not sandbox policy.
  await writeFile(launcher, '#!/bin/sh\ncd "$1" || exit 125\nshift\nexec "$@"\n', { mode: 0o700 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const run = (command: string, signal = new AbortController().signal, timeoutSeconds = 5) =>
  runRepositoryCommand({ launcher, cwd: root, input: { command, timeoutSeconds }, signal });
it("returns bounded command output and nonzero tool exit without inherited secrets", async () => {
  expect(await run("printf hello; printf diagnostic >&2; exit 7")).toEqual({ exitCode: 7, stdout: "hello", stderr: "diagnostic" });
  process.env.VERRAIL_FIXTURE_SECRET = "must-not-leak";
  try { expect((await run('printf "%s" "$VERRAIL_FIXTURE_SECRET"')).stdout).toBe(""); }
  finally { delete process.env.VERRAIL_FIXTURE_SECRET; }
});
it("fails closed when the mandatory launcher is missing", async () => {
  await rm(launcher);
  await expect(run("echo unsafe")).rejects.toThrow("REPOSITORY_COMMAND_START_FAILED");
});
it("stops excessive output and command deadlines", async () => {
  await expect(run(`exec "${process.execPath}" -e 'process.stdout.write(Buffer.alloc(2097152));setInterval(()=>{},1000)'`)).rejects.toThrow("REPOSITORY_COMMAND_OUTPUT_LIMIT");
  await expect(run("exec sleep 60", undefined, 1)).rejects.toThrow("REPOSITORY_COMMAND_TIMEOUT");
});
it("honors cancellation and does not start an already canceled command", async () => {
  const abort = new AbortController();
  const execution = run("sleep 60", abort.signal);
  const rejected = expect(execution).rejects.toThrow("REPOSITORY_COMMAND_CANCELED");
  abort.abort();
  await rejected;
  await expect(run("echo never", abort.signal)).rejects.toThrow();
});
