import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { GitHubCiReadDependencies } from "./github-ci-proof-reader.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const snapshotSchema = z.object({ sourceSnapshotTreeSha: sha, sourceContentSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type GitHubCiSourceSnapshot = z.infer<typeof snapshotSchema>;
export interface GitHubCiSourceMapping extends GitHubCiSourceSnapshot { version: 1; commitTreeSha: string }
const entrySchema = z.object({ path: z.string().min(1).max(4096).refine(name =>
  !/[\x00-\x1f\x7f/\\]/.test(name) && ![".", "..", ".git"].includes(name)
  && Buffer.from(name).toString("utf8") === name), mode: z.enum(["040000", "100644", "100755", "120000", "160000"]),
  type: z.enum(["tree", "blob", "commit"]), sha,
}).refine(entry => entry.type === (entry.mode === "040000" ? "tree" : entry.mode === "160000" ? "commit" : "blob")
  && (entry.mode !== "160000" || entry.path === ".verrail"));
const treeSchema = z.object({ sha, truncated: z.literal(false), tree: z.array(entrySchema).max(20_000) })
  .refine(value => new Set(value.tree.map(entry => entry.path)).size === value.tree.length);
const failure = () => new Error("GitHub CI source mapping failed");

/** Compare independently read Git objects, never a caller assertion of tree equality. */
export async function mapGitHubCiSource(input: {
  source: GitHubCiSourceSnapshot; repository: string; testedCandidateSha: string;
  get: GitHubCiReadDependencies["get"]; signal?: AbortSignal; timeoutMs?: number; maxResponseBytes?: number;
}): Promise<GitHubCiSourceMapping> {
  const timeout = input.timeoutMs ?? 30_000, maxBytes = input.maxResponseBytes ?? 2_000_000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const deadline = performance.now() + (Number.isSafeInteger(timeout) ? Math.max(0, Math.min(timeout, 30_000)) : 0);
  const check = () => { if (controller.signal.aborted || performance.now() >= deadline) throw failure(); };
  const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  let temporary: string | undefined;
  try {
    check();
    const source = snapshotSchema.parse(input.source);
    const candidateSha = sha.parse(input.testedCandidateSha);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || input.repository.split("/").some(part => part === "." || part === "..")
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2_000_000) throw failure();
    const json = async (endpoint: string): Promise<unknown> => {
      check();
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(failure()); controller.signal.addEventListener("abort", rejectAbort, { once: true }); });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancel = () => { void reader?.cancel().catch(() => {}); };
      try {
        const pending = input.get(endpoint, { method: "GET", redirect: "manual", signal: controller.signal });
        void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
        const response = await Promise.race([pending, aborted]);
        if (response.status !== 200 || response.redirected || !response.body) { await response.body?.cancel(); throw failure(); }
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body.cancel(); throw failure(); }
        reader = response.body.getReader(); controller.signal.addEventListener("abort", cancel, { once: true });
        const chunks: Uint8Array[] = []; let total = 0;
        while (true) {
          check(); const next = await Promise.race([reader.read(), aborted]); check();
          if (next.done) break;
          total += next.value.byteLength; if (total > maxBytes) throw failure(); chunks.push(next.value);
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } finally {
        if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
        controller.signal.removeEventListener("abort", cancel); await reader?.cancel().catch(() => {});
      }
    };
    const base = `/repos/${input.repository}`;
    const commit = z.object({ sha, tree: z.object({ sha }) }).parse(await json(`${base}/git/commits/${candidateSha}`));
    if (commit.sha !== candidateSha) throw failure();
    const root = treeSchema.parse(await json(`${base}/git/trees/${commit.tree.sha}`));
    if (root.sha !== commit.tree.sha) throw failure();
    check(); temporary = await mkdtemp(path.join(os.tmpdir(), "verrail-ci-tree-"));
    const repository = path.join(temporary, "objects.git");
    const git = (args: string[], body = Buffer.alloc(0)): Promise<string> => {
      check();
      return new Promise((resolve, reject) => {
        const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "--no-replace-objects", ...args], {
          cwd: temporary, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
          env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
        });
        let failed = false, bytes = 0, errorBytes = 0; const chunks: Buffer[] = [];
        const kill = () => {
          failed = true; child.stdin.destroy();
          try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        controller.signal.addEventListener("abort", kill, { once: true });
        child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16_384) kill(); if (!failed) chunks.push(chunk); });
        child.stderr.on("data", (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 65_536) kill(); });
        child.on("error", kill); child.stdin.on("error", kill);
        child.on("close", code => {
          controller.signal.removeEventListener("abort", kill);
          if (failed || code !== 0) reject(failure());
          else { try { check(); resolve(Buffer.concat(chunks).toString("utf8").trim()); } catch { reject(failure()); } }
        });
        child.stdin.end(body);
        if (controller.signal.aborted) kill();
      });
    };
    await git(["init", "--bare", "--quiet", "--template=", "--object-format=sha1", repository]);
    const tree = (entries: typeof root.tree) => git(["--git-dir", repository, "mktree", "--missing", "-z"],
      Buffer.from(entries.map(entry => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\0`).join("")));
    // Validate completeness independently before applying the one v2 exclusion.
    if (await tree(root.tree) !== root.sha || await tree(root.tree.filter(entry => entry.path !== ".verrail")) !== source.sourceSnapshotTreeSha) throw failure();
    check(); return { version: 1, commitTreeSha: root.sha, ...source };
  } catch { throw failure(); }
  finally {
    clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => { throw failure(); });
  }
}
