import { constants } from "node:fs";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { deliveryRuntimeConfigurationSchema, launchObservedNativeRuntime, launchObservedNodeRuntime } from "../src/services/verrail-runtime-observation.js";

// This entry is bundled outside the checkout. It carries no request-controlled
// code, profile, entrypoint or key; plugin stdio/IPC are transparent transports.
const fail = () => new Error("DELIVERY_RUNTIME_UNAVAILABLE");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let running: { stop(): Promise<void>; checkpoint(): Promise<unknown> } | undefined;
let closing = false;
async function close(code: number) {
  if (closing) return;
  closing = true;
  await running?.stop();
  process.exit(code);
}
try {
  if (process.execArgv.length || Object.keys(process.env).some(key => /^(NODE_(?!ENV$)|LD_|DYLD_)/.test(key) && process.env[key])) throw fail();
  const filename = process.env.VERRAIL_RUNTIME_OBSERVER_CONFIG;
  if (!filename || !path.isAbsolute(filename)) throw fail();
  const directory = await stat(path.dirname(filename));
  const configFile = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: unknown;
  try {
    const metadata = await configFile.stat();
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)
      || !metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) || metadata.size > 1024 * 1024) throw fail();
    raw = JSON.parse(await configFile.readFile("utf8"));
  } finally { await configFile.close(); }
  const config = deliveryRuntimeConfigurationSchema.parse(raw);
  if (digest(await readFile(fileURLToPath(import.meta.url))) !== config.verifierBuildSha256 || !path.isAbsolute(config.directory)) throw fail();
  const receipts = await stat(config.directory);
  if (!receipts.isDirectory() || receipts.uid !== process.getuid?.() || (receipts.mode & 0o077)) throw fail();
  // fork passes its module filename to the executable wrapper. A pinned plugin
  // cannot silently fall back to a development loader or a different module.
  if (config.component === "plugin") {
    if (process.argv.length !== 3 || process.argv[2] !== path.join(config.node!.root, config.node!.entrypoint)) throw fail();
  } else if (config.component === "harness" && config.native) {
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(config.native.args)) throw fail();
  } else if (process.argv.length !== 2) throw fail();
  const key = createPrivateKey(config.privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw fail();
  const runtimeConfiguration = config.node ?? config.native!;
  runtimeConfiguration.env = { ...runtimeConfiguration.env, VERRAIL_RUNTIME_SESSION_ID: config.sessionId };
  const configurationSha256 = digest(Buffer.from(canonicalJson({ engine: config.node ? "node" : "native", config: runtimeConfiguration })));
  let childExited = false;
  let handleExit: (() => void) | undefined;
  const transport = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    onExit: () => { childExited = true; handleExit?.(); },
    onMessage: (value: unknown) => { if (process.connected) process.send?.(value as Parameters<NonNullable<typeof process.send>>[0]); },
  };
  if (config.node) {
    const node = await launchObservedNodeRuntime(config.node, transport);
    running = node;
    process.on("message", value => { try { node.send(value); } catch { void close(1); } });
  } else running = await launchObservedNativeRuntime(config.native!, transport);
  const output = path.join(config.directory, `${config.sessionId}-${config.component}`);
  async function publish(suffix: string, value: unknown) {
    const temporary = `${output}.${process.pid}.${suffix}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, `${output}.${suffix}.json`);
  }
  let busy = false;
  let publishing = Promise.resolve();
  function publishWitness() {
    const next = publishing.then(publishCheckpoint);
    publishing = next.then(() => {}, () => {});
    return next;
  }
  async function publishCheckpoint() {
    const observation = await running!.checkpoint();
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "verrail.runtime-witness", component: config.component,
      sessionId: config.sessionId, manifestSha256: config.manifestSha256, verifierBuildSha256: config.verifierBuildSha256,
      configurationSha256, observerPid: process.pid,
      executionIdentity: config.component === "harness" ? {
        workspaceId: runtimeConfiguration.env.PAPERCLIP_COMPANY_ID ?? null,
        agentId: runtimeConfiguration.env.PAPERCLIP_AGENT_ID ?? null,
        heartbeatRunId: runtimeConfiguration.env.PAPERCLIP_RUN_ID ?? null,
      } : null, observation }));
    await publish("witness", { schemaVersion: 1, payload: payload.toString("base64"),
      signature: sign(null, Buffer.concat([Buffer.from("verrail.runtime-witness.v1\0"), payload]), key).toString("base64") });
    return observation;
  }
  let exitHandled = false;
  handleExit = () => {
    if (exitHandled) return;
    exitHandled = true;
    if (config.component === "harness" && config.native) {
      void publishWitness().then(observation => {
        const code = (observation as { exitCode?: unknown }).exitCode;
        return close(typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1);
      }, () => close(1));
    } else void close(1);
  };
  process.on("SIGUSR2", () => {
    if (busy || closing) return;
    busy = true;
    void publishWitness().catch(() => close(1)).finally(() => { busy = false; });
  });
  process.on("SIGTERM", () => { void close(0); });
  process.on("SIGINT", () => { void close(0); });
  process.on("disconnect", () => { void close(0); });
  await publish("ready", { schemaVersion: 1, sessionId: config.sessionId, component: config.component, observerPid: process.pid });
  if (childExited) handleExit();
} catch {
  process.stderr.write("DELIVERY_RUNTIME_UNAVAILABLE\n");
  await close(1);
}
