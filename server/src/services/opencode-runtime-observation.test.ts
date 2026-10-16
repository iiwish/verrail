import { afterEach, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import path from "node:path";
import { openCodeCandidateIdentitySchema, openCodeRuntimeManifestSchema, collectOpenCodeRuntimeWitnesses,
  openCodeRuntimeDigest, openCodeWitnessDomain, openCodeWitnessPrefix,
  type OpenCodeRuntimeCollectionInput, type OpenCodeRuntimeManifest } from "./opencode-runtime-observation.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = "11111111-1111-4111-8111-111111111111";
const identity = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id,
  runId: id, runAttemptId: id, leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id };
async function fixture() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "verrail-opencode-witness-test-")); await chmod(directory, 0o700);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), sessionId = randomUUID(), now = Date.now();
  const time = (offset: number) => new Date(now + offset).toISOString();
  const manifest: OpenCodeRuntimeManifest = { schemaVersion: 1, kind: "verrail.opencode-runtime-manifest", candidateCommit: "a".repeat(40),
    apiOriginSha256: hash("api"), domainOriginSha256: hash("domain"), observerExecutableSha256: hash("observer-node"),
    components: ["server", "domain", "repository_executor", "opencode"].map(name => ({ component: name as "server" | "domain" | "repository_executor" | "opencode",
      configurationSha256: hash(`${name}-config`), verifierBuildSha256: hash("observer-build"), executableSha256: hash(`${name}-binary`),
      sourceManifestSha256: name === "server" || name === "repository_executor" ? hash(`${name}-source`) : null })) };
  const config = { directory, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), sessionId,
    manifest, manifestSha256: openCodeRuntimeDigest(manifest) };
  const input: OpenCodeRuntimeCollectionInput = { identity, runtimeWindow: { startedAt: time(-1000), finishedAt: time(-100) },
    httpSession: { sessionId: "ses_actual", runtimeVersion: "1.17.13", createdAt: time(-800), completedAt: time(-300), homeSha256: hash("home") } };
  const payloads = new Map<string, Record<string, any>>();
  const envelope = (payload: unknown) => {
    const bytes = Buffer.from(JSON.stringify(payload)); return { schemaVersion: 1, payload: bytes.toString("base64"),
      signature: sign(null, Buffer.concat([openCodeWitnessDomain, bytes]), keys.privateKey).toString("base64") };
  };
  const publish = async (filename: string, payload: unknown) => {
    const temporary = `${filename}.tmp`; await writeFile(temporary, JSON.stringify(envelope(payload)), { mode: 0o600 }); await rename(temporary, filename);
  };
  for (const [index, entry] of manifest.components.entries()) {
    const prefix = openCodeWitnessPrefix(directory, sessionId, entry.component, identity);
    await publish(`${prefix}.ready.json`, { schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-ready", component: entry.component,
      sessionId, manifestSha256: config.manifestSha256, verifierBuildSha256: entry.verifierBuildSha256, observerPid: 1000 + index });
    const observation = { schemaVersion: 1, kind: entry.sourceManifestSha256 ? "verrail.node-runtime-observation" : "verrail.native-runtime-observation",
      assurance: entry.sourceManifestSha256 ? "observed_main_thread_scripts" : "launch_owned_immutable_executable", observerSessionId: randomUUID(), pid: 2000 + index,
      candidateCommit: manifest.candidateCommit, executableSha256: entry.executableSha256, startedAt: time(-2000), observedAt: time(-200), limitations: ["test_fixture"],
      ...(entry.sourceManifestSha256 ? { manifestSha256: entry.sourceManifestSha256, scripts: [{ path: "entry.mjs", sha256: hash("entry") }], generatedScriptSha256: [] }
        : { finishedAt: null, exitCode: null, signal: null }) };
    const { completedAt: _completed, ...httpSession } = input.httpSession;
    const payload = { schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-witness", component: entry.component,
      phase: entry.component === "opencode" ? "terminated" : "checkpoint", sessionId, requestId: null,
      manifestSha256: config.manifestSha256, verifierBuildSha256: entry.verifierBuildSha256, observerExecutableSha256: manifest.observerExecutableSha256,
      configurationSha256: entry.configurationSha256, observerPid: 1000 + index,
      observation: { ...observation, sha256: openCodeRuntimeDigest(observation) },
      executionIdentity: entry.component === "opencode" ? identity : null, httpSession: entry.component === "opencode" ? httpSession : null,
      launch: { rootSha256: input.httpSession.homeSha256, argvSha256: hash("argv"), environmentSha256: hash("redacted-env") },
      termination: entry.component === "opencode" ? { requestedSignal: "SIGTERM", finishedAt: time(-150), processGroupStopped: true, immutableExecutableRemoved: true } : null };
    payloads.set(entry.component, payload); await publish(`${prefix}.witness.json`, payload);
  }
  let stopped = false; const pending = new Set<Promise<void>>(); const seen = new Set<string>();
  const timer = setInterval(() => {
    if (stopped) return;
    for (const entry of manifest.components.filter(entry => entry.component !== "opencode")) {
      const prefix = openCodeWitnessPrefix(directory, sessionId, entry.component, identity);
      const work = (async () => {
        let request: { requestId: string };
        try { request = JSON.parse(await readFile(`${prefix}.checkpoint.json`, "utf8")); } catch { return; }
        if (seen.has(request.requestId)) return; seen.add(request.requestId);
        const payload = structuredClone(payloads.get(entry.component)!); payload.requestId = request.requestId;
        payload.observation.observedAt = new Date().toISOString();
        const { sha256: _hash, ...observation } = payload.observation; payload.observation.sha256 = openCodeRuntimeDigest(observation);
        await publish(`${prefix}.witness.json`, payload);
      })(); pending.add(work); void work.finally(() => pending.delete(work));
    }
  }, 5);
  cleanups.push(async () => { stopped = true; clearInterval(timer); await Promise.all(pending); });
  return { config, input, payloads, async changeOpenCode(change: (payload: Record<string, any>) => void, rehash = true) {
    const payload = structuredClone(payloads.get("opencode")!); change(payload);
    if (rehash) { const { sha256: _hash, ...observation } = payload.observation; payload.observation.sha256 = openCodeRuntimeDigest(observation); }
    await publish(`${openCodeWitnessPrefix(directory, sessionId, "opencode", identity)}.witness.json`, payload);
  } };
}

it("does not accept the heartbeat runtime component/identity contract as OpenCode repository proof", () => {
  expect(openCodeCandidateIdentitySchema.safeParse({ workspaceId: "11111111-1111-4111-8111-111111111111",
    agentId: "11111111-1111-4111-8111-111111111111", heartbeatRunId: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
  expect(openCodeRuntimeManifestSchema.safeParse({ schemaVersion: 1, candidateCommit: "a".repeat(40),
    components: ["server", "domain", "plugin", "harness"] }).success).toBe(false);
});

it("fails closed before filesystem access when a candidate manifest binding is missing", async () => {
  await expect(collectOpenCodeRuntimeWitnesses({ directory: "/not-read", publicKey: "", sessionId: "", manifest: {},
    manifestSha256: "" } as never, {} as never)).rejects.toThrow();
});

it("collects independent nonce checkpoints and a signed controlled-stop OpenCode witness", async () => {
  const f = await fixture(); const result = await collectOpenCodeRuntimeWitnesses(f.config, f.input);
  expect(result.witnesses.map(witness => witness.component)).toEqual(["server", "domain", "repository_executor", "opencode"]);
  expect(result.witnesses.slice(0, 3).every(witness => witness.requestId !== null)).toBe(true);
  expect(result.witnesses[3]).toMatchObject({ executionIdentity: identity, phase: "terminated",
    observation: { exitCode: null, signal: null }, termination: { requestedSignal: "SIGTERM", processGroupStopped: true } });
  for (const witness of result.witnesses) {
    const filename = path.join(f.config.directory, "witness-archive", "sha256", `${witness.envelopeRef.contentHash}.json`);
    const bytes = await readFile(filename);
    expect(witness.envelopeRef).toEqual({ contentHash: hash(bytes), bytes: bytes.length, contentRef: `private-witness:sha256:${hash(bytes)}` });
    expect((await stat(filename)).mode & 0o777).toBe(0o400);
    const envelope = JSON.parse(bytes.toString("utf8"));
    expect(verify(null, Buffer.concat([openCodeWitnessDomain, Buffer.from(envelope.payload, "base64")]), f.config.publicKey,
      Buffer.from(envelope.signature, "base64"))).toBe(true);
  }
  const repeated = await collectOpenCodeRuntimeWitnesses(f.config, f.input);
  expect(repeated.witnesses[3].envelopeRef).toEqual(result.witnesses[3].envelopeRef);
});

it("rejects an archive directory symlink before writing outside its private tree", async () => {
  const f = await fixture(), destination = path.join(f.config.directory, "foreign"); await mkdir(destination, { mode: 0o700 });
  await symlink(destination, path.join(f.config.directory, "witness-archive"));
  await expect(collectOpenCodeRuntimeWitnesses(f.config, f.input)).rejects.toThrow();
  await expect(stat(path.join(destination, "sha256"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["bytes", "permissions"])("rejects rather than overwriting an existing witness archive with wrong %s", async failure => {
  const f = await fixture(), result = await collectOpenCodeRuntimeWitnesses(f.config, f.input);
  const filename = path.join(f.config.directory, "witness-archive", "sha256", `${result.witnesses[3].envelopeRef.contentHash}.json`);
  await chmod(filename, 0o600);
  if (failure === "bytes") { await writeFile(filename, "corrupted"); await chmod(filename, 0o400); }
  await expect(collectOpenCodeRuntimeWitnesses(f.config, f.input)).rejects.toThrow();
  if (failure === "bytes") expect(await readFile(filename, "utf8")).toBe("corrupted");
});

it.each(["fence", "session", "home", "binary", "candidate", "digest", "missing-cleanup", "late-stop", "early-checkpoint", "legacy-identity"])(
  "rejects an independently signed but mismatched candidate witness: %s", async failure => {
    const f = await fixture();
    await f.changeOpenCode(value => {
      if (failure === "fence") value.executionIdentity.fencingToken++;
      if (failure === "session") value.httpSession.sessionId = "ses_foreign";
      if (failure === "home") value.launch.rootSha256 = hash("foreign-home");
      if (failure === "binary") value.observation.executableSha256 = hash("foreign-binary");
      if (failure === "candidate") value.observation.candidateCommit = "b".repeat(40);
      if (failure === "digest") value.observation.sha256 = hash("tampered");
      if (failure === "missing-cleanup") value.termination = null;
      if (failure === "late-stop") value.termination.finishedAt = new Date(Date.now() + 1000).toISOString();
      if (failure === "early-checkpoint") value.observation.observedAt = f.input.runtimeWindow.startedAt;
      if (failure === "legacy-identity") value.executionIdentity = { workspaceId: id, agentId: id, heartbeatRunId: id };
    }, failure !== "digest");
    await expect(collectOpenCodeRuntimeWitnesses(f.config, f.input)).rejects.toThrow();
  });

it("does not accept a restarted executor that failed to cover the normal execution window", async () => {
  const f = await fixture(); f.payloads.get("repository_executor")!.observation.startedAt = f.input.httpSession.completedAt;
  await expect(collectOpenCodeRuntimeWitnesses(f.config, f.input)).rejects.toThrow();
});

it("rejects missing witness files rather than substituting expected hashes", async () => {
  const f = await fixture(); await rm(`${openCodeWitnessPrefix(f.config.directory, f.config.sessionId, "opencode", identity)}.witness.json`);
  await expect(collectOpenCodeRuntimeWitnesses(f.config, f.input)).rejects.toThrow();
});

it("rejects signatures from another observer key", async () => {
  const f = await fixture(); f.config.publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  await expect(collectOpenCodeRuntimeWitnesses(f.config, f.input)).rejects.toThrow();
});

it("launches an immutable native protocol fixture, independently reads HTTP identity, and attests actual controlled cleanup", async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "verrail-opencode-observer-process-")); await chmod(directory, 0o700);
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "observer.mjs"), configurationFile = path.join(directory, "observer.json"), home = path.join(directory, "home");
  await mkdir(home, { mode: 0o700 });
  await build({ entryPoints: [fileURLToPath(new URL("../../scripts/opencode-proof-runtime.ts", import.meta.url))], outfile: entrypoint,
    bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    banner: { js: "import { createRequire as __runtimeRequire } from 'node:module'; const require = __runtimeRequire(import.meta.url);" } });
  // A tiny native protocol peer avoids relying on a relocatable Node build. It is not OpenCode/model acceptance.
  const source = path.join(directory, "peer.c"), executable = path.join(directory, "peer");
  await writeFile(source, `#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv) {
 if(argc!=6)return 2; int s=socket(AF_INET,SOCK_STREAM,0); if(s<0)return 3;
 struct sockaddr_in address={0};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);address.sin_port=htons(atoi(argv[5]));
 if(bind(s,(struct sockaddr *)&address,sizeof(address))||listen(s,8))return 4;
 struct timeval now;gettimeofday(&now,0);long long created=(long long)now.tv_sec*1000+now.tv_usec/1000;
 while(1){int c=accept(s,0,0);if(c<0)return 5;char input[8192]={0},body[4096]={0},response[8192]={0};
 ssize_t size=read(c,input,sizeof(input)-1);if(size<=0){close(c);continue;}
 if(strstr(input,"GET /global/health"))snprintf(body,sizeof(body),"{\\\"healthy\\\":true,\\\"version\\\":\\\"1.17.13\\\"}");
 else if(strstr(input,"GET /session/ses_actual"))snprintf(body,sizeof(body),"{\\\"id\\\":\\\"ses_actual\\\",\\\"time\\\":{\\\"created\\\":%lld}}",created);
 else if(strstr(input,"GET /path"))snprintf(body,sizeof(body),"{\\\"home\\\":\\\"%s\\\",\\\"directory\\\":\\\"%s\\\"}",getenv("HOME"),getenv("HOME"));
 else {close(c);continue;}
 int length=snprintf(response,sizeof(response),"HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: %zu\\r\\nConnection: close\\r\\n\\r\\n%s",strlen(body),body);
 for(int offset=0;offset<length;){ssize_t n=write(c,response+offset,length-offset);if(n<=0)break;offset+=n;}close(c);
 }
}`);
  await promisify(execFile)("cc", [source, "-o", executable], { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16_384 });
  const keys = generateKeyPairSync("ed25519"), sessionId = randomUUID(), executableSha256 = hash(await readFile(executable));
  const configuration = { schemaVersion: 1, component: "opencode", sessionId, manifestSha256: hash("manifest"),
    verifierBuildSha256: hash(await readFile(entrypoint)), observerExecutableSha256: hash(await readFile(process.execPath)), directory,
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    opencode: { candidateCommit: "a".repeat(40), executable, executableSha256, version: "1.17.13" } };
  await writeFile(configurationFile, JSON.stringify(configuration), { mode: 0o600 });
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port; await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const password = "a".repeat(64), providerSecret = "private-fixture-key-must-not-leak";
  const child = spawn(process.execPath, [entrypoint, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH, HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
      OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { fixture: { apiKey: providerSecret } } }),
      VERRAIL_OPENCODE_OBSERVER_CONFIG: configurationFile, VERRAIL_OPENCODE_EXECUTION_IDENTITY: JSON.stringify(identity) } });
  const closed = once(child, "close"); let nativePid: number | undefined; let stderr = "";
  child.stdout?.resume(); child.stderr?.on("data", value => { stderr = (stderr + String(value)).slice(-8192); });
  try {
    const [started] = await once(child, "message", { signal: AbortSignal.timeout(10_000) }); nativePid = started.nativePid;
    expect(started).toMatchObject({ kind: "verrail.opencode-runtime-started", observerPid: child.pid, sessionId });
    await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(500),
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })).ok).toBe(true), { timeout: 5000 });
    const binding = once(child, "message", { signal: AbortSignal.timeout(10_000) }); child.send({ kind: "verrail.opencode-bind-session", sessionId: "ses_actual" });
    const [bound] = await binding; expect(bound).toMatchObject({ kind: "verrail.opencode-session-bound", executionIdentitySha256: openCodeRuntimeDigest(identity),
      httpSession: { sessionId: "ses_actual", runtimeVersion: "1.17.13", homeSha256: hash(home) } });
    child.kill("SIGTERM"); await expect(closed).resolves.toEqual([0, null]);
    const envelope = JSON.parse(await readFile(`${openCodeWitnessPrefix(directory, sessionId, "opencode", identity)}.witness.json`, "utf8"));
    expect(verify(null, Buffer.concat([openCodeWitnessDomain, Buffer.from(envelope.payload, "base64")]), keys.publicKey,
      Buffer.from(envelope.signature, "base64"))).toBe(true);
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    expect(payload).toMatchObject({ phase: "terminated", executionIdentity: identity, httpSession: bound.httpSession,
      observation: { kind: "verrail.native-runtime-observation", executableSha256, pid: nativePid },
      termination: { requestedSignal: "SIGTERM", processGroupStopped: true, immutableExecutableRemoved: true } });
    expect(JSON.stringify(payload)).not.toContain(home); expect(JSON.stringify(payload)).not.toContain(providerSecret);
    expect(stderr).toBe(""); expect(() => process.kill(-nativePid!, 0)).toThrow();
  } finally {
    if (nativePid) { try { process.kill(-nativePid, "SIGKILL"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
    await closed;
    if (nativePid) await vi.waitFor(() => {
      try { process.kill(-nativePid!, 0); throw new Error("owned native process group still exists"); }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ESRCH"); }
    }, { timeout: 2000, interval: 20 });
  }
}, 25_000);
