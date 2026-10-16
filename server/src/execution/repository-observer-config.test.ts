import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { loadRepositoryObserverConfiguration } from "./repository-observer-config.js";
import { openCodeObserverConfigurationDigest, openCodeRuntimeDigest } from "../services/opencode-runtime-observation.js";

const roots: string[] = [], id = "11111111-1111-4111-8111-111111111111";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  // The production boundary deliberately rejects world-writable /tmp ancestors.
  const root = await realpath(await mkdtemp(path.join(process.cwd(), ".verrail-observer-test-"))); roots.push(root); await chmod(root, 0o700);
  const names = { command: path.join(root, "node"), entrypoint: path.join(root, "observer.mjs"), native: path.join(root, "opencode"),
    configurationFile: path.join(root, "observer.json"), manifestFile: path.join(root, "manifest.json"), config: path.join(root, "config.json"), directory: path.join(root, "witnesses") };
  await mkdir(names.directory, { mode: 0o700 });
  for (const name of [names.command, names.native]) await writeFile(name, `synthetic executable identity ${name}`, { mode: 0o700 });
  await writeFile(names.entrypoint, "// Synthetic bundle identity; never executed\n", { mode: 0o600 });
  const commandHash = hash(await readFile(names.command)), bundleHash = hash(await readFile(names.entrypoint)), nativeHash = hash(await readFile(names.native));
  const observer = { schemaVersion: 1 as const, component: "opencode" as const, sessionId: id, manifestSha256: "a".repeat(64),
    verifierBuildSha256: bundleHash, observerExecutableSha256: commandHash, directory: names.directory, privateKey: "synthetic-unused-key",
    opencode: { candidateCommit: "b".repeat(40), executable: names.native, executableSha256: nativeHash, version: "1.17.13" as const } };
  const manifest = { schemaVersion: 1, kind: "verrail.opencode-runtime-manifest", candidateCommit: "b".repeat(40),
    apiOriginSha256: "c".repeat(64), domainOriginSha256: "d".repeat(64), observerExecutableSha256: commandHash,
    components: ["server", "domain", "repository_executor", "opencode"].map(component => ({ component,
      configurationSha256: component === "opencode" ? openCodeObserverConfigurationDigest(observer) : "e".repeat(64),
      verifierBuildSha256: bundleHash, executableSha256: component === "opencode" ? nativeHash : "f".repeat(64),
      sourceManifestSha256: ["server", "repository_executor"].includes(component) ? "a".repeat(64) : null })) };
  const manifestSha256 = openCodeRuntimeDigest(manifest); observer.manifestSha256 = manifestSha256;
  await writeFile(names.manifestFile, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(names.configurationFile, JSON.stringify(observer), { mode: 0o600 });
  const config = { schemaVersion: 1, command: names.command, entrypoint: names.entrypoint, configurationFile: names.configurationFile,
    configurationSha256: hash(await readFile(names.configurationFile)), manifestFile: names.manifestFile, manifestSha256, sessionId: id };
  const save = () => writeFile(names.config, JSON.stringify(config), { mode: 0o600 }); await save();
  return { root, names, config, observer, save };
}
it("is disabled only when the operator opt-in is absent", async () => {
  expect(await loadRepositoryObserverConfiguration(undefined)).toBeUndefined();
  await expect(loadRepositoryObserverConfiguration("")).rejects.toThrow("REPOSITORY_OBSERVER_CONFIGURATION_INVALID");
});
it("returns only fixed launch references after validating all pinned files, never private key content", async () => {
  const f = await fixture(); const value = await loadRepositoryObserverConfiguration(f.names.config);
  expect(value).toEqual({ command: f.names.command, entrypoint: f.names.entrypoint, configurationFile: f.names.configurationFile,
    sessionId: id, manifestSha256: f.config.manifestSha256 });
  expect(JSON.stringify(value)).not.toContain("synthetic-unused-key");
});
it.each(["unknown field", "relative command", "changed Node", "changed bundle", "changed native", "changed configuration", "manifest hash",
  "session", "config permissions", "parent permissions", "directory permissions", "symlink", "hardlink", "oversized config", "non-executable"])("rejects %s before any launch", async failure => {
  const f = await fixture();
  if (failure === "unknown field") Object.assign(f.config, { privateKey: "not admitted" });
  if (failure === "relative command") f.config.command = "node";
  if (failure === "changed Node") await writeFile(f.names.command, "changed");
  if (failure === "changed bundle") await writeFile(f.names.entrypoint, "changed");
  if (failure === "changed native") await writeFile(f.names.native, "changed");
  if (failure === "changed configuration") await writeFile(f.names.configurationFile, "{}");
  if (failure === "manifest hash") f.config.manifestSha256 = "f".repeat(64);
  if (failure === "session") f.config.sessionId = "22222222-2222-4222-8222-222222222222";
  if (failure === "parent permissions") await chmod(f.root, 0o777);
  if (failure === "directory permissions") await chmod(f.names.directory, 0o755);
  if (failure === "symlink") { const alias = path.join(f.root, "node-alias"); await symlink(f.names.command, alias); f.config.command = alias; }
  if (failure === "hardlink") await link(f.names.command, path.join(f.root, "another-node"));
  if (failure === "non-executable") await chmod(f.names.command, 0o600);
  await f.save();
  if (failure === "config permissions") await chmod(f.names.config, 0o644);
  if (failure === "oversized config") await writeFile(f.names.config, " ".repeat(65537));
  await expect(loadRepositoryObserverConfiguration(f.names.config)).rejects.toThrow("REPOSITORY_OBSERVER_CONFIGURATION_INVALID");
});
