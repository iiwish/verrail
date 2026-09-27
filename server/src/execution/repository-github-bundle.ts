import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateRepositoryTree } from "./repository-checkout.js";
import { assertRepositoryScratch } from "./repository-scratch.js";

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

export type RepositoryGitCommand = (args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
}) => Promise<string>;

export const runTrustedRepositoryGit: RepositoryGitCommand = async (args, options) => {
  if (process.platform === "win32") throw new Error("REPOSITORY_GIT_PLATFORM_UNSUPPORTED");
  options.signal.throwIfAborted();
  const child = spawn("git", args, { cwd: options.cwd, env: options.env,
    detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
  const kill = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let cleanupFailed = false;
  let failed = false;
  let bytes = 0;
  const output: Buffer[] = [];
  const stop = () => { failed = true; try { kill(); } catch { cleanupFailed = true; } };
  const collect = (chunk: Buffer, retain: boolean) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) { stop(); return; }
    if (retain) output.push(chunk);
  };
  child.stdout.on("data", chunk => collect(chunk, true));
  child.stderr.on("data", chunk => collect(chunk, false));
  child.once("error", stop);
  const timer = setTimeout(stop, 120_000);
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  child.once("exit", () => { try { kill(); } catch { cleanupFailed = true; } });
  try {
    const code = await closed;
    if (failed || code !== 0) throw new Error("REPOSITORY_GIT_FAILED");
    return Buffer.concat(output).toString("utf8");
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
    kill();
    await closed;
    kill();
    if (cleanupFailed) throw new Error("REPOSITORY_GIT_CLEANUP_FAILED");
    if (child.pid) {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(-child.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw new Error("REPOSITORY_GIT_CLEANUP_FAILED");
        }
        if (attempt === 99) throw new Error("REPOSITORY_GIT_CLEANUP_FAILED");
        await delay(20);
      }
    }
  }
};

/** Acquisition worker only. Never run with the harness or expose its environment. */
export async function acquireRepositoryGitHubBundle(options: {
  repository: string; baseCommit: string; authorization: string; signal: AbortSignal;
  scratchRoot: string; validateScratch?: typeof assertRepositoryScratch;
  recheck: () => Promise<void>;
  git?: RepositoryGitCommand;
}) {
  const parts = options.repository.split("/");
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]{1,200}$/.test(part) || part === "." || part === "..")
    || !/^[a-f0-9]{40}$/.test(options.baseCommit)
    || options.authorization.length > 8192 || !/^(?:Bearer|token) [A-Za-z0-9._~-]+$/.test(options.authorization)) {
    throw new Error("REPOSITORY_GITHUB_SOURCE_INVALID");
  }
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]);
  signal.throwIfAborted();
  await (options.validateScratch ?? assertRepositoryScratch)(options.scratchRoot);
  try { await options.recheck(); } catch { throw new Error("REPOSITORY_GITHUB_ACQUISITION_FAILED"); }
  const root = await mkdtemp(join(options.scratchRoot, "verrail-github-source-"));
  try {
    const cwd = join(root, "source");
    const home = join(root, "home");
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
    const run = async (args: string[], credential = false) => {
      signal.throwIfAborted();
      const value = await (options.git ?? runTrustedRepositoryGit)([
        "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
        "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
        "-c", "http.followRedirects=false", "-c", "fetch.fsckObjects=true", ...args,
      ], { cwd, signal, env: credential ? { ...env,
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `Authorization: ${options.authorization}`,
      } : env });
      signal.throwIfAborted();
      return value;
    };
    await run(["init", "--bare", "--template=", "--object-format=sha1"]);
    await run(["fetch", "--no-tags", "--no-recurse-submodules",
      `https://github.com/${options.repository}.git`, `${options.baseCommit}:refs/heads/source`], true);
    await options.recheck();
    const commit = (await run(["rev-parse", "--verify", "refs/heads/source^{commit}"])).trim();
    if (commit !== options.baseCommit) throw new Error("REPOSITORY_COMMIT_INVALID");
    validateRepositoryTree(await run(["ls-tree", "-rlz", "--full-tree", commit]));
    const path = join(root, "source.bundle");
    await run(["bundle", "create", path, "refs/heads/source"]);
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX_BUNDLE_BYTES) throw new Error("REPOSITORY_BUNDLE_LIMIT");
    const bundle = await readFile(path);
    if (bundle.length !== info.size) throw new Error("REPOSITORY_BUNDLE_CHANGED");
    await options.recheck();
    signal.throwIfAborted();
    return { bundle, baseCommit: commit, contentHash: createHash("sha256").update(bundle).digest("hex") };
  } catch {
    throw new Error("REPOSITORY_GITHUB_ACQUISITION_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
