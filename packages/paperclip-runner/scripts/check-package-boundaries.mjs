import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

const runnerManifest = await readJson(resolve(packageRoot, "package.json"));
const serverManifest = await readJson(resolve(repositoryRoot, "server/package.json"));
const runtimeIndex = await readText(resolve(packageRoot, "src/index.ts"));
const testingIndex = await readText(resolve(packageRoot, "src/testing.ts"));
const dockerfile = await readText(resolve(repositoryRoot, "Dockerfile"));
const prWorkflow = await readText(resolve(repositoryRoot, ".github/workflows/pr.yml"));
const releaseWorkflow = await readText(
  resolve(repositoryRoot, ".github/workflows/release-verify.yml"),
);

const violations = [];
const exportKeys = Object.keys(runnerManifest.exports ?? {}).sort();
if (JSON.stringify(exportKeys) !== JSON.stringify([".", "./testing"])) {
  violations.push(
    `runner exports must be exactly "." and "./testing"; received ${exportKeys.join(", ") || "none"}`,
  );
}
for (const [key, expected] of [
  [".", { types: "./dist/index.d.ts", import: "./dist/index.js" }],
  ["./testing", { types: "./dist/testing.d.ts", import: "./dist/testing.js" }],
]) {
  if (JSON.stringify(runnerManifest.exports?.[key]) !== JSON.stringify(expected)) {
    violations.push(`${key} export must target its built JavaScript and declaration files`);
  }
}
if (runnerManifest.private !== true) {
  violations.push("runner must remain private until its independent npm publication is approved");
}
if (runnerManifest.sideEffects !== false) {
  violations.push("runner must declare sideEffects false for its contract-only JavaScript surface");
}
if (runnerManifest.bin !== undefined) {
  violations.push("runner must not expose deferred CLI or lab binaries");
}

for (const privateRuntimeExport of [
  "./protocol/replay-loader.js",
  "./conformance/",
  "./testing.js",
]) {
  if (runtimeIndex.includes(privateRuntimeExport)) {
    violations.push(`runtime root must not expose test-only path ${privateRuntimeExport}`);
  }
}
for (const requiredTestingExport of [
  'export * from "./index.js"',
  'export * from "./conformance/semantic-conformance.js"',
  'export * from "./protocol/replay-loader.js"',
]) {
  if (!testingIndex.includes(requiredTestingExport)) {
    violations.push(`testing entry point is missing ${requiredTestingExport}`);
  }
}

const deferredExports = [
  "./evals",
  "./browser",
  "./react",
  "./standalone",
  "./devtools",
  "./live",
  "./styles.css",
];
for (const key of deferredExports) {
  if (runnerManifest.exports?.[key] !== undefined) {
    violations.push(`deferred package entry point must remain absent: ${key}`);
  }
}

if (serverManifest.dependencies?.[runnerManifest.name] !== undefined) {
  violations.push("published server runtime dependencies must not require the private runner package");
}
if (serverManifest.devDependencies?.[runnerManifest.name] !== "workspace:*") {
  violations.push("server must resolve runner from a workspace-only development dependency");
}
const serverBuildScript = serverManifest.scripts?.build ?? "";
if (!serverBuildScript.includes("vendor-paperclip-runner.mjs")) {
  violations.push("server build must vendor the built runner distribution");
}
if (!serverBuildScript.includes("paperclip-runner build:typescript")) {
  violations.push("server build must bootstrap the runner TypeScript distribution");
}
const serverPrepackScript = serverManifest.scripts?.prepack ?? "";
if (!serverPrepackScript.includes("prepare:ui-dist")) {
  violations.push("server prepack must prepare its packaged UI distribution");
}
if (!serverPrepackScript.includes("pnpm run build")) {
  violations.push("server prepack must build the complete server distribution");
}

for (const relativePath of [
  "server/scripts/vendor-paperclip-runner.mjs",
  "server/src/vendor/paperclip-runner/index.ts",
]) {
  await access(resolve(repositoryRoot, relativePath)).catch(() => {
    violations.push(`server vendoring boundary is missing ${relativePath}`);
  });
}
if (!dockerfile.includes("COPY packages/paperclip-runner/package.json packages/paperclip-runner/")) {
  violations.push("Docker dependency bootstrap must copy the runner package manifest");
}
if (!dockerfile.includes("server/dist/vendor/paperclip-runner/index.js")) {
  violations.push("Docker build must verify the vendored runner entry point");
}

const ciCommand = "pnpm --filter @paperclipai/paperclip-runner check:all";
if (!prWorkflow.includes(ciCommand)) {
  violations.push("PR CI must run the complete runner package gate");
}
if (!releaseWorkflow.includes(ciCommand)) {
  violations.push("release verification must run the complete runner package gate");
}

if (violations.length > 0) {
  process.stderr.write(
    `Package boundary check failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Package boundary check passed: runtime, testing, server vendoring, Docker, and CI surfaces are explicit.\n",
  );
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function readText(path) {
  return readFile(path, "utf8");
}
