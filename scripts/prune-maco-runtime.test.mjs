import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pruneMacoRuntime } from "./prune-maco-runtime.mjs";

test("removes native database payloads and links, preserving the lazy JS wrapper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "verrail-runtime-prune-"));
  try {
    const native = path.join(root, "node_modules/.pnpm/native/node_modules/@embedded-postgres/linux-x64");
    const wrapper = path.join(root, "node_modules/embedded-postgres");
    await mkdir(native, { recursive: true });
    await mkdir(wrapper, { recursive: true });
    await writeFile(path.join(native, "postgres"), "native fixture");
    await writeFile(path.join(wrapper, "package.json"), JSON.stringify({ name: "embedded-postgres" }));
    await symlink(path.dirname(native), path.join(root, "node_modules/@embedded-postgres"));
    for (const name of ["@electric-sql/pglite", "@openai/codex-linux-x64"]) {
      const location = path.join(root, "node_modules", name);
      await mkdir(location, { recursive: true });
      await writeFile(path.join(location, "package.json"), JSON.stringify({ name }));
    }
    const bin = path.join(root, "node_modules/.pnpm/node_modules/.bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex"), "pnpm command shim");
    const fixtures = path.join(root, "tests/fixtures/bin");
    await mkdir(fixtures, { recursive: true });
    await writeFile(path.join(fixtures, "codex"), "test harness fixture");
    assert.equal(await pruneMacoRuntime(root), 5);
    await assert.rejects(readFile(path.join(fixtures, "codex")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(path.join(wrapper, "package.json"), "utf8")).name, "embedded-postgres");
    assert.equal(await pruneMacoRuntime(root), 0);
    await writeFile(path.join(root, "initdb"), "unexpected fixture");
    await assert.rejects(pruneMacoRuntime(root), /binary remains/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
