import { readdir, readFile, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Operate only on the disposable deployment output, never the workspace install.
export async function pruneMacoRuntime(root) {
  await rm(path.join(root, "tests"), { recursive: true, force: true });
  let removed = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const scope = path.basename(directory);
      if (entry.name === "@embedded-postgres" ||
        (scope === "@electric-sql" && entry.name === "pglite") ||
        (scope === ".bin" && entry.name === "codex") ||
        (scope === "@openai" && /^codex(?:-|$)/.test(entry.name))) {
        await rm(filename, { recursive: true, force: true });
        removed += 1;
      } else if (entry.isDirectory()) {
        await visit(filename);
      }
    }
  }
  await visit(root);
  async function verify(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await verify(filename);
      if (entry.isFile() && ["postgres", "postgres.wasm", "pglite.wasm", "initdb", "pg_ctl", "codex"].includes(entry.name)) {
        throw new Error(`Embedded database or harness binary remains in deployment output: ${path.relative(root, filename)}`);
      }
      if (entry.isFile() && entry.name === "package.json") {
        const metadata = JSON.parse(await readFile(filename, "utf8"));
        if (metadata.name?.startsWith("@embedded-postgres/") || metadata.name === "@electric-sql/pglite" || /^@openai\/codex(?:-|$)/.test(metadata.name ?? "")) {
          throw new Error("Embedded database or harness package remains in deployment output");
        }
      }
    }
  }
  await verify(root);
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (root !== "/out" || !(await lstat(root)).isDirectory()) {
    throw new Error("Expected disposable Docker deployment output /out");
  }
  console.log(`Pruned ${await pruneMacoRuntime(root)} embedded database and harness package locations`);
}
