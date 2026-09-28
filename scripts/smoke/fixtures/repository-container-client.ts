import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRepositoryContainerCommand, createRepositoryContainerTransport } from "../../../server/src/execution/repository-container-command.js";
import { assertRepositoryScratch } from "../../../server/src/execution/repository-scratch.js";

const checkoutRoot = "/var/lib/verrail-repository/workspaces";
await assertRepositoryScratch(checkoutRoot);
const config = JSON.parse(await readFile("/run/secrets/container-runner.json", "utf8"));
const transport = createRepositoryContainerTransport(config);
const runner = createRepositoryContainerCommand({ checkoutRoot, transport });
const root = await mkdtemp(join(checkoutRoot, "verrail-repository-ssh-"));
const cwd = join(root, "checkout");
await mkdir(cwd, { mode: 0o700 });
try {
  const result = await runner({ cwd, input: { command: "printf ssh-proof >/work/proof; printf ok", timeoutSeconds: 5 },
    signal: AbortSignal.timeout(20_000) });
  assert.deepEqual(result, { exitCode: 0, stdout: "ok", stderr: "" });
  assert.equal(await readFile(join(cwd, "proof"), "utf8"), "ssh-proof");
  await assert.rejects(runner({ cwd, input: { command: "sleep 30", timeoutSeconds: 1 },
    signal: AbortSignal.timeout(20_000) }), /REPOSITORY_COMMAND_TIMEOUT/);
  const controller = new AbortController();
  let started = false;
  const abortRunner = createRepositoryContainerCommand({ checkoutRoot, transport: async (packet, signal) => {
    const reply = await transport(packet, signal);
    if (packet.operation === "start" && (reply as { status: string }).status === "running") {
      started = true;
      controller.abort();
    }
    return reply;
  } });
  await assert.rejects(abortRunner({ cwd, input: { command: "sleep 30", timeoutSeconds: 10 },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) }),
  error => error instanceof Error && error.name === "AbortError");
  assert.ok(started, "Cancellation must exercise a confirmed running container");
  const after = await runner({ cwd, input: { command: "printf after-cancel", timeoutSeconds: 5 }, signal: AbortSignal.timeout(20_000) });
  assert.equal(after.stdout, "after-cancel");
  console.log(JSON.stringify({ status: "passed", checks: ["containerized-production-transport", "pinned-SSH-identity",
    "shared-bounded-checkout", "result", "timeout", "abort-cleanup", "command-after-cancel"] }));
} finally { await rm(root, { recursive: true, force: true }); }
