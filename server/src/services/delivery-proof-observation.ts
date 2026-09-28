import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { deliveryRuntimeComponentSchema } from "./verrail-runtime-observation.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
export const deliveryRuntimeManifestSchema = z.object({
  schemaVersion: z.literal(1), candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
  apiOriginSha256: hash, domainOriginSha256: hash, pluginId: z.string().min(1),
  components: z.array(z.object({ component: deliveryRuntimeComponentSchema,
    configurationSha256: hash, verifierBuildSha256: hash }).strict()).length(4),
}).strict().refine(value => new Set(value.components.map(entry => entry.component)).size === 4);

export const deliveryObservationHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const unavailable = (reason?: string) => new Error("DELIVERY_RUNTIME_WITNESS_UNAVAILABLE", { cause: reason });

/** Private files are transport only; signatures and pinned configuration establish identity. */
export async function readPrivateProofJson(filename: string): Promise<unknown> {
  const directory = await stat(path.dirname(filename));
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)
      || !metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)
      || metadata.size > 1024 * 1024) throw unavailable();
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

const envelopeSchema = z.object({ schemaVersion: z.literal(1), payload: z.string().max(900_000), signature: z.string().max(128) }).strict();
const witnessSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("verrail.runtime-witness"), component: deliveryRuntimeComponentSchema,
  sessionId: z.string().uuid(), manifestSha256: hash, verifierBuildSha256: hash, configurationSha256: hash,
  observerPid: z.number().int().positive(), observation: z.object({
    schemaVersion: z.literal(1), kind: z.enum(["verrail.node-runtime-observation", "verrail.native-runtime-observation"]),
    candidateCommit: z.string(), startedAt: timestamp, observedAt: timestamp, sha256: hash,
    limitations: z.array(z.string()),
    finishedAt: timestamp.nullable().optional(), exitCode: z.number().int().nullable().optional(), signal: z.string().nullable().optional(),
  }).passthrough(),
  executionIdentity: z.object({ workspaceId: z.string().uuid().nullable(), agentId: z.string().uuid().nullable(),
    heartbeatRunId: z.string().uuid().nullable() }).strict().nullable(),
}).strict();
const readySchema = z.object({ schemaVersion: z.literal(1), sessionId: z.string().uuid(),
  component: deliveryRuntimeComponentSchema, observerPid: z.number().int().positive() }).strict();

export async function collectDeliveryRuntimeWitnesses(config: {
  directory: string; publicKey: string; sessionId: string;
  manifest: z.infer<typeof deliveryRuntimeManifestSchema>; manifestSha256: string;
}, sourceWindow: { startedAt: string; finishedAt: string }) {
  const manifest = deliveryRuntimeManifestSchema.parse(config.manifest);
  if (!path.isAbsolute(config.directory) || !z.string().uuid().safeParse(config.sessionId).success
    || deliveryObservationHash(manifest) !== config.manifestSha256) throw unavailable();
  const start = Date.parse(sourceWindow.startedAt), end = Date.parse(sourceWindow.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > Date.now()) throw unavailable();
  const key = createPublicKey(config.publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw unavailable();
  const witnesses: z.infer<typeof witnessSchema>[] = [];
  const decode = (raw: unknown) => {
    const envelope = envelopeSchema.parse(raw);
    const bytes = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "base64");
    if (bytes.toString("base64") !== envelope.payload || signature.toString("base64") !== envelope.signature
      || !verify(null, Buffer.concat([Buffer.from("verrail.runtime-witness.v1\0"), bytes]), key, signature)) throw unavailable();
    return witnessSchema.parse(JSON.parse(bytes.toString("utf8")));
  };
  for (const component of manifest.components) {
    const prefix = path.join(config.directory, `${config.sessionId}-${component.component}`);
    const ready = readySchema.parse(await readPrivateProofJson(`${prefix}.ready.json`));
    if (ready.sessionId !== config.sessionId || ready.component !== component.component) throw unavailable();
    const requestedAt = Date.now();
    let witness: z.infer<typeof witnessSchema> | undefined;
    if (component.component === "harness") {
      try {
        const terminal = decode(await readPrivateProofJson(`${prefix}.witness.json`));
        if (terminal.observation.kind === "verrail.native-runtime-observation" && terminal.observation.finishedAt) witness = terminal;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!witness) process.kill(ready.observerPid, "SIGUSR2");
    while (!witness && Date.now() - requestedAt < 12_000) {
      let raw: unknown;
      try { raw = await readPrivateProofJson(`${prefix}.witness.json`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (raw) {
        const candidate = decode(raw);
        if (Date.parse(candidate.observation.observedAt) >= requestedAt) { witness = candidate; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!witness) throw unavailable(`${component.component}:missing_checkpoint`);
    if (witness.component !== component.component || witness.sessionId !== config.sessionId
      || witness.observerPid !== ready.observerPid || witness.manifestSha256 !== config.manifestSha256
      || witness.configurationSha256 !== component.configurationSha256 || witness.verifierBuildSha256 !== component.verifierBuildSha256
      || witness.observation.candidateCommit !== manifest.candidateCommit
      || (component.component !== "harness" && witness.observation.kind !== (component.component === "domain" ? "verrail.native-runtime-observation" : "verrail.node-runtime-observation"))
      || Date.parse(witness.observation.observedAt) > Date.now()) throw unavailable(`${component.component}:binding`);
    if (component.component === "harness" && witness.observation.kind === "verrail.native-runtime-observation") {
      if (!witness.observation.finishedAt || witness.observation.exitCode !== 0 || witness.observation.signal !== null
        || Date.parse(witness.observation.startedAt) > end || Date.parse(witness.observation.finishedAt) < start
        || Date.parse(witness.observation.finishedAt) > end + 30_000
        || Date.parse(witness.observation.observedAt) < Date.parse(witness.observation.finishedAt)) throw unavailable(`harness:terminal:${JSON.stringify({
          exitCode: witness.observation.exitCode, signal: witness.observation.signal, startedAt: witness.observation.startedAt,
          finishedAt: witness.observation.finishedAt, observedAt: witness.observation.observedAt, sourceWindow })}`);
    } else if (Date.parse(witness.observation.startedAt) > (component.component === "harness" ? end : start)
      || Date.parse(witness.observation.observedAt) < end) throw unavailable();
    const { sha256, ...observation } = witness.observation;
    if (deliveryObservationHash(observation) !== sha256) throw unavailable();
    witnesses.push(witness);
  }
  return { schemaVersion: 1 as const, sessionId: config.sessionId, manifestSha256: config.manifestSha256, witnesses };
}
