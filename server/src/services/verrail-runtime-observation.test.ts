import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchObservedNodeRuntime, runtimeObservationFailureCode } from "./verrail-runtime-observation.js";
import { buildDeliveryProofRuntime } from "./delivery-proof-reader-build.js";

const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
describe("externally observed Node runtime bytes (synthetic processes)", () => {
  const directories: string[] = [];
  const children: Awaited<ReturnType<typeof launchObservedNodeRuntime>>[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) await child.stop();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });
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
