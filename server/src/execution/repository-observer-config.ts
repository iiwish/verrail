import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { openCodeObserverConfigurationDigest, openCodeObserverConfigurationSchema, openCodeRuntimeDigest,
  openCodeRuntimeManifestSchema } from "../services/opencode-runtime-observation.js";
import type { createOpenCodeRepositoryRuntime } from "./opencode-repository-runtime.js";

const filename = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && path.resolve(value) === value);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ schemaVersion: z.literal(1), command: filename, entrypoint: filename, configurationFile: filename,
  configurationSha256: sha256, manifestFile: filename, manifestSha256: sha256, sessionId: z.string().uuid() }).strict();
const unavailable = () => new Error("REPOSITORY_OBSERVER_CONFIGURATION_INVALID");

async function checkParents(name: string) {
  const uid = process.getuid?.();
  if (uid === undefined || !filename.safeParse(name).success || await realpath(name) !== name) throw unavailable();
  let directory = path.dirname(name);
  while (true) {
    const value = await lstat(directory);
    if (!value.isDirectory() || value.isSymbolicLink() || ![0, uid].includes(value.uid) || (value.mode & 0o022)) throw unavailable();
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
}

async function readPinnedFile(name: string, maximum: number, privateFile: boolean, currentOwner = false) {
  await checkParents(name);
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(), uid = process.getuid!();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum
      || (currentOwner ? before.uid !== uid : ![0, uid].includes(before.uid))
      || (before.mode & (privateFile ? 0o077 : 0o022))) throw unavailable();
    const hash = createHash("sha256"), chunks: Buffer[] = [];
    let offset = 0;
    while (offset < before.size) {
      const chunk = Buffer.alloc(Math.min(65536, before.size - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) throw unavailable(); offset += bytesRead;
      hash.update(chunk.subarray(0, bytesRead));
      if (privateFile) chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat(), named = await lstat(name);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.nlink !== 1 || !named.isFile() || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) throw unavailable();
    await checkParents(name);
    return { hash: hash.digest("hex"), body: privateFile ? Buffer.concat(chunks) : null, mode: before.mode };
  } finally { await handle.close(); }
}

/** Opt-in operator configuration. Nothing from a model request or provider config selects this capability. */
export async function loadRepositoryObserverConfiguration(configFile: string | undefined): Promise<
  Parameters<typeof createOpenCodeRepositoryRuntime>[0]["trustedObserver"]> {
  if (configFile === undefined) return undefined;
  try {
    const input = schema.parse(JSON.parse((await readPinnedFile(configFile, 65536, true)).body!.toString("utf8")));
    const manifest = openCodeRuntimeManifestSchema.parse(JSON.parse((await readPinnedFile(input.manifestFile, 65536, true)).body!.toString("utf8")));
    if (openCodeRuntimeDigest(manifest) !== input.manifestSha256) throw unavailable();
    // The observer's own private-file reader requires its current UID, including
    // when the public manifest and Node executable are root-owned deployment files.
    const configFileValue = await readPinnedFile(input.configurationFile, 65536, true, true);
    if (configFileValue.hash !== input.configurationSha256) throw unavailable();
    const observer = openCodeObserverConfigurationSchema.parse(JSON.parse(configFileValue.body!.toString("utf8")));
    const component = manifest.components.find(value => value.component === "opencode");
    if (!component || observer.component !== "opencode" || observer.sessionId !== input.sessionId
      || observer.manifestSha256 !== input.manifestSha256 || observer.verifierBuildSha256 !== component.verifierBuildSha256
      || observer.observerExecutableSha256 !== manifest.observerExecutableSha256
      || openCodeObserverConfigurationDigest(observer) !== component.configurationSha256
      || observer.opencode!.candidateCommit !== manifest.candidateCommit
      || observer.opencode!.executableSha256 !== component.executableSha256) throw unavailable();
    const command = await readPinnedFile(input.command, 512 * 1024 * 1024, false);
    const entrypoint = await readPinnedFile(input.entrypoint, 8 * 1024 * 1024, false);
    const executable = await readPinnedFile(observer.opencode!.executable, 512 * 1024 * 1024, false);
    await checkParents(observer.directory);
    const directory = await lstat(observer.directory);
    if (!(command.mode & 0o111) || command.hash !== manifest.observerExecutableSha256
      || entrypoint.hash !== component.verifierBuildSha256 || !(executable.mode & 0o111) || executable.hash !== component.executableSha256
      || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o077)) throw unavailable();
    return { command: input.command, entrypoint: input.entrypoint, configurationFile: input.configurationFile,
      sessionId: input.sessionId, manifestSha256: input.manifestSha256 };
  } catch { throw unavailable(); }
}
