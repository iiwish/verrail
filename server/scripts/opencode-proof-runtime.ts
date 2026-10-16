import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { readPrivateProofJson } from "../src/services/delivery-proof-observation.js";
import { launchObservedNativeRuntime, launchObservedNodeRuntime } from "../src/services/verrail-runtime-observation.js";
import { openCodeCandidateIdentitySchema, openCodeCandidateWitnessSchema, openCodeCheckpointRequestSchema,
  openCodeHttpSessionSchema, openCodeObserverConfigurationDigest, openCodeObserverConfigurationSchema,
  openCodeRuntimeDigest, openCodeWitnessDomain, openCodeWitnessPrefix } from "../src/services/opencode-runtime-observation.js";

// Bundle outside the candidate checkout. Only this launch-owning process receives the signing key.
const fail = () => new Error("OPENCODE_CANDIDATE_RUNTIME_UNAVAILABLE");
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let running: { stop(): Promise<void>; checkpoint(): Promise<unknown> } | undefined;
let close: (code: number, signal?: "SIGTERM" | "SIGINT") => Promise<void> = async code => { await running?.stop(); process.exit(code); };
try {
  if (process.execArgv.length || Object.keys(process.env).some(key => /^(NODE_(?!ENV$)|LD_|DYLD_)/.test(key) && process.env[key])) throw fail();
  const filename = process.env.VERRAIL_OPENCODE_OBSERVER_CONFIG;
  if (!filename || !path.isAbsolute(filename) || await realpath(path.dirname(filename)) !== path.dirname(filename)) throw fail();
  const config = openCodeObserverConfigurationSchema.parse(await readPrivateProofJson(filename));
  if (hash(await readFile(fileURLToPath(import.meta.url))) !== config.verifierBuildSha256
    || hash(await readFile(process.execPath)) !== config.observerExecutableSha256
    || !path.isAbsolute(config.directory) || await realpath(config.directory) !== config.directory) throw fail();
  const directory = await stat(config.directory);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw fail();
  const identity = config.opencode ? openCodeCandidateIdentitySchema.parse(JSON.parse(process.env.VERRAIL_OPENCODE_EXECUTION_IDENTITY ?? "null")) : null;
  const prefix = openCodeWitnessPrefix(config.directory, config.sessionId, config.component, identity ?? undefined);
  await writeFile(`${prefix}.owner`, String(process.pid), { flag: "wx", mode: 0o600 });
  const key = createPrivateKey(config.privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw fail();
  let launch = config.node ?? config.native;
  let port: string | undefined;
  if (config.opencode) {
    const args = process.argv.slice(2);
    if (args.length !== 5 || args[0] !== "serve" || args[1] !== "--hostname" || args[2] !== "127.0.0.1"
      || args[3] !== "--port" || !/^[1-9][0-9]{0,4}$/.test(args[4]!) || Number(args[4]) > 65535 || !process.connected) throw fail();
    port = args[4];
    const home = process.env.HOME;
    if (!home || !path.isAbsolute(home) || await realpath(home) !== home) throw fail();
    const metadata = await stat(home);
    if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)) throw fail();
    for (const [name, suffix] of [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"]]) {
      if (process.env[name!] !== path.join(home, suffix!)) throw fail();
    }
    if (!/^[a-f0-9]{64}$/.test(process.env.OPENCODE_SERVER_PASSWORD ?? "") || process.env.OPENCODE_DISABLE_AUTOUPDATE !== "true"
      || !process.env.OPENCODE_CONFIG_CONTENT || Buffer.byteLength(process.env.OPENCODE_CONFIG_CONTENT) > 32768) throw fail();
    const names = ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
      "OPENCODE_SERVER_PASSWORD", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_CONFIG_CONTENT"];
    const env = Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]!]));
    launch = { schemaVersion: 1, root: home, candidateCommit: config.opencode.candidateCommit,
      executable: config.opencode.executable, executableSha256: config.opencode.executableSha256, args, env };
  } else if (process.argv.length !== 2) throw fail();
  if (!launch) throw fail();
  const launchFacts = { rootSha256: hash(launch.root),
    argvSha256: openCodeRuntimeDigest("args" in launch ? launch.args : [launch.entrypoint]),
    environmentSha256: openCodeRuntimeDigest(launch.env) };
  const configurationSha256 = openCodeObserverConfigurationDigest(config);
  let childExited = false, closing = false, busy = false, lastRequest: string | undefined;
  let nativePid: number | undefined, httpSession: ReturnType<typeof openCodeHttpSessionSchema.parse> | null = null;
  const transport = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    onExit: () => { childExited = true; if (!closing) void close(1); },
    onMessage: (value: unknown) => {
      // Native OpenCode IPC is reserved for this observer's own launch/session acknowledgements.
      if (!config.opencode && process.connected) process.send?.(value as Parameters<NonNullable<typeof process.send>>[0]);
    } };
  if (config.node) running = await launchObservedNodeRuntime(config.node, transport);
  else {
    running = await launchObservedNativeRuntime(launch as Parameters<typeof launchObservedNativeRuntime>[0], transport);
    const initial = await running.checkpoint() as { pid: number };
    nativePid = initial.pid;
    if (config.opencode) process.send?.({ kind: "verrail.opencode-runtime-started", nativePid, observerPid: process.pid,
      sessionId: config.sessionId, manifestSha256: config.manifestSha256 });
  }
  async function publish(suffix: "ready" | "witness", value: unknown) {
    const bytes = Buffer.from(canonicalJson(value));
    const envelope = { schemaVersion: 1, payload: bytes.toString("base64"),
      signature: sign(null, Buffer.concat([openCodeWitnessDomain, bytes]), key).toString("base64") };
    if (envelope.payload.length > 900_000) throw fail();
    const temporary = `${prefix}.${process.pid}.${suffix}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
    await rename(temporary, `${prefix}.${suffix}.json`);
  }
  function witness(observation: unknown, requestId: string | null,
    termination: { requestedSignal: "SIGTERM" | "SIGINT"; finishedAt: string; processGroupStopped: true; immutableExecutableRemoved: true } | null = null) {
    return openCodeCandidateWitnessSchema.parse({ schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-witness", component: config.component,
      phase: termination ? "terminated" : "checkpoint", sessionId: config.sessionId, requestId, manifestSha256: config.manifestSha256,
      verifierBuildSha256: config.verifierBuildSha256, observerExecutableSha256: config.observerExecutableSha256,
      configurationSha256, observerPid: process.pid, observation, executionIdentity: identity, httpSession, launch: launchFacts, termination });
  }
  const poll = setInterval(() => {
    if (busy || closing || config.opencode) return;
    busy = true;
    void (async () => {
      let raw: unknown;
      try { raw = await readPrivateProofJson(`${prefix}.checkpoint.json`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const request = openCodeCheckpointRequestSchema.parse(raw);
      if (request.requestId === lastRequest) return;
      const age = Date.now() - Date.parse(request.requestedAt);
      if (age < 0 || age > 12_000) throw fail();
      lastRequest = request.requestId;
      await publish("witness", witness(await running!.checkpoint(), request.requestId));
    })().catch(() => close(1)).finally(() => { busy = false; });
  }, 50);
  close = async (code, signal) => {
    if (closing) return; closing = true; clearInterval(poll);
    let terminal: unknown;
    try {
      if (config.opencode && code === 0 && signal && httpSession && !childExited) terminal = await running!.checkpoint();
    } catch { code = 1; }
    try {
      await running!.stop();
      if (nativePid) {
        let gone = false;
        for (let attempt = 0; attempt < 25; attempt++) {
          try { process.kill(-nativePid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { gone = true; break; } throw fail(); }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (!gone || !childExited) throw fail();
      }
      if (config.opencode && code === 0) {
        if (!terminal || !signal) throw fail();
        await publish("witness", witness(terminal, null, { requestedSignal: signal, finishedAt: new Date().toISOString(),
          processGroupStopped: true, immutableExecutableRemoved: true }));
      }
    } catch { code = 1; }
    process.exit(code);
  };
  async function readHttp(endpoint: string) {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}?directory=${encodeURIComponent(launch!.root)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${launch!.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` },
      signal: AbortSignal.timeout(2000), redirect: "error" });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw fail(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 65536) throw fail(); chunks.push(chunk.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }
  let binding = false;
  process.on("message", value => {
    if (!config.opencode) return;
    void (async () => {
      if (binding || httpSession || closing || !value || typeof value !== "object"
        || JSON.stringify(value).length > 1024) throw fail();
      const message = value as { kind?: unknown; sessionId?: unknown };
      if (message.kind !== "verrail.opencode-bind-session" || typeof message.sessionId !== "string" || !/^ses_[A-Za-z0-9]+$/.test(message.sessionId)) throw fail();
      binding = true;
      const health = await readHttp("/global/health"), session = await readHttp(`/session/${message.sessionId}`), paths = await readHttp("/path");
      const created = (session.time as { created?: unknown } | undefined)?.created;
      if (health.healthy !== true || health.version !== config.opencode.version || session.id !== message.sessionId
        || typeof created !== "number" || !Number.isSafeInteger(created) || created < 1 || created > Date.now()
        || paths.home !== launch!.root || paths.directory !== launch!.root) throw fail();
      httpSession = openCodeHttpSessionSchema.parse({ sessionId: session.id, runtimeVersion: health.version,
        createdAt: new Date(created).toISOString(), homeSha256: hash(paths.home as string) });
      process.send?.({ kind: "verrail.opencode-session-bound", nativePid, observerPid: process.pid, sessionId: config.sessionId,
        manifestSha256: config.manifestSha256, executionIdentitySha256: openCodeRuntimeDigest(identity), httpSession });
    })().catch(() => close(1));
  });
  process.on("SIGTERM", () => { void close(0, "SIGTERM"); });
  process.on("SIGINT", () => { void close(0, "SIGINT"); });
  process.on("disconnect", () => { void close(1); });
  await publish("ready", { schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-ready", component: config.component,
    sessionId: config.sessionId, manifestSha256: config.manifestSha256, verifierBuildSha256: config.verifierBuildSha256, observerPid: process.pid });
  if (childExited) await close(1);
} catch {
  process.stderr.write("OPENCODE_CANDIDATE_RUNTIME_UNAVAILABLE\n");
  await close(1);
}
