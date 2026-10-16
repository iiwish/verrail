import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateRepositoryTree } from "./repository-checkout.js";
import { assertRepositoryScratch } from "./repository-scratch.js";

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

class RepositoryGitCleanupError extends Error {
  constructor() { super("REPOSITORY_GIT_CLEANUP_FAILED"); }
}

export type RepositoryGitCommand = (args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
}) => Promise<string>;

export const runTrustedRepositoryGit: RepositoryGitCommand = async (args, options) => {
  if (process.platform === "win32") throw new Error("REPOSITORY_GIT_PLATFORM_UNSUPPORTED");
  options.signal.throwIfAborted();
  const child = spawn("git", args, { cwd: options.cwd, env: options.env,
    detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let didClose = false;
  const closed = new Promise<number | null>(resolve => child.once("close", code => { didClose = true; resolve(code); }));
  let notifyStopped!: () => void;
  const stopped = new Promise<null>(resolve => { notifyStopped = () => resolve(null); });
  const kill = () => {
    if (!child.pid) return;
    // A killed group can briefly remain while its members are being reaped.
    // Only the bounded absence check below can confirm cleanup, not kill().
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  };
  let failed = false;
  let bytes = 0;
  const output: Buffer[] = [];
  const stop = () => { failed = true; kill(); notifyStopped(); };
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
  child.once("exit", kill);
  try {
    const code = await Promise.race([closed, stopped]);
    if (failed || code !== 0) throw new Error("REPOSITORY_GIT_FAILED");
    return Buffer.concat(output).toString("utf8");
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
    // Bound both pipe closure and group disappearance, including denied signals.
    for (let attempt = 0; attempt < 100; attempt++) {
      kill();
      let absent = !child.pid;
      if (child.pid) {
        try { process.kill(-child.pid, 0); } catch (error) {
          absent = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      if (didClose && absent) break;
      if (attempt === 99) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        throw new RepositoryGitCleanupError();
      }
      await delay(20);
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
  let cleanupUnconfirmed = false;
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
  } catch (error) {
    cleanupUnconfirmed = error instanceof RepositoryGitCleanupError;
    throw new Error("REPOSITORY_GITHUB_ACQUISITION_FAILED");
  } finally {
    // Do not remove a private working directory that an unconfirmed process may still use.
    if (!cleanupUnconfirmed) await rm(root, { recursive: true, force: true });
  }
}
