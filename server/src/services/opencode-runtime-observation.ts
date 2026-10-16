import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { repositoryExecutionRequestSchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { readPrivateProofJson } from "./delivery-proof-observation.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const relative = z.string().min(1).max(2048).refine(value => !path.isAbsolute(value)
  && value.split(/[\\/]/).every(part => part !== "" && part !== "." && part !== ".."));
const component = z.enum(["server", "domain", "repository_executor", "opencode"]);
export const openCodeCandidateIdentitySchema = repositoryExecutionRequestSchema.pick({ workspaceId: true, targetId: true,
  targetRevisionId: true, graphRevisionId: true, workNodeId: true, runId: true, runAttemptId: true, leaseId: true,
  fencingToken: true, agentVersionId: true, deploymentRevisionId: true }).strict();
export type OpenCodeCandidateIdentity = z.infer<typeof openCodeCandidateIdentitySchema>;
export const openCodeRuntimeManifestSchema = z.object({ schemaVersion: z.literal(1),
  kind: z.literal("verrail.opencode-runtime-manifest"), candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
  apiOriginSha256: hash, domainOriginSha256: hash, observerExecutableSha256: hash,
  components: z.array(z.object({ component, configurationSha256: hash, verifierBuildSha256: hash,
    executableSha256: hash, sourceManifestSha256: hash.nullable() }).strict()).length(4),
}).strict().refine(value => new Set(value.components.map(entry => entry.component)).size === 4
  && value.components.every(entry => (entry.component === "server" || entry.component === "repository_executor") === (entry.sourceManifestSha256 !== null)));
export type OpenCodeRuntimeManifest = z.infer<typeof openCodeRuntimeManifestSchema>;
export const openCodeRuntimeDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const openCodeWitnessDomain = Buffer.from("verrail.opencode-candidate-runtime.v1\0");
const unavailable = () => new Error("OPENCODE_CANDIDATE_WITNESS_UNAVAILABLE");

const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32768));
const native = z.object({ schemaVersion: z.literal(1), root: z.string().min(1), candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
  executable: z.string().min(1), executableSha256: hash, args: z.array(z.string().max(4096)).max(32), env }).strict();
const node = native.omit({ args: true }).extend({ entrypoint: relative,
  files: z.array(z.object({ path: relative, sha256: hash }).strict()).min(1).max(10000),
  generatedScriptSha256: z.array(hash).max(256).optional(),
}).strict();
export const openCodeObserverConfigurationSchema = z.object({ schemaVersion: z.literal(1), component,
  sessionId: z.string().uuid(), manifestSha256: hash, verifierBuildSha256: hash, observerExecutableSha256: hash,
  directory: z.string().min(1), privateKey: z.string().min(1).max(4096), node: node.optional(), native: native.optional(),
  opencode: native.pick({ candidateCommit: true, executable: true, executableSha256: true }).extend({ version: z.literal("1.17.13") }).strict().optional(),
}).strict().refine(value => value.component === "opencode" ? !!value.opencode && !value.native && !value.node
  : value.component === "domain" ? !!value.native && !value.node && !value.opencode : !!value.node && !value.native && !value.opencode);
export type OpenCodeObserverConfiguration = z.infer<typeof openCodeObserverConfigurationSchema>;
export function openCodeObserverConfigurationDigest(config: OpenCodeObserverConfiguration) {
  return openCodeRuntimeDigest(config.opencode ? { engine: "native", mode: "isolated_opencode_http", config: config.opencode }
    : { engine: config.node ? "node" : "native", config: config.node ?? config.native });
}

const observationBase = { schemaVersion: z.literal(1), observerSessionId: z.string().uuid(), pid: z.number().int().positive(),
  candidateCommit: z.string().regex(/^[a-f0-9]{40}$/), executableSha256: hash, startedAt: timestamp, observedAt: timestamp,
  limitations: z.array(z.string().min(1).max(128)).max(8), sha256: hash };
const nativeObservation = z.object({ ...observationBase, kind: z.literal("verrail.native-runtime-observation"),
  assurance: z.literal("launch_owned_immutable_executable"), finishedAt: timestamp.nullable(),
  exitCode: z.number().int().nullable(), signal: z.string().max(32).nullable() }).strict();
const nodeObservation = z.object({ ...observationBase, kind: z.literal("verrail.node-runtime-observation"),
  assurance: z.literal("observed_main_thread_scripts"), manifestSha256: hash,
  scripts: z.array(z.object({ path: relative, sha256: hash }).strict()).min(1).max(10000),
  generatedScriptSha256: z.array(hash).max(256) }).strict();
export const openCodeHttpSessionSchema = z.object({ sessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/),
  runtimeVersion: z.literal("1.17.13"), createdAt: timestamp, homeSha256: hash }).strict();
export const openCodeObserverStartedSchema = z.object({ kind: z.literal("verrail.opencode-runtime-started"),
  nativePid: z.number().int().positive(), observerPid: z.number().int().positive(), sessionId: z.string().uuid(), manifestSha256: hash }).strict();
export const openCodeObserverBoundSchema = openCodeObserverStartedSchema.extend({ kind: z.literal("verrail.opencode-session-bound"),
  executionIdentitySha256: hash, httpSession: openCodeHttpSessionSchema }).strict();
export type OpenCodeCandidateRuntimeBinding = z.infer<typeof openCodeObserverBoundSchema>;
export const openCodeCandidateWitnessSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("verrail.opencode-candidate-runtime-witness"),
  component, phase: z.enum(["checkpoint", "terminated"]), sessionId: z.string().uuid(), requestId: z.string().uuid().nullable(),
  manifestSha256: hash, verifierBuildSha256: hash, observerExecutableSha256: hash, configurationSha256: hash,
  observerPid: z.number().int().positive(), observation: z.union([nodeObservation, nativeObservation]),
  executionIdentity: openCodeCandidateIdentitySchema.nullable(), httpSession: openCodeHttpSessionSchema.nullable(),
  launch: z.object({ rootSha256: hash, argvSha256: hash, environmentSha256: hash }).strict(),
  termination: z.object({ requestedSignal: z.enum(["SIGTERM", "SIGINT"]), finishedAt: timestamp,
    processGroupStopped: z.literal(true), immutableExecutableRemoved: z.literal(true) }).strict().nullable(),
}).strict();
export const openCodeObserverReadySchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("verrail.opencode-candidate-runtime-ready"),
  component, sessionId: z.string().uuid(), manifestSha256: hash, verifierBuildSha256: hash,
  observerPid: z.number().int().positive() }).strict();
export const openCodeCheckpointRequestSchema = z.object({ requestId: z.string().uuid(), requestedAt: timestamp }).strict();
const envelopeSchema = z.object({ schemaVersion: z.literal(1), payload: z.string().max(900_000), signature: z.string().max(128) }).strict();
export type OpenCodeWitnessEnvelopeRef = { contentHash: string; bytes: number; contentRef: string };
async function archiveEnvelope(directory: string, raw: unknown): Promise<OpenCodeWitnessEnvelopeRef> {
  const bytes = Buffer.from(canonicalJson(envelopeSchema.parse(raw))), contentHash = createHash("sha256").update(bytes).digest("hex");
  let parent = directory;
  for (const part of ["witness-archive", "sha256"]) {
    parent = path.join(parent, part);
    try { await mkdir(parent, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const metadata = await stat(parent);
    if (await realpath(parent) !== parent || !metadata.isDirectory() || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o077)) throw unavailable();
  }
  const filename = path.join(parent, `${contentHash}.json`);
  try {
    const file = await open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o400 || metadata.nlink !== 1
      || metadata.size !== bytes.length || !(await file.readFile()).equals(bytes)) throw unavailable();
  } finally { await file.close(); }
  return { contentHash, bytes: bytes.length, contentRef: `private-witness:sha256:${contentHash}` };
}
export function openCodeWitnessPrefix(directory: string, sessionId: string, part: z.infer<typeof component>, identity?: OpenCodeCandidateIdentity) {
  if (!z.string().uuid().safeParse(sessionId).success || !path.isAbsolute(directory)
    || (part === "opencode" && !identity)) throw unavailable();
  return path.join(directory, `${sessionId}-${part}${part === "opencode" ? `-${openCodeCandidateIdentitySchema.parse(identity).runAttemptId}` : ""}`);
}
export type OpenCodeRuntimeCollectionInput = {
  identity: OpenCodeCandidateIdentity;
  runtimeWindow: { startedAt: string; finishedAt: string };
  httpSession: z.infer<typeof openCodeHttpSessionSchema> & { completedAt: string };
};

/** Independently signed launch-owned witnesses; no legacy heartbeat identity aliases. */
export async function collectOpenCodeRuntimeWitnesses(config: { directory: string; publicKey: string; sessionId: string;
  manifest: OpenCodeRuntimeManifest; manifestSha256: string }, input: OpenCodeRuntimeCollectionInput) {
  const manifest = openCodeRuntimeManifestSchema.parse(config.manifest), identity = openCodeCandidateIdentitySchema.parse(input.identity);
  const { completedAt, ...httpSession } = input.httpSession;
  openCodeHttpSessionSchema.parse(httpSession);
  const start = Date.parse(timestamp.parse(input.runtimeWindow.startedAt)), end = Date.parse(timestamp.parse(input.runtimeWindow.finishedAt));
  const sessionStart = Date.parse(httpSession.createdAt), sessionEnd = Date.parse(timestamp.parse(completedAt));
  if (!path.isAbsolute(config.directory) || await realpath(config.directory) !== config.directory
    || !z.string().uuid().safeParse(config.sessionId).success || openCodeRuntimeDigest(manifest) !== config.manifestSha256
    || !(start <= sessionStart && sessionStart <= sessionEnd && sessionEnd <= end && end <= Date.now())) throw unavailable();
  const key = createPublicKey(config.publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw unavailable();
  const decode = <T>(raw: unknown, schema: z.ZodType<T>): T => {
    const envelope = envelopeSchema.parse(raw), bytes = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "base64");
    if (bytes.toString("base64") !== envelope.payload || signature.toString("base64") !== envelope.signature
      || !verify(null, Buffer.concat([openCodeWitnessDomain, bytes]), key, signature)) throw unavailable();
    return schema.parse(JSON.parse(bytes.toString("utf8")));
  };
  const witnesses: (z.infer<typeof openCodeCandidateWitnessSchema> & { envelopeRef: OpenCodeWitnessEnvelopeRef })[] = [];
  for (const entry of manifest.components) {
    const prefix = openCodeWitnessPrefix(config.directory, config.sessionId, entry.component, identity);
    const ready = decode(await readPrivateProofJson(`${prefix}.ready.json`), openCodeObserverReadySchema);
    if (ready.component !== entry.component || ready.sessionId !== config.sessionId || ready.manifestSha256 !== config.manifestSha256
      || ready.verifierBuildSha256 !== entry.verifierBuildSha256) throw unavailable();
    let witness: z.infer<typeof openCodeCandidateWitnessSchema> | undefined, signedEnvelope: unknown;
    if (entry.component === "opencode") {
      signedEnvelope = await readPrivateProofJson(`${prefix}.witness.json`);
      witness = decode(signedEnvelope, openCodeCandidateWitnessSchema);
    }
    else {
      const request = { requestId: randomUUID(), requestedAt: new Date().toISOString() }, requestPath = `${prefix}.checkpoint.json`;
      // A file nonce avoids signaling an unsigned or reused PID from a stale ready file.
      await writeFile(requestPath, JSON.stringify(request), { flag: "wx", mode: 0o600 });
      try {
        while (Date.now() - Date.parse(request.requestedAt) < 12_000) {
          try {
            const raw = await readPrivateProofJson(`${prefix}.witness.json`), candidate = decode(raw, openCodeCandidateWitnessSchema);
            if (candidate.requestId === request.requestId && Date.parse(candidate.observation.observedAt) >= Date.parse(request.requestedAt)) {
              witness = candidate; signedEnvelope = raw; break;
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } finally { await unlink(requestPath); }
    }
    if (!witness || witness.component !== entry.component || witness.sessionId !== config.sessionId || witness.observerPid !== ready.observerPid
      || witness.manifestSha256 !== config.manifestSha256 || witness.configurationSha256 !== entry.configurationSha256
      || witness.verifierBuildSha256 !== entry.verifierBuildSha256 || witness.observerExecutableSha256 !== manifest.observerExecutableSha256
      || witness.observation.candidateCommit !== manifest.candidateCommit || witness.observation.executableSha256 !== entry.executableSha256
      || Date.parse(witness.observation.observedAt) > Date.now()) throw unavailable();
    const { sha256, ...observation } = witness.observation;
    if (openCodeRuntimeDigest(observation) !== sha256) throw unavailable();
    if (entry.sourceManifestSha256 !== null) {
      if (witness.observation.kind !== "verrail.node-runtime-observation" || witness.observation.manifestSha256 !== entry.sourceManifestSha256) throw unavailable();
    } else if (witness.observation.kind !== "verrail.native-runtime-observation") throw unavailable();
    if (entry.component === "opencode") {
      if (witness.phase !== "terminated" || witness.requestId !== null || !witness.termination
        || witness.observation.kind !== "verrail.native-runtime-observation" || witness.observation.finishedAt !== null
        || witness.observation.exitCode !== null || witness.observation.signal !== null
        || canonicalJson(witness.executionIdentity) !== canonicalJson(identity) || canonicalJson(witness.httpSession) !== canonicalJson(httpSession)
        || witness.launch.rootSha256 !== httpSession.homeSha256 || Date.parse(witness.observation.startedAt) > sessionStart
        || Date.parse(witness.observation.observedAt) < sessionEnd || Date.parse(witness.termination.finishedAt) < Date.parse(witness.observation.observedAt)
        || Date.parse(witness.termination.finishedAt) > end) throw unavailable();
    } else if (witness.phase !== "checkpoint" || witness.termination !== null || witness.executionIdentity !== null || witness.httpSession !== null
      || Date.parse(witness.observation.startedAt) > start || Date.parse(witness.observation.observedAt) < end
      || (witness.observation.kind === "verrail.native-runtime-observation" && witness.observation.finishedAt !== null)) throw unavailable();
    witnesses.push({ ...witness, envelopeRef: await archiveEnvelope(config.directory, signedEnvelope) });
  }
  return { schemaVersion: 1 as const, kind: "verrail.opencode-candidate-runtime-observation" as const,
    sessionId: config.sessionId, manifestSha256: config.manifestSha256, witnesses };
}
