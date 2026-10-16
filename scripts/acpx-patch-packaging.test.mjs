import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import cliEsbuildConfig from "../cli/esbuild.config.mjs";
import { bundledCliNpmDependencies } from "./cli-bundled-npm-dependencies.mjs";
import {
  createBundledInstallManifest,
  materializePublishManifest,
} from "./prepare-bundled-package.mjs";

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const adapterUtilsPackage = JSON.parse(
  await readFile(new URL("../packages/adapter-utils/package.json", import.meta.url), "utf8"),
);
const dbPackage = JSON.parse(
  await readFile(new URL("../packages/db/package.json", import.meta.url), "utf8"),
);
const releaseScript = await readFile(new URL("./release.sh", import.meta.url), "utf8");
const releaseLib = await readFile(new URL("./release-lib.sh", import.meta.url), "utf8");
const buildNpmScript = await readFile(new URL("./build-npm.sh", import.meta.url), "utf8");

function fixtureEnvironment(directory, binDirectory) {
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  return {
    PATH: [binDirectory, dirname(process.execPath), "/usr/bin", "/bin"].filter(Boolean).join(":"),
    HOME: home,
    TMPDIR: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

test("published packages preserve the patched ACPX runtime", () => {
  assert.equal(
    rootPackage.pnpm.patchedDependencies["acpx@0.12.0"],
    "patches/acpx@0.12.0.patch",
  );
  assert.equal(adapterUtilsPackage.dependencies.acpx, "0.12.0");
  assert.deepEqual(adapterUtilsPackage.bundleDependencies, ["acpx"]);
  assert.equal(bundledCliNpmDependencies.has("acpx"), true);
  assert.equal(cliEsbuildConfig.external.includes("acpx"), false);
});

test("the shipped ACPX patch filters agent and terminal credential overlays", async () => {
  const patch = await readFile(new URL("../patches/acpx@0.12.0.patch", import.meta.url), "utf8");
  assert.match(patch, /VERRAIL_DOMAIN_API_TOKEN/);
  assert.match(patch, /VERRAIL_GITHUB_CI_PROOF_TOKEN/);
  assert.match(patch, /ACPX_AUTH_/);
  assert.match(patch, /return withoutControlPlaneCredentials\(env\)/);
  assert.match(patch, /return withoutControlPlaneCredentials\(merged\)/);
  assert.match(patch, /for \(const entry of env \?\? \[\]\)/);
});

test("the entire ACPX patch passes strict Git whitespace checks", (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-patch-whitespace-"));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  const result = spawnSync("git", [
    "-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab",
    "diff", "--no-index", "--check", "--", "/dev/null",
    new URL("../patches/acpx@0.12.0.patch", import.meta.url).pathname,
  ], { cwd: fixtureDir, env: fixtureEnvironment(fixtureDir), encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.equal(`${result.stdout}${result.stderr}`, "");
});

test("Git and the package staging patch command preserve every ACPX package file", (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-patch-roundtrip-"));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  const env = fixtureEnvironment(fixtureDir);
  const require = createRequire(new URL("../packages/adapter-utils/package.json", import.meta.url));
  const installed = dirname(require.resolve("acpx/package.json"));
  const patch = readFileSync(new URL("../patches/acpx@0.12.0.patch", import.meta.url), "utf8");
  const pristine = join(fixtureDir, "pristine");
  cpSync(installed, pristine, { recursive: true });
  execFileSync("git", ["apply", "--unidiff-zero", "--reverse", "-"], { cwd: pristine, env, input: patch, timeout: 10000 });

  const inventory = (directory) => readdirSync(directory, { recursive: true }).sort().flatMap((file) => {
    const absolute = join(directory, file);
    const stat = lstatSync(absolute);
    assert.equal(stat.isSymbolicLink(), false, `Unexpected package symlink: ${file}`);
    return stat.isFile() ? [{ file, mode: stat.mode & 0o777, sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex") }] : [];
  });
  const expected = inventory(installed);
  // Whole-hunk replacement keeps tab-indented context out of the patch file.
  // Git needs its zero-context parser; the production staging command does not.
  for (const command of ["git", "patch"]) {
    const destination = join(fixtureDir, command);
    cpSync(pristine, destination, { recursive: true });
    const args = command === "git" ? ["apply", "--unidiff-zero", "-"] : ["-p1", "--forward", "-d", destination];
    execFileSync(command, args, { cwd: destination, env, input: patch, timeout: 10000 });
    const actual = inventory(destination);
    for (const file of expected) assert.deepEqual(actual.find((entry) => entry.file === file.file), file);
    // BSD patch can retain preimage backups. Verify their bytes instead of
    // overlooking unexpected files or comparing them with the patched runtime.
    for (const extra of actual.filter((entry) => !expected.some((file) => file.file === entry.file))) {
      assert.equal(command, "patch");
      assert.match(extra.file, /\.orig$/);
      const original = inventory(pristine).find((entry) => entry.file === extra.file.slice(0, -5));
      assert.ok(original, `Unexpected backup: ${extra.file}`);
      assert.deepEqual(extra, { ...original, file: extra.file });
    }
  }
});

test("published packages preserve the patched embedded-postgres runtime", () => {
  assert.equal(
    rootPackage.pnpm.patchedDependencies["embedded-postgres@18.1.0-beta.16"],
    "patches/embedded-postgres@18.1.0-beta.16.patch",
  );
  assert.deepEqual(dbPackage.bundleDependencies, ["embedded-postgres"]);
  assert.equal(bundledCliNpmDependencies.has("embedded-postgres"), true);
  assert.equal(cliEsbuildConfig.external.includes("embedded-postgres"), false);
});

test("bundled package staging materializes publishConfig entrypoints", () => {
  const staged = materializePublishManifest(adapterUtilsPackage);

  assert.equal(staged.publishConfig, undefined);
  assert.equal(staged.main, "./dist/index.js");
  assert.equal(staged.types, "./dist/index.d.ts");
  assert.deepEqual(staged.exports, adapterUtilsPackage.publishConfig.exports);
});

test("bundled package staging materializes workspace dependency versions", () => {
  const staged = materializePublishManifest({
    name: "@paperclipai/example",
    version: "2026.723.0",
    dependencies: { exact: "workspace:*", caret: "workspace:^", tilde: "workspace:~" },
  });

  assert.deepEqual(staged.dependencies, {
    exact: "2026.723.0",
    caret: "^2026.723.0",
    tilde: "~2026.723.0",
  });
});

test("bundled package staging installs only dependencies included in the tarball", () => {
  const installManifest = createBundledInstallManifest(
    {
      name: "@paperclipai/db",
      version: "2026.723.0-canary.8",
      dependencies: {
        "@paperclipai/shared": "2026.723.0-canary.8",
        "drizzle-orm": "^0.45.2",
        "embedded-postgres": "^18.1.0-beta.16",
      },
      bundleDependencies: ["embedded-postgres"],
    },
    ["embedded-postgres"],
  );

  assert.deepEqual(installManifest.dependencies, {
    "embedded-postgres": "^18.1.0-beta.16",
  });
  assert.deepEqual(installManifest.bundleDependencies, ["embedded-postgres"]);
});

test("bundled package staging rebuilds npm dependencies and applies the acpx patch", (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "paperclip-bundled-stage-"));
  const sourceDir = join(fixtureDir, "source");
  const destinationDir = join(fixtureDir, "destination");
  const binDir = join(fixtureDir, "bin");
  const callLog = join(fixtureDir, "calls.log");
  mkdirSync(sourceDir);
  mkdirSync(join(sourceDir, "dist"));
  writeFileSync(join(sourceDir, "dist", "index.js"), "export {};\n");
  mkdirSync(destinationDir);
  mkdirSync(binDir);
  writeFileSync(join(sourceDir, "package.json"), JSON.stringify(adapterUtilsPackage));
  writeFileSync(callLog, "");
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  const writeExecutable = (name, body) => {
    writeFileSync(join(binDir, name), body, { mode: 0o755 });
  };
  writeExecutable(
    "pnpm",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\\n' "$*" >> "$FAKE_CALL_LOG"
destination="\${!#}"
cp "$FAKE_SOURCE_PACKAGE" "$destination/package.json"
mkdir -p "$destination/node_modules/.pnpm"
`,
  );
  writeExecutable(
    "npm",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> "$FAKE_CALL_LOG"
[ "$*" = "install --omit=dev --ignore-scripts --no-audit --no-fund" ]
mkdir -p node_modules/acpx/dist
printf 'unpatched runtime\\n' > node_modules/acpx/dist/runtime.js
`,
  );
  writeExecutable(
    "patch",
    `#!/usr/bin/env bash
set -euo pipefail
printf 'patch %s\\n' "$*" >> "$FAKE_CALL_LOG"
target=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    target="$2"
    shift 2
  else
    shift
  fi
done
patch_input="$(cat)"
grep -q onAgentStderr <<< "$patch_input"
printf 'patched onAgentStderr runtime\\n' > "$target/dist/runtime.js"
`,
  );

  execFileSync(
    process.execPath,
    [new URL("./prepare-bundled-package.mjs", import.meta.url).pathname, sourceDir, destinationDir],
    {
      env: {
        ...fixtureEnvironment(fixtureDir, binDir),
        FAKE_CALL_LOG: callLog,
        FAKE_SOURCE_PACKAGE: join(sourceDir, "package.json"),
      },
      stdio: "pipe",
    },
  );

  const stagedAcpxDir = join(destinationDir, "node_modules/acpx");
  assert.equal(lstatSync(stagedAcpxDir).isDirectory(), true);
  assert.equal(lstatSync(stagedAcpxDir).isSymbolicLink(), false);
  assert.equal(existsSync(join(destinationDir, "node_modules/.pnpm")), false);
  assert.match(readFileSync(join(stagedAcpxDir, "dist/runtime.js"), "utf8"), /onAgentStderr/);
  assert.match(
    readFileSync(callLog, "utf8"),
    /patch -p1 --forward -d .*node_modules\/acpx/,
  );
});

test("bundled package dry runs preview without querying published versions", () => {
  assert.match(releaseScript, /run_bundled_npm_pack pack --pack-destination "\$publish_dir"/);
  assert.match(releaseLib, /BUNDLED_NPM_PACK_VERSION="10\.9\.7"/);
  assert.match(releaseLib, /BUNDLED_NPM_PUBLISH_VERSION="11\.18\.0"/);
  assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PACK_VERSION"/);
  assert.match(releaseLib, /npx --yes "npm@\$BUNDLED_NPM_PUBLISH_VERSION"/);
  assert.match(releaseLib, /"\$@" --loglevel verbose/);
  assert.match(releaseLib, /run_bundled_npm_publish publish --tag "\$dist_tag"/);
  assert.doesNotMatch(releaseLib, /run_bundled_npm_publish publish "\.\/\$tarball"/);
});

test("npm builds use corepack instead of requiring a global pnpm", () => {
  assert.match(buildNpmScript, /corepack pnpm -r typecheck/);
  assert.doesNotMatch(buildNpmScript, /^\s*pnpm -r typecheck/m);
});
