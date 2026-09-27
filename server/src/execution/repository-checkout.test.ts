import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareRepositoryCheckout, validateRepositoryTree } from "./repository-checkout.js";

it("bounds expanded source before checkout and parses filenames without line splitting", () => {
  const entry = (size: number, name = "file.txt") => `100644 blob ${"a".repeat(40)} ${size}\t${name}\0`;
  expect(() => validateRepositoryTree(entry(3, "line\nbreak.txt"))).not.toThrow();
  expect(() => validateRepositoryTree(entry(256 * 1024 * 1024 + 1))).toThrow("REPOSITORY_TREE_LIMIT");
  expect(() => validateRepositoryTree(entry(128 * 1024 * 1024).repeat(3))).toThrow("REPOSITORY_TREE_LIMIT");
  expect(() => validateRepositoryTree(entry(0).repeat(100_001))).toThrow("REPOSITORY_TREE_LIMIT");
  expect(() => validateRepositoryTree(entry(1, "nested/.gitmodules"))).toThrow("REPOSITORY_TREE_UNSUPPORTED");
});

it("checks out fixed source independently and rejects mismatched or unsafe inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "verrail-source-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root,
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--template=", "-b", "main");
    await writeFile(join(root, "hello.txt"), "original");
    git("add", "hello.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source");
    const source = async () => {
      git("bundle", "create", "source.bundle", "HEAD", "main");
      const bundle = await readFile(join(root, "source.bundle"));
      return { bundle, contentHash: createHash("sha256").update(bundle).digest("hex"), baseCommit: git("rev-parse", "HEAD") };
    };
    const input = await source();
    const checkout = await prepareRepositoryCheckout(input);
    try {
      expect(await readFile(join(checkout.cwd, "hello.txt"), "utf8")).toBe("original");
      await writeFile(join(checkout.cwd, "hello.txt"), "modified");
      expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("original");
    } finally { await checkout.dispose(); }
    await expect(prepareRepositoryCheckout({ ...input, contentHash: "0".repeat(64) })).rejects.toThrow("REPOSITORY_SOURCE_INVALID");
    await expect(prepareRepositoryCheckout({ ...input, baseCommit: "0".repeat(40) })).rejects.toThrow("REPOSITORY_CHECKOUT_FAILED");
    await symlink("/etc/passwd", join(root, "escape"));
    git("add", "escape");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "unsafe");
    await expect(prepareRepositoryCheckout(await source())).rejects.toThrow("REPOSITORY_CHECKOUT_FAILED");
  } finally { await rm(root, { recursive: true, force: true }); }
});
