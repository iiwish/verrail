import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { freezeNativeSource, validateNativeSourceObservation, type NativeSourceIdentity, type NativeSourceObservation } from "./verrail-native-source.js";

export const nativeSourceSnapshotSchema = z.object({
  schemaVersion: z.literal(1), format: z.literal("git_bundle"), scopeVersion: z.literal(2),
  sourceContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotCommit: z.string().regex(/^[a-f0-9]{40}$/), snapshotTree: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();
export type NativeSourceSnapshot = z.infer<typeof nativeSourceSnapshotSchema>;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const failure = () => new Error("NATIVE_SOURCE_SNAPSHOT_INVALID");

export async function createNativeSourceSnapshot(input: {
  cwd: string; identity: NativeSourceIdentity; source: NativeSourceObservation;
  check?: () => void; timeoutMs?: number; maxOutputBytes?: number;
}) {
  const timeout = input.timeoutMs ?? TIMEOUT_MS;
  const outputLimit = input.maxOutputBytes ?? MAX_BUNDLE_BYTES;
  const deadline = performance.now() + (Number.isSafeInteger(timeout) ? Math.max(0, Math.min(timeout, TIMEOUT_MS)) : 0);
  const maxBytes = Number.isSafeInteger(outputLimit) ? Math.max(0, Math.min(outputLimit, MAX_BUNDLE_BYTES)) : 0;
  const check = () => { input.check?.(); if (performance.now() >= deadline) throw failure(); };
  let temporary: string | undefined;
  try {
    check();
    const source = validateNativeSourceObservation(input.source, input.identity, "after_adapter_return");
    if (source?.schemaVersion !== 2 || source.status !== "captured") throw failure();
    const frozen = await freezeNativeSource({ cwd: input.cwd, identity: input.identity, phase: "after_adapter_return",
      limits: { timeoutMs: Math.floor(deadline - performance.now()) } });
    if (frozen.observation.status !== "captured" || JSON.stringify(frozen.observation.repository) !== JSON.stringify(source.repository)
      || JSON.stringify(frozen.observation.manifest) !== JSON.stringify(source.manifest)) throw failure();
    check();
    temporary = await mkdtemp(path.join(os.tmpdir(), "verrail-source-export-"));
    const repository = path.join(temporary, "snapshot.git");
    const git = (args: string[], chunks: Iterable<Buffer> = [], limit = 16_384): Promise<Buffer> => {
      check();
      return new Promise((resolve, reject) => {
        const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never",
          "-c", "pack.threads=1", "-c", "pack.window=0", "--no-replace-objects", ...args], {
          cwd: temporary, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
          env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
        });
        let failed = false;
        let bytes = 0;
        let errorBytes = 0;
        const output: Buffer[] = [];
        const stream = Readable.from(chunks);
        const abort = () => {
          failed = true;
          stream.destroy();
          child.stdin.destroy();
          try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        const timer = setTimeout(abort, Math.max(1, Math.floor(deadline - performance.now())));
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          try { check(); } catch { abort(); }
          if (bytes > limit) abort();
          if (!failed) output.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 65_536) abort(); });
        child.on("error", abort);
        child.stdin.on("error", abort);
        stream.on("error", abort);
        child.on("close", (code) => {
          clearTimeout(timer);
          stream.destroy();
          if (failed || code !== 0) reject(failure());
          else { try { check(); resolve(Buffer.concat(output)); } catch { reject(failure()); } }
        });
        stream.pipe(child.stdin);
      });
    };
    await git(["init", "--bare", "--quiet", "--template=", "--object-format=sha1", repository]);
    const ref = "refs/heads/verrail-source-snapshot";
    const message = "Verrail product source snapshot v2\n";
    function* importChunks() {
      yield Buffer.from(`commit ${ref}\ncommitter Verrail Snapshot <snapshot@verrail.invalid> 0 +0000\ndata ${Buffer.byteLength(message)}\n${message}`);
      for (const file of frozen.files) {
        check();
        // Git's quoted path grammar accepts UTF-8 plus escaped quotes; source
        // validation already rejects backslashes and control characters.
        yield Buffer.from(`M ${file.mode} inline ${JSON.stringify(file.path)}\ndata ${file.body.length}\n`);
        yield file.body;
        yield Buffer.from("\n");
      }
      yield Buffer.from("\ndone\n");
    }
    await git(["--git-dir", repository, "fast-import", "--quiet", "--date-format=raw", "--done"], importChunks());
    await git(["--git-dir", repository, "symbolic-ref", "HEAD", ref]);
    const [snapshotCommit, snapshotTree] = (await git(["--git-dir", repository, "rev-parse", "HEAD", "HEAD^{tree}"])).toString("utf8").trim().split("\n");
    const body = await git(["--git-dir", repository, "bundle", "create", "--version=2", "-", ref, "HEAD"], [], maxBytes);
    check();
    return { body, sourceSnapshot: nativeSourceSnapshotSchema.parse({ schemaVersion: 1, format: "git_bundle", scopeVersion: 2,
      sourceContentSha256: source.manifest!.contentSha256, snapshotCommit, snapshotTree }) };
  } catch {
    // Git/parser failures may embed source paths or bytes; never preserve causes.
    throw failure();
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => { throw failure(); });
  }
}
