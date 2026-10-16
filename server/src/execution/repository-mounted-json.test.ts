import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readMountedJson } from "./repository-mounted-json.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "verrail-mounted-json-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("reads a bounded regular file and rejects an oversized file", async () => {
  const path = join(root, "input.json");
  await writeFile(path, '{"ok":true}', { mode: 0o600 });
  expect(await readMountedJson(path, 11)).toEqual({ ok: true });
  await expect(readMountedJson(path, 10)).rejects.toThrow("MOUNT_INVALID");
});

it("rejects symlinks, directories and writable shared configuration", async () => {
  const path = join(root, "input.json"), link = join(root, "link");
  await writeFile(path, "{}", { mode: 0o600 });
  await symlink(path, link);
  await expect(readMountedJson(link, 100)).rejects.toThrow();
  await expect(readMountedJson(root, 100)).rejects.toThrow("MOUNT_INVALID");
  for (const mode of [0o620, 0o602]) {
    await chmod(path, mode);
    await expect(readMountedJson(path, 100)).rejects.toThrow("MOUNT_INVALID");
  }
});

it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
  const path = join(root, "pipe");
  execFileSync("mkfifo", [path]);
  await expect(readMountedJson(path, 100)).rejects.toThrow("MOUNT_INVALID");
}, 1000);

it("rejects missing paths, invalid limits and malformed JSON", async () => {
  await expect(readMountedJson(undefined, 100)).rejects.toThrow("MOUNT_REQUIRED");
  await expect(readMountedJson("relative", 100)).rejects.toThrow("MOUNT_REQUIRED");
  for (const limit of [0, -1, Infinity, 1.5, 1024 * 1024 + 1]) {
    await expect(readMountedJson(join(root, "missing"), limit)).rejects.toThrow("LIMIT_INVALID");
  }
  const path = join(root, "invalid.json");
  await writeFile(path, "not json", { mode: 0o600 });
  await expect(readMountedJson(path, 100)).rejects.toThrow();
});
