import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_CHECKOUT_BYTES = 256 * 1024 * 1024;
const MAX_CHECKOUT_FILES = 100_000;

export function validateRepositoryTree(tree: string) {
  const entries = tree.split("\0").filter(Boolean);
  if (entries.length > MAX_CHECKOUT_FILES) throw new Error("REPOSITORY_TREE_LIMIT");
  let bytes = 0;
  for (const entry of entries) {
    const separator = entry.indexOf("\t");
    const metadata = /^(100644|100755) blob [a-f0-9]+ +([0-9]+)$/.exec(entry.slice(0, separator));
    const name = entry.slice(separator + 1);
    if (separator < 0 || !metadata || !name || name.startsWith("/")
      || name.split("/").some(part => ["", ".", "..", ".git", ".gitmodules"].includes(part.toLowerCase()))) {
      throw new Error("REPOSITORY_TREE_UNSUPPORTED");
    }
    const size = Number(metadata[2]);
    bytes += size;
    if (!Number.isSafeInteger(size) || bytes > MAX_CHECKOUT_BYTES) throw new Error("REPOSITORY_TREE_LIMIT");
  }
}

export async function prepareRepositoryCheckout(input: {
  bundle: Buffer;
  contentHash: string;
  baseCommit: string;
  signal?: AbortSignal;
  checkoutRoot?: string;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.contentHash)
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseCommit)
    || !input.bundle.length || input.bundle.length > MAX_BUNDLE_BYTES
    || createHash("sha256").update(input.bundle).digest("hex") !== input.contentHash) {
    throw new Error("REPOSITORY_SOURCE_INVALID");
  }
  input.signal?.throwIfAborted();
  const root = await mkdtemp(join(input.checkoutRoot ?? tmpdir(), "verrail-repository-"));
  const cwd = join(root, "checkout");
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    await mkdir(cwd, { mode: 0o700 });
    await mkdir(join(root, "home"), { mode: 0o700 });
    await mkdir(join(root, "hooks"), { mode: 0o700 });
    const bundle = join(root, "source.bundle");
    await writeFile(bundle, input.bundle, { mode: 0o600 });
    const git = async (args: string[]) => {
      const result = await execute("git", ["-c", `core.hooksPath=${join(root, "hooks")}`,
        "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
        cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: input.signal,
        env: { PATH: process.env.PATH, HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
      });
      return result.stdout;
    };
    await git(["init", "--template=", `--object-format=${input.baseCommit.length === 64 ? "sha256" : "sha1"}`]);
    await git(["bundle", "verify", bundle]);
    await git(["fetch", "--no-tags", bundle, "+refs/heads/*:refs/remotes/source/*"]);
    const commit = (await git(["rev-parse", "--verify", `${input.baseCommit}^{commit}`])).trim();
    if (commit !== input.baseCommit) throw new Error("REPOSITORY_COMMIT_INVALID");
    validateRepositoryTree(await git(["ls-tree", "-rlz", "--full-tree", commit]));
    await git(["checkout", "--detach", commit]);
    return { cwd, baseCommit: commit, dispose };
  } catch {
    await dispose();
    // Git diagnostics can contain untrusted filenames or source bytes.
    throw new Error("REPOSITORY_CHECKOUT_FAILED");
  }
}
