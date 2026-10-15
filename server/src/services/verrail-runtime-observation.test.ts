import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchObservedNodeRuntime, runtimeObservationFailureCode } from "./verrail-runtime-observation.js";
import { buildDeliveryProofRuntime } from "./delivery-proof-reader-build.js";

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
describe("externally observed Node runtime bytes (synthetic processes)", () => {
  const directories: string[] = [];
  const children: Awaited<ReturnType<typeof launchObservedNodeRuntime>>[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) await child.stop();
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });
  function holdPausedEvents() {
    const emit = WebSocket.prototype.emit;
    const releases: Array<() => void> = [];
    let resolvePaused: () => void;
    const paused = new Promise<void>(resolve => { resolvePaused = resolve; });
    const sends = vi.spyOn(WebSocket.prototype, "send");
    const events = vi.spyOn(WebSocket.prototype, "emit").mockImplementation(function (this: WebSocket, event, ...args) {
      if (event === "message" && JSON.parse(args[0].toString()).method === "Debugger.paused") {
        releases.push(() => { emit.call(this, event, ...args); });
        resolvePaused();
        return true;
      }
      return emit.call(this, event, ...args);
    });
    return { paused, releases, sends, release() { events.mockRestore(); for (const release of releases.splice(0)) release(); } };
  }
  async function fixture(extra = "") {
    const root = await mkdtemp(path.join(os.tmpdir(), "verrail-runtime-observer-")); directories.push(root);
    const dependency = "export const value = 42;\n";
    const source = `import { value } from './dependency.mjs';\n${extra}\nprocess.send({ kind: 'ready', value });\nsetInterval(() => {}, 1000);\n`;
    await writeFile(path.join(root, "entry.mjs"), source); await writeFile(path.join(root, "dependency.mjs"), dependency);
    return { root, source, configuration: { schemaVersion: 1 as const, root, entrypoint: "entry.mjs", candidateCommit: "a".repeat(40),
      executable: process.execPath, executableSha256: sha256(await readFile(process.execPath)),
      files: [{ path: "entry.mjs", sha256: sha256(source) }, { path: "dependency.mjs", sha256: sha256(dependency) }], env: {} } };
  }
  async function start(configuration: Awaited<ReturnType<typeof fixture>>["configuration"]) {
    const child = await launchObservedNodeRuntime(configuration); children.push(child);
    await child.waitForMessage("ready");
    return child;
  }
  it("hashes source returned by the child's V8 debugger, including loaded dependencies", async () => {
    const f = await fixture(), child = await start(f.configuration), observation = await child.checkpoint();
    expect(observation).toMatchObject({ kind: "verrail.node-runtime-observation", candidateCommit: f.configuration.candidateCommit,
      executableSha256: f.configuration.executableSha256, assurance: "observed_main_thread_scripts" });
    expect(observation.scripts).toEqual([...f.configuration.files].sort((a, b) => a.path.localeCompare(b.path)));
    expect(JSON.stringify(observation)).not.toContain(f.root);
    expect(JSON.stringify(observation)).not.toContain("export const");
  });
  it("does not request script source before receiving an actual pause", async () => {
    const f = await fixture(), gate = holdPausedEvents();
    const child = await launchObservedNodeRuntime(f.configuration); children.push(child);
    try {
      // Hold a real pause notification, rather than making test success depend
      // on a particular host's pre-pause interval exceeding ten seconds.
      await gate.paused;
      expect(gate.releases).toHaveLength(1);
      expect(gate.sends.mock.calls.map(([data]) => JSON.parse(String(data)).method)).not.toContain("Debugger.getScriptSource");
    } finally { gate.release(); }
    await child.waitForMessage("ready");
    expect((await child.checkpoint()).scripts).toEqual([...f.configuration.files].sort((a, b) => a.path.localeCompare(b.path)));
  });
  it("lets a checkpoint take over an initial pause while its sources are draining", async () => {
    const f = await fixture(), send = WebSocket.prototype.send, gate = holdPausedEvents();
    const child = await launchObservedNodeRuntime(f.configuration); children.push(child);
    let checkpoint: ReturnType<typeof child.checkpoint> | undefined;
    gate.sends.mockImplementation(function (this: WebSocket, data, ...args) {
      if (!checkpoint && JSON.parse(String(data)).method === "Debugger.getScriptSource") checkpoint = child.checkpoint();
      return send.call(this, data, ...args);
    });
    await gate.paused;
    gate.release();
    await vi.waitFor(() => expect(checkpoint).toBeDefined());
    expect((await checkpoint!).scripts).toEqual([...f.configuration.files].sort((a, b) => a.path.localeCompare(b.path)));
    const methods = gate.sends.mock.calls.map(([data]) => JSON.parse(String(data)).method);
    expect(methods).not.toContain("Debugger.pause");
    expect(methods.filter(method => method === "Debugger.resume")).toHaveLength(1);
    await child.waitForMessage("ready");
  });
  it("collects scripts dynamically imported after startup at the next real pause", async () => {
    const f = await fixture(`process.on('message', async () => {
      await import('./late.mjs'); process.send({ kind: 'imported' });
    });`);
    const source = "export const late = 7;\n";
    await writeFile(path.join(f.root, "late.mjs"), source);
    f.configuration.files.push({ path: "late.mjs", sha256: sha256(source) });
    const child = await start(f.configuration), sends = vi.spyOn(WebSocket.prototype, "send");
    child.send({ kind: "import" });
    await child.waitForMessage("imported");
    expect(sends.mock.calls.map(([data]) => JSON.parse(String(data)).method)).not.toContain("Debugger.getScriptSource");
    expect((await child.checkpoint()).scripts).toEqual([...f.configuration.files].sort((a, b) => a.path.localeCompare(b.path)));
  });
  it.each(["unknown", "changed"])("rejects a %s dynamically imported file at checkpoint", async variant => {
    const f = await fixture(`process.on('message', async () => {
      await import('./late.mjs'); process.send({ kind: 'imported' });
    });`);
    const source = "export const late = 7;\n";
    await writeFile(path.join(f.root, "late.mjs"), source);
    if (variant === "changed") f.configuration.files.push({ path: "late.mjs", sha256: sha256(source) });
    const child = await start(f.configuration);
    if (variant === "changed") await writeFile(path.join(f.root, "late.mjs"), "export const late = 8;\n");
    child.send({ kind: "import" });
    await child.waitForMessage("imported");
    await expect(child.checkpoint()).rejects.toMatchObject({ message: "RUNTIME_OBSERVATION_UNAVAILABLE",
      cause: variant === "unknown" ? "script_url" : "source_hash" });
  });
  it("retains the source-command deadline after a real pause", async () => {
    const f = await fixture(), gate = holdPausedEvents();
    const child = await launchObservedNodeRuntime(f.configuration); children.push(child);
    await gate.paused;
    gate.release();
    const emit = WebSocket.prototype.emit;
    // Drop only actual source responses. Other inspector commands and the
    // production ten-second source deadline remain real and unchanged.
    vi.spyOn(WebSocket.prototype, "emit").mockImplementation(function (this: WebSocket, event, ...args) {
      if (event === "message") {
        const message = JSON.parse(args[0].toString());
        const sourceIds = gate.sends.mock.calls.map(([data]) => JSON.parse(String(data)))
          .filter(request => request.method === "Debugger.getScriptSource").map(request => request.id);
        if (sourceIds.includes(message.id)) return true;
      }
      return emit.call(this, event, ...args);
    });
    await expect(child.checkpoint()).rejects.toMatchObject({ message: "RUNTIME_OBSERVATION_UNAVAILABLE", cause: "command_timeout_source" });
  }, 15_000);
  it("releases a checkpoint waiting for the initial pause when stopped", async () => {
    const f = await fixture(), gate = holdPausedEvents();
    const child = await launchObservedNodeRuntime(f.configuration); children.push(child);
    await gate.paused;
    let error: unknown;
    const checkpoint = child.checkpoint().catch(reason => { error = reason; });
    const stopping = child.stop();
    try {
      await vi.waitFor(() => expect(error).toMatchObject({ message: "RUNTIME_OBSERVATION_UNAVAILABLE" }), { timeout: 500 });
      await checkpoint;
      expect(gate.sends.mock.calls.map(([data]) => JSON.parse(String(data)).method)).not.toContain("Debugger.getScriptSource");
    } finally { gate.release(); await stopping; }
  });
  it("runs the standalone proxy with normal stdio and a separately signed runtime witness", async () => {
    const f = await fixture(`process.stdin.setEncoding('utf8'); process.stdin.on('data', text => {
      if (text.trim() === 'reject') { new Function('return "private-generated-source"')(); console.log('generated-ready'); }
      else console.log('echo:' + text.trim());
    }); console.log('transport-ready');`);
    const entry = path.join(f.root, "observer.mjs"), configPath = path.join(f.root, "observer.json");
    await buildDeliveryProofRuntime(entry);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, component: "server", sessionId,
      manifestSha256: "a".repeat(64), verifierBuildSha256: sha256(await readFile(entry)), directory: f.root,
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }), node: f.configuration }), { mode: 0o600 });
    const proxy = spawn(process.execPath, [entry], { env: { VERRAIL_RUNTIME_OBSERVER_CONFIG: configPath }, stdio: ["pipe", "pipe", "pipe"] });
    const proxyExited = once(proxy, "exit");
    let stdout = "", stderr = "";
    proxy.stdout.on("data", chunk => { stdout += chunk; }); proxy.stderr.on("data", chunk => { stderr += chunk; });
    try {
      await vi.waitFor(() => expect(stdout, stderr).toContain("transport-ready"), { timeout: 15000 });
      proxy.stdin.write("sample\n");
      await vi.waitFor(() => expect(stdout).toContain("echo:sample"));
      proxy.kill("SIGUSR2");
      let witness: { payload: string; signature: string } | undefined;
      await vi.waitFor(async () => { witness = JSON.parse(await readFile(path.join(f.root, `${sessionId}-server.witness.json`), "utf8")); }, { timeout: 15000 });
      const payload = Buffer.from(witness!.payload, "base64");
      expect(verify(null, Buffer.concat([Buffer.from("verrail.runtime-witness.v1\0"), payload]), publicKey, Buffer.from(witness!.signature, "base64"))).toBe(true);
      expect(JSON.parse(payload.toString())).toMatchObject({ component: "server", sessionId,
        observation: { assurance: "observed_main_thread_scripts", candidateCommit: f.configuration.candidateCommit } });
      proxy.stdin.write("reject\n");
      await vi.waitFor(() => expect(stdout).toContain("generated-ready"));
      proxy.kill("SIGUSR2");
      await vi.waitFor(() => expect(stderr).toContain("DELIVERY_RUNTIME_CHECKPOINT_FAILED:generated_script"), { timeout: 15000 });
      // stop() includes a one-second SIGTERM grace period. Await its exit event,
      // rather than racing that grace period against waitFor's one-second default.
      await expect(proxyExited).resolves.toEqual([1, null]);
      expect(stderr).not.toContain("private-generated-source");
      expect(await readFile(path.join(f.root, `${sessionId}-server.witness.json`), "utf8"))
        .toBe(JSON.stringify(witness));
    } finally {
      if (proxy.exitCode === null && proxy.signalCode === null) { const exited = once(proxy, "exit"); proxy.kill("SIGTERM"); await exited; }
    }
  }, 35000);
  it("does not substitute edited disk bytes for the script already loaded in V8", async () => {
    const f = await fixture(), child = await start(f.configuration);
    await writeFile(path.join(f.root, "entry.mjs"), "different source on disk\n");
    expect((await child.checkpoint()).scripts).toContainEqual({ path: "entry.mjs", sha256: sha256(f.source) });
  });
  it("refuses an unmanifested dynamically evaluated script", async () => {
    const f = await fixture("new Function('return 99')();");
    const child = await start(f.configuration);
    await expect(child.checkpoint()).rejects.toMatchObject({ message: "RUNTIME_OBSERVATION_UNAVAILABLE", cause: "generated_script" });
  });
  it("exposes only fixed diagnostic codes, never source paths or arbitrary causes", () => {
    expect(runtimeObservationFailureCode(new Error('private source', { cause: 'source_hash' }))).toBe('source_hash');
    for (const suffix of ['enable', 'start', 'source', 'pause', 'resume']) {
      const cause = `command_timeout_${suffix}`;
      expect(runtimeObservationFailureCode(new Error('private source', { cause }))).toBe(cause);
    }
    for (const error of [new Error('private source'), new Error('failed', { cause: '/private/secret' }),
      new Error('failed', { cause: new Error('private token') }), { cause: 'source_hash' },
      new Error('failed', { cause: 'command_timeout_arbitrary' })]) {
      expect(runtimeObservationFailureCode(error)).toBe('unknown');
    }
  });
  it("accepts only explicitly pinned generated source bytes", async () => {
    const f = await fixture("new Function('return 99')();");
    const generated = sha256(`(${new Function("return 99").toString()})`);
    const child = await start({ ...f.configuration, generatedScriptSha256: [generated] } as typeof f.configuration);
    expect((await child.checkpoint()).generatedScriptSha256).toEqual([generated]);
  });
  it("does not treat sourceURL impersonation as a trusted Node builtin", async () => {
    const f = await fixture("eval('void 0;\\n//# sourceURL=node:trusted-looking');");
    const child = await start(f.configuration);
    await expect(child.checkpoint()).rejects.toThrow("RUNTIME_OBSERVATION_UNAVAILABLE");
  });
  it("cleans its process group after the observed parent has already exited", async () => {
    const f = await fixture(`
      import { spawn } from 'node:child_process';
      const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
      descendant.unref();
      process.send({ kind: 'descendant', pid: descendant.pid, parentPid: process.pid });
    `);
    const child = await start(f.configuration);
    const message = await child.waitForMessage("descendant") as { pid: number; parentPid: number };
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      process.kill(message.parentPid, "SIGKILL");
      await vi.waitFor(() => expect(alive(message.parentPid)).toBe(false));
      expect(alive(message.pid)).toBe(true);
      await child.stop();
      await vi.waitFor(() => expect(alive(message.pid)).toBe(false));
    } finally {
      if (alive(message.pid)) process.kill(message.pid, "SIGKILL");
    }
  });
  it.each(["source", "executable", "preload", "duplicate", "escape"])("refuses invalid startup binding %s", async change => {
    const f = await fixture();
    if (change === "source") f.configuration.files[0]!.sha256 = "b".repeat(64);
    if (change === "executable") f.configuration.executableSha256 = "b".repeat(64);
    if (change === "preload") Object.assign(f.configuration.env, { NODE_OPTIONS: "--require private-file" });
    if (change === "duplicate") f.configuration.files.push(f.configuration.files[0]!);
    if (change === "escape") f.configuration.files[0]!.path = "../entry.mjs";
    await expect(launchObservedNodeRuntime(f.configuration)).rejects.toThrow("RUNTIME_OBSERVATION_UNAVAILABLE");
  });
});
