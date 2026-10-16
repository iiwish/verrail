import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runRepositoryCommand } from "../../../server/src/execution/repository-command.js";

const run = (command: string, signal = new AbortController().signal, timeoutSeconds = 10) =>
  runRepositoryCommand({ launcher: "/usr/local/bin/repository-sandbox", cwd: "/work",
    input: { command, timeoutSeconds }, signal });

assert.deepEqual(await run("printf verified > generated.txt; cat generated.txt"),
  { exitCode: 0, stdout: "verified", stderr: "" });
assert.equal(await readFile("/work/generated.txt", "utf8"), "verified");
assert.notEqual((await run("cat /etc/passwd")).exitCode, 0);
assert.equal((await run("node -e 'require(\"fs\").writeFileSync(\"node-output.txt\", \"written\")'")).exitCode, 0);
assert.equal(await readFile("/work/node-output.txt", "utf8"), "written");
assert.equal((await run("sleep 30 & echo $! > background.pid; exit 0")).exitCode, 0);
const backgroundPid = Number((await readFile("/work/background.pid", "utf8")).trim());
assert.ok(Number.isSafeInteger(backgroundPid) && backgroundPid > 1);
assert.throws(() => process.kill(backgroundPid, 0), { code: "ESRCH" });
await assert.rejects(run("sleep 30", undefined, 1), /REPOSITORY_COMMAND_TIMEOUT/);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 250);
try {
  await assert.rejects(run("sleep 30", controller.signal), /REPOSITORY_COMMAND_CANCELED/);
} finally { clearTimeout(timer); }
console.log("REPOSITORY_NATIVE_COMMAND_PASS");
