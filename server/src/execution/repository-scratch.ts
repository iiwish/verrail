import { lstat, realpath, statfs } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

export async function assertRepositoryScratch(path: string): Promise<void> {
  if (process.platform !== "linux" || !isAbsolute(path) || path === "/" || normalize(path) !== path) {
    throw new Error("REPOSITORY_SCRATCH_INVALID");
  }
  const [info, resolved, fs] = await Promise.all([lstat(path), realpath(path), statfs(path, { bigint: true })]);
  if (!info.isDirectory() || info.isSymbolicLink() || resolved !== path
    || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700
    || fs.type !== 0x01021994n || fs.blocks <= 0n || fs.bsize <= 0n
    || fs.blocks * fs.bsize > 512n * 1024n * 1024n) {
    throw new Error("REPOSITORY_SCRATCH_INVALID");
  }
}
