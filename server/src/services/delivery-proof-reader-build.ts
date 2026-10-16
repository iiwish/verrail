import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

export async function buildDeliveryProofReader(outfile: string) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const result = await build({ entryPoints: [path.join(repo, "server/scripts/delivery-proof-reader.ts")], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", metafile: true,
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    banner: { js: "import { createRequire as __readerRequire } from 'node:module'; const require = __readerRequire(import.meta.url);" },
    plugins: [{ name: "reader-database-surface", setup(builder) {
      // Exclude operational backup and embedded-database entry points from the fixed reader.
      builder.onResolve({ filter: /^@paperclipai\/db$/ }, () => ({ path: "reader-db", namespace: "reader-db" }));
      builder.onLoad({ filter: /.*/, namespace: "reader-db" }, () => ({
        contents: `export { createDb } from ${JSON.stringify(path.join(repo, "packages/db/src/client.ts"))}; export * from ${JSON.stringify(path.join(repo, "packages/db/src/schema/index.ts"))};`,
        loader: "ts", resolveDir: repo,
      }));
    } }],
  });
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
  if (Object.values(result.metafile!.outputs).some(output => output.imports.some(item => !builtins.has(item.path.replace(/^node:/, ""))))) {
    throw new Error("PROOF_READER_EXTERNAL_DEPENDENCY");
  }
  return result;
}

export async function buildDeliveryProofRuntime(outfile: string) {
  if (/\s/.test(process.execPath)) throw new Error("PROOF_RUNTIME_EXECUTABLE_INVALID");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const result = await build({ entryPoints: [path.join(repo, "server/scripts/delivery-proof-runtime.ts")], outfile,
    bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent", metafile: true,
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    banner: { js: `#!${process.execPath}\nimport { createRequire as __runtimeRequire } from 'node:module'; const require = __runtimeRequire(import.meta.url);` },
  });
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
  if (Object.values(result.metafile!.outputs).some(output => output.imports.some(item => !builtins.has(item.path.replace(/^node:/, ""))))) {
    throw new Error("PROOF_RUNTIME_EXTERNAL_DEPENDENCY");
  }
  return result;
}
