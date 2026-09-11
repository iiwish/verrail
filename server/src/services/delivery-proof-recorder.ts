import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { link, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, toolConnections, verrailGithubRepoBindings } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { githubFixedCiProofTrustSchema, githubFixedCiProofCommandSchema, githubFixedCiProofResultSchema,
  recordGithubFixedCiProofSchema, targetIdempotencyKeySchema } from "@paperclipai/shared";
import { assertDeliveryProofReader, type DeliveryProofReaderAccess } from "./delivery-proof-reader-access.js";
import { loadCodexDeliverySourceContext, loadFeishuDeliverySourceContext } from "./github-ci-source-context.js";
import { parseGitHubCiPolicies } from "./github-ci-proof-policy.js";
import { createGitHubCiProofReader } from "./github-ci-proof-reader.js";
import { createGitHubCiReadDependencies } from "./github-ci-proof-adapters.js";
import { mapGitHubCiSource } from "./github-ci-source-mapping.js";
import { channelTargetProofContextInputSchema } from "./channel-target-proof-context.js";
import { observeChannelTargetProvider, type ChannelProviderObservationConfig } from "./channel-target-provider-observation.js";
import { codexExecutionProofContextInputSchema, loadCodexExecutionProofContext } from "./codex-execution-proof-context.js";
import { collectDeliveryRuntimeWitnesses, deliveryObservationHash, readPrivateProofJson } from "./delivery-proof-observation.js";
import type { RunLogStore } from "./run-log-store.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const deliveryProofTrustSchema = z.object({ schemaVersion: z.literal(1), ci: githubFixedCiProofTrustSchema,
  publicKey: z.string().length(44), readerPolicySha256: hash, verifierBuildSha256: hash, runtimeManifestSha256: hash,
  maxAgeMs: z.number().int().positive().max(300_000) }).strict();
const common = { idempotencyKey: targetIdempotencyKeySchema, ci: recordGithubFixedCiProofSchema };
export const deliveryProofRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("feishu_target"), channel: channelTargetProofContextInputSchema.omit({ workspaceId: true }) }).strict(),
  z.object({ ...common, kind: z.literal("codex_execution"), execution: codexExecutionProofContextInputSchema.omit({
    workspaceId: true, artifactRevisionId: true, fixedCiProofId: true }) }).strict(),
]);
export type DeliveryProofRecorderConfig = {
  trust: z.infer<typeof deliveryProofTrustSchema>; privateKey: string; domainOrigin: string;
  githubPolicy: string; githubAuthorization: string; channelProvider?: ChannelProviderObservationConfig;
  runtime: Parameters<typeof collectDeliveryRuntimeWitnesses>[0];
};
const unavailable = () => new Error("DELIVERY_PROOF_UNAVAILABLE");

/** The bundled private reader owns collection and signing. Requests contain references only. */
export async function recordDeliveryProof(db: Db, access: DeliveryProofReaderAccess, raw: unknown,
  config: DeliveryProofRecorderConfig, logs: Pick<RunLogStore, "read">) {
  const input = deliveryProofRequestSchema.parse(raw), trust = deliveryProofTrustSchema.parse(config.trust);
  const startedAt = new Date().toISOString(), workspaceId = access.workspaceId;
  const authority = await assertDeliveryProofReader(db, access);
  if (authority.policySha256 !== trust.readerPolicySha256 || workspaceId !== trust.ci.workspaceId
    || config.runtime.manifestSha256 !== trust.runtimeManifestSha256
    || config.runtime.manifest.candidateCommit !== trust.ci.workflowExecutionSha) throw unavailable();
  const privateKey = createPrivateKey(config.privateKey), publicKey = createPublicKey(privateKey);
  const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  if (privateKey.asymmetricKeyType !== "ed25519" || rawPublic !== trust.publicKey) throw unavailable();
  const origin = new URL(config.domainOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || !origin.port
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw unavailable();
  if (createHash("sha256").update(origin.origin).digest("hex") !== config.runtime.manifest.domainOriginSha256) throw unavailable();
  if (!path.isAbsolute(config.runtime.directory)) throw unavailable();
  const envelopePath = path.join(config.runtime.directory, `closed-${deliveryObservationHash([workspaceId, input.idempotencyKey])}.json`);
  const readEnvelope = async () => {
    const stored = z.object({ schemaVersion: z.literal(1), payload: z.string().max(60000), signature: z.string().max(128) }).strict()
      .parse(await readPrivateProofJson(envelopePath));
    const bytes = Buffer.from(stored.payload, "base64"), signature = Buffer.from(stored.signature, "base64");
    if (bytes.toString("base64") !== stored.payload || signature.toString("base64") !== stored.signature
      || !verify(null, Buffer.concat([Buffer.from("verrail.closed-delivery-proof.v1\0"), bytes]), publicKey, signature)) throw unavailable();
    const payload = JSON.parse(bytes.toString("utf8"));
    if (payload.workspaceId !== workspaceId || payload.idempotencyKey !== input.idempotencyKey
      || payload.trustProfileSha256 !== deliveryObservationHash(trust)
      || canonicalJson(JSON.parse(payload.observationJson).references) !== canonicalJson(input)) throw unavailable();
    return stored;
  };
  try { return await submitEnvelope(await readEnvelope(), origin, workspaceId, input.idempotencyKey); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const entries = parseGitHubCiPolicies(config.githubPolicy);
  const entry = entries.find(value => value.workspaceId === workspaceId && value.targetId === trust.ci.targetId);
  if (!entry || createHash("sha256").update(JSON.stringify(entry)).digest("hex") !== trust.ci.policySha256) throw unavailable();
  for (const key of ["workspaceId", "targetId", "targetRevisionId", "graphRevisionId", "connectionId", "bindingId"] as const) {
    if (entry[key] !== trust.ci[key]) throw unavailable();
  }
  if (entry.policy.repository !== trust.ci.repository || entry.policy.repositoryId !== trust.ci.repositoryId
    || entry.policy.workflowId !== trust.ci.workflowId || entry.policy.workflow.sha !== trust.ci.workflowExecutionSha
    || entry.policy.workflow.sha256 !== trust.ci.workflowSha256 || entry.policy.helper.sha256 !== trust.ci.helperSha256
    || entry.policy.maxAgeMs !== trust.ci.maxAgeMs) throw unavailable();
  const selection = { workspaceId, targetId: trust.ci.targetId, targetRevisionId: trust.ci.targetRevisionId,
    graphRevisionId: trust.ci.graphRevisionId, claimId: input.ci.claimId, workNodeId: input.ci.workNodeId,
    artifactRevisionId: input.ci.artifactRevisionId, requirementId: input.ci.requirementId };
  const loadSource = input.kind === "feishu_target" ? loadFeishuDeliverySourceContext : loadCodexDeliverySourceContext;
  const source = await loadSource(db, selection);
  const readBinding = async () => {
    const rows = await db.select({ id: verrailGithubRepoBindings.id, owner: verrailGithubRepoBindings.repoOwner,
      name: verrailGithubRepoBindings.repoName, connectionId: toolConnections.id, updatedAt: toolConnections.updatedAt,
      authKind: toolConnections.authKind }).from(verrailGithubRepoBindings).innerJoin(toolConnections,
      and(eq(toolConnections.id, verrailGithubRepoBindings.connectionId), eq(toolConnections.companyId, workspaceId),
        eq(toolConnections.enabled, true), eq(toolConnections.status, "active")))
      .where(and(eq(verrailGithubRepoBindings.workspaceId, workspaceId), eq(verrailGithubRepoBindings.id, entry.bindingId))).limit(2);
    const row = rows[0];
    if (rows.length !== 1 || !row || row.connectionId !== entry.connectionId
      || `${row.owner}/${row.name}` !== entry.policy.repository || !["oauth", "api_key"].includes(row.authKind)) throw unavailable();
    return deliveryObservationHash(row);
  };
  const binding = await readBinding();
  const dependencies = createGitHubCiReadDependencies({ repository: entry.policy.repository,
    authorization: config.githubAuthorization, artifactDownloadHosts: entry.policy.artifactDownloadHosts });
  const ci = await createGitHubCiProofReader(entry.policy, dependencies).read({ runId: input.ci.runId,
    runAttempt: input.ci.runAttempt, candidateSha: entry.policy.workflow.sha });
  const mapping = await mapGitHubCiSource({ source: source.snapshot, repository: entry.policy.repository,
    testedCandidateSha: ci.testedCandidateSha, get: dependencies.get, timeoutMs: entry.policy.timeoutMs,
    maxResponseBytes: entry.policy.maxResponseBytes });
  const readFacts = async () => {
    if (input.kind === "feishu_target") {
      if (!config.channelProvider) throw unavailable();
      const channel = await observeChannelTargetProvider(db, { ...input.channel, workspaceId }, config.channelProvider, { access });
      if (channel.runtimeSessionId !== config.runtime.sessionId || channel.pluginId !== config.runtime.manifest.pluginId) throw unavailable();
      return { channel, execution: null, window: { startedAt: channel.providerMessageCreatedAt, finishedAt: channel.providerReplyCreatedAt } };
    }
    const execution = await loadCodexExecutionProofContext(db, { ...input.execution, workspaceId }, { logs });
    const dispatch = execution.dispatchConfiguration, permission = execution.permissionObservation;
    if (execution.targetId !== selection.targetId || execution.targetRevisionId !== selection.targetRevisionId
      || execution.graphRevisionId !== selection.graphRevisionId || execution.runId !== source.source.runId
      || execution.runAttemptId !== source.source.runAttemptId || execution.runEventId !== source.source.runEventId
      || execution.outputReceiptSha256 !== source.source.outputReceiptSha256
      || !dispatch || dispatch.binding !== "version_bound" || dispatch.runtimeSessionId !== config.runtime.sessionId
      || !permission || permission.apiOriginSha256 !== config.runtime.manifest.apiOriginSha256
      || permission.dispatchSha256 !== dispatch.sha256) throw unavailable();
    return { channel: null, execution, window: execution.executionWindow };
  };
  const facts = await readFacts();
  const runtime = await collectDeliveryRuntimeWitnesses(config.runtime, facts.window);
  if (facts.execution) {
    const identity = runtime.witnesses.find(witness => witness.component === "harness")?.executionIdentity;
    if (!identity || identity.workspaceId !== workspaceId || identity.agentId !== facts.execution.agentId
      || identity.heartbeatRunId !== facts.execution.heartbeatRunId) throw unavailable();
  }
  if (source.contextSha256 !== (await loadSource(db, selection)).contextSha256 || binding !== await readBinding()) throw unavailable();
  const rechecked = await readFacts();
  if (facts.execution?.contextSha256 !== rechecked.execution?.contextSha256
    || facts.channel?.sourceContextSha256 !== rechecked.channel?.sourceContextSha256) throw unavailable();
  if ((await assertDeliveryProofReader(db, access)).policySha256 !== trust.readerPolicySha256) throw unavailable();
  const { workspaceId: _workspaceId, ...commandSelection } = selection;
  const command = githubFixedCiProofCommandSchema.parse({ schemaVersion: 1, ...commandSelection,
    criterionKey: source.criterionKey, source: source.source, ci: { providerRunId: ci.providerRunId,
      providerAttempt: ci.providerAttempt, testedCommit: ci.testedCandidateSha, verifiedAt: ci.verifiedAt,
      artifactId: ci.artifactId, archiveSha256: ci.archiveSha256, reportSha256: ci.reportSha256, observationSha256: ci.receiptSha256 }, mapping });
  const observationJson = canonicalJson({ schemaVersion: 1, kind: input.kind, references: input, runtime,
    channel: facts.channel, execution: facts.execution, ci, sourceContextSha256: source.contextSha256,
    assurance: "host_trusted_fixed_verifier", limitations: ["not_hostile_same_uid_isolation", "not_filesystem_or_network_isolation"] });
  const verifiedAt = new Date().toISOString();
  if (Date.parse(verifiedAt) - Date.parse(startedAt) > trust.maxAgeMs || Buffer.byteLength(observationJson) > 40000) throw unavailable();
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: input.kind, observationId: randomUUID(),
    idempotencyKey: input.idempotencyKey, workspaceId, trustProfileSha256: deliveryObservationHash(trust),
    readerPolicySha256: trust.readerPolicySha256, verifierBuildSha256: trust.verifierBuildSha256,
    runtimeManifestSha256: trust.runtimeManifestSha256, startedAt, verifiedAt, source: command, observationJson,
    observationSha256: createHash("sha256").update(observationJson).digest("hex") }));
  const envelope = { schemaVersion: 1, payload: payload.toString("base64"),
    signature: sign(null, Buffer.concat([Buffer.from("verrail.closed-delivery-proof.v1\0"), payload]), privateKey).toString("base64") };
  if (envelope.payload.length > 60000 || Buffer.byteLength(JSON.stringify(envelope)) > 65536) throw unavailable();
  const temporary = `${envelopePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
  try {
    try { await link(temporary, envelopePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary); }
  return submitEnvelope(await readEnvelope(), origin, workspaceId, input.idempotencyKey);
}

async function submitEnvelope(envelope: { schemaVersion: number; payload: string; signature: string }, origin: URL, workspaceId: string, idempotencyKey: string) {
  const body = JSON.stringify(envelope);
  if (Buffer.byteLength(body) > 65536) throw unavailable();
  const response = await fetch(new URL(`/v1/workspaces/${workspaceId}/delivery-proofs`, origin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body });
  if (!response.ok || response.redirected) { await response.body?.cancel(); throw unavailable(); }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16384) throw unavailable();
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return githubFixedCiProofResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
