import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchParent =
  process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
  process.env.PAPERCLIP_SCRATCH_DIR ??
  tmpdir();
await mkdir(scratchParent, { recursive: true });
const scratchRoot = await mkdtemp(
  join(scratchParent, "paperclip-runner-consumer-"),
);
const artifactsRoot = resolve(scratchRoot, "artifacts");
const pnpmInvocation = resolvePnpmInvocation();
await mkdir(artifactsRoot, { recursive: true });

try {
  run("pnpm", ["run", "build:typescript"], runnerRoot);
  const runnerPackage = await pack(runnerRoot, artifactsRoot);
  assertPackageInventory(runnerPackage.files);
  const dependencyTarballs = await packRuntimeDependencyClosure(artifactsRoot);
  await verifyConsumer(
    resolve(scratchRoot, "consumer"),
    runnerPackage.tarball,
    dependencyTarballs,
  );
  process.stdout.write(
    "Clean-consumer check passed for the packed runner root and ./testing exports.\n",
  );
} finally {
  if (process.env.PAPERCLIP_KEEP_PACKAGE_CONSUMERS !== "1") {
    await rm(scratchRoot, { recursive: true, force: true });
  } else {
    process.stdout.write(`Kept clean-consumer scratch at ${scratchRoot}\n`);
  }
}

function assertPackageInventory(files) {
  const paths = new Set(files.map((file) => file.path));
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/testing.js",
    "dist/testing.d.ts",
    "protocol/manifest.json",
    "README.md",
    "package.json",
  ]) {
    if (!paths.has(required)) {
      throw new Error(`Packed runner is missing ${required}`);
    }
  }
  for (const file of paths) {
    if (
      file.startsWith("src/") ||
      file.startsWith("scripts/") ||
      file.startsWith("runner/") ||
      file.startsWith("devtools/") ||
      file.startsWith("examples/") ||
      file.startsWith("knowledge/") ||
      file.startsWith("infra/")
    ) {
      throw new Error(`Packed runner leaked a non-release path: ${file}`);
    }
  }
}

async function packRuntimeDependencyClosure(destination) {
  const runnerManifest = JSON.parse(
    await readFile(resolve(runnerRoot, "package.json"), "utf8"),
  );
  const overrides = {};
  const packed = new Map();
  const queued = new Set();
  const queue = [];

  const enqueue = async (packageRoot, overrideKey) => {
    const concreteRoot = await realpath(packageRoot);
    const manifest = JSON.parse(
      await readFile(resolve(concreteRoot, "package.json"), "utf8"),
    );
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Runtime dependency at ${concreteRoot} has no package identity`);
    }
    const identity = `${manifest.name}@${manifest.version}`;
    let tarball = packed.get(identity);
    if (tarball === undefined) {
      tarball = (await pack(concreteRoot, destination)).tarball;
      packed.set(identity, tarball);
    }
    overrides[overrideKey] = tarball;
    if (!queued.has(identity)) {
      queued.add(identity);
      queue.push({ root: concreteRoot, manifest });
    }
  };

  for (const packageName of Object.keys(runnerManifest.dependencies ?? {}).sort()) {
    await enqueue(resolve(runnerRoot, "node_modules", packageName), packageName);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    const required = current.manifest.dependencies ?? {};
    const optional = current.manifest.optionalDependencies ?? {};
    const peers = current.manifest.peerDependencies ?? {};
    const peerMeta = current.manifest.peerDependenciesMeta ?? {};
    for (const dependencyName of Object.keys({
      ...required,
      ...optional,
      ...peers,
    }).sort()) {
      const dependencyRoot = await resolveInstalledDependencyRoot(
        current.root,
        dependencyName,
      );
      if (dependencyRoot === null) {
        if (
          dependencyName in optional ||
          peerMeta[dependencyName]?.optional === true
        ) {
          continue;
        }
        throw new Error(
          `${current.manifest.name}@${current.manifest.version} dependency ${dependencyName} is not installed`,
        );
      }
      await enqueue(
        dependencyRoot,
        `${current.manifest.name}@${current.manifest.version}>${dependencyName}`,
      );
    }
  }
  return overrides;
}

async function resolveInstalledDependencyRoot(packageRoot, dependencyName) {
  let cursor = packageRoot;
  while (true) {
    const candidate = resolve(cursor, "node_modules", dependencyName);
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
}

async function verifyConsumer(consumerRoot, runnerTarball, dependencyTarballs) {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    resolve(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "paperclip-runner-clean-consumer",
        private: true,
        type: "module",
        packageManager: "pnpm@9.15.4",
        dependencies: {
          "@paperclipai/paperclip-runner": `file:${runnerTarball}`,
        },
        pnpm: {
          overrides: Object.fromEntries(
            Object.entries(dependencyTarballs).map(([selector, tarball]) => [
              selector,
              `file:${tarball}`,
            ]),
          ),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(consumerRoot, "verify.mjs"),
    `
import * as runtime from "@paperclipai/paperclip-runner";
import * as testing from "@paperclipai/paperclip-runner/testing";

if (typeof runtime.parsePrpFixtureText !== "function") {
  throw new Error("runtime protocol validation is absent");
}
if ("loadPrpFixture" in runtime || "runSemanticConformanceKit" in runtime) {
  throw new Error("test-only helpers leaked through the runtime root");
}
if (typeof testing.loadPrpFixture !== "function") {
  throw new Error("fixture loader is absent from ./testing");
}
if (typeof testing.runSemanticConformanceKit !== "function") {
  throw new Error("semantic conformance kit is absent from ./testing");
}

const fixture = await testing.loadPrpFixture();
const replay = testing.replayFixtureText(JSON.stringify(fixture));
if (!replay.ok || replay.snapshot.integrity !== "complete") {
  throw new Error("packed fixture did not validate and replay");
}

const observation = {
  authorization: { outcome: "allowed" },
  state: { status: "done" },
  effects: [],
  audit: [],
};
const report = await testing.runSemanticConformanceKit({
  vectors: [{ id: "finish", operationId: "finish_task", input: {} }],
  adapters: [
    { id: "mock", execute: async () => observation },
    { id: "real", execute: async () => ({ audit: [], effects: [], state: { status: "done" }, authorization: { outcome: "allowed" } }) },
  ],
});
if (report.rows.length !== 1) {
  throw new Error("packed semantic conformance kit returned the wrong row count");
}

for (const deferred of ["evals", "browser", "react", "standalone", "devtools", "live"]) {
  let denied = false;
  try {
    await import("@paperclipai/paperclip-runner/" + deferred);
  } catch (error) {
    denied = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";
  }
  if (!denied) throw new Error("deferred export unexpectedly resolved: " + deferred);
}
`,
  );

  run(
    "pnpm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--lockfile=false",
      "--store-dir",
      resolve(consumerRoot, ".pnpm-store"),
      "--config.auto-install-peers=false",
      "--reporter=append-only",
    ],
    consumerRoot,
    { env: { NODE_ENV: "production" } },
  );
  run(process.execPath, ["verify.mjs"], consumerRoot);
}

async function pack(packageRoot, destination) {
  const output = capture(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    packageRoot,
  );
  const records = JSON.parse(output);
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error(`Expected one npm pack record from ${packageRoot}`);
  }
  const record = records[0];
  if (!Array.isArray(record.files) || typeof record.filename !== "string") {
    throw new Error(`npm pack returned incomplete metadata for ${packageRoot}`);
  }
  return {
    tarball: resolve(destination, basename(record.filename)),
    files: record.files,
  };
}

function run(command, args, cwd, { env = {} } = {}) {
  const usesPnpm = command === "pnpm";
  const executable = usesPnpm ? pnpmInvocation.executable : command;
  const effectiveArgs = usesPnpm ? [...pnpmInvocation.prefixArgs, ...args] : args;
  const result = spawnSync(executable, effectiveArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...env },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    if (result.error !== undefined) process.stderr.write(`${String(result.error)}\n`);
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout;
}

function resolvePnpmInvocation() {
  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const corepackProbe = spawnSync(corepack, ["pnpm@9.15.4", "--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (corepackProbe.status === 0 && corepackProbe.stdout.trim() === "9.15.4") {
    return { executable: corepack, prefixArgs: ["pnpm@9.15.4"] };
  }

  const direct = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const directProbe = spawnSync(direct, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (directProbe.status === 0 && directProbe.stdout.trim() === "9.15.4") {
    return { executable: direct, prefixArgs: [] };
  }
  throw new Error(
    "Clean-consumer verification requires pnpm 9.15.4 via corepack or PATH",
  );
}
