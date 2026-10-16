import { createHash } from "node:crypto";
import { opencodeExecutionFactsSchema, opencodeExecutionObservationSchema, repositoryExecutionIdentitySchema,
  type OpencodeExecutionObservation, type RepositoryExecutionRequest } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { deriveOpenCodeExecutionFacts } from "@paperclipai/adapter-opencode-local/http-client";
import type { StorageService } from "../storage/types.js";
import { repositoryRequestSha256, type RepositoryRuntimeFacts } from "./repository-output-receipt.js";

export interface RepositoryExecutionObservationInput { facts: unknown; fullHistoryBody: Uint8Array }
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const fail = (): never => { throw new Error("REPOSITORY_EXECUTION_OBSERVATION_INVALID"); };
const logNamespace = "verrail/repository-execution-logs";
const observationNamespace = "verrail/repository-execution-observations";
const reference = (workspaceId: string, namespace: string, hash: string) => `storage:${workspaceId}/${namespace}/sha256/${hash}`;

/** Replays the exact bounded response, not a caller's usage total or receipt hash. */
export function validateRepositoryExecutionObservation(raw: unknown, body: Uint8Array, request: RepositoryExecutionRequest,
  expected: RepositoryRuntimeFacts): OpencodeExecutionObservation {
  try {
    const value = opencodeExecutionObservationSchema.parse(raw);
    const facts = value.facts;
    if (body.byteLength < 1 || body.byteLength > 2 * 1024 * 1024
      || canonicalJson(value.identity) !== canonicalJson(repositoryExecutionIdentitySchema.strip().parse(request))
      || value.requestSha256 !== repositoryRequestSha256(request)
      || facts.model !== request.model || facts.runtime !== request.runtime
      || value.log.contentHash !== digest(body) || value.log.bytes !== body.byteLength
      || value.log.contentRef !== reference(request.workspaceId, logNamespace, value.log.contentHash)
      || facts.fullHistory.sha256 !== value.log.contentHash || facts.fullHistory.bytes !== value.log.bytes
      || facts.fullHistory.projectionSha256 !== digest(canonicalJson(facts.messages))) fail();
    for (const field of ["runtime", "runtimeVersion", "model", "startedAt", "finishedAt", "cleanup"] as const) {
      if (canonicalJson(facts[field]) !== canonicalJson(expected[field])) fail();
    }
    const history = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    const replay = deriveOpenCodeExecutionFacts(history, { model: request.model, finalMessageId: facts.messageId }, facts.sessionId,
      { time: { created: Date.parse(facts.sessionCreatedAt) } }, { version: facts.runtimeVersion, verifiedAt: facts.healthVerifiedAt });
    for (const field of ["runtimeVersion", "healthVerifiedAt", "sessionId", "sessionCreatedAt", "messageId", "model", "providerId", "modelId",
      "messages", "usageStatus", "usageScope", "usage", "costStatus", "costBasis", "reportedCostUsd"] as const) {
      if (canonicalJson(facts[field]) !== canonicalJson(replay[field])) fail();
    }
    if (facts.fullHistory.messageCount !== history.length
      || facts.fullHistory.partCount !== history.reduce((total: number, entry: { parts: unknown[] }) => total + entry.parts.length, 0)) fail();
    const { checkedAt: beforeTime, ...before } = facts.runtimeWitness.before;
    const { checkedAt: afterTime, ...after } = facts.runtimeWitness.after;
    if (canonicalJson(before) !== canonicalJson(after) || before.configuration.model !== request.model
      || before.configuration.smallModel !== request.model || !before.configuration.enabledProviders.includes(facts.providerId)
      || new Set(before.configuration.enabledProviders).size !== before.configuration.enabledProviders.length) fail();
    const candidate = facts.candidateRuntime;
    if (candidate && (candidate.executionIdentitySha256 !== digest(canonicalJson(value.identity))
      || candidate.httpSession.sessionId !== facts.sessionId || candidate.httpSession.createdAt !== facts.sessionCreatedAt
      || candidate.httpSession.runtimeVersion !== facts.runtimeVersion || candidate.httpSession.homeSha256 !== before.environment.homeSha256)) fail();
    const times = [facts.startedAt, facts.healthVerifiedAt, facts.sessionCreatedAt, beforeTime, facts.messages[0]!.createdAt,
      facts.messages.at(-1)!.completedAt!, afterTime, facts.finishedAt, value.recordedAt].map(Date.parse);
    if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time < times[index - 1]!))) fail();
    return value;
  } catch { return fail(); }
}

// Only a trusted runtime callback supplies this input. Neither model manifests
// nor user-uploaded artifacts can select execution observations or private logs.
export async function persistRepositoryExecutionObservation(input: {
  request: RepositoryExecutionRequest; execution: RepositoryExecutionObservationInput; expected: RepositoryRuntimeFacts;
  storage: Pick<StorageService, "putFile">; revalidate: () => Promise<void>;
}) {
  const { request, expected } = input;
  const body = Buffer.from(input.execution.fullHistoryBody);
  if (body.length < 1 || body.length > 2 * 1024 * 1024) fail();
  const logHash = digest(body);
  const observation = validateRepositoryExecutionObservation({ schemaVersion: 1, kind: "verrail.opencode-execution-observation",
    identity: repositoryExecutionIdentitySchema.strip().parse(request), requestSha256: repositoryRequestSha256(request), recordedAt: new Date().toISOString(),
    facts: opencodeExecutionFactsSchema.parse(input.execution.facts),
    log: { contentHash: logHash, bytes: body.length, contentRef: reference(request.workspaceId, logNamespace, logHash) },
  }, body, request, expected);
  const encoded = Buffer.from(canonicalJson(observation));
  if (encoded.length > 64 * 1024) fail();
  const put = async (namespace: string, value: Buffer) => {
    const hash = digest(value);
    await input.revalidate();
    const stored = await input.storage.putFile({ companyId: request.workspaceId, namespace,
      originalFilename: "observation.json", contentType: "application/json", body: value, contentAddressed: true });
    await input.revalidate();
    if (stored.sha256 !== hash || stored.byteSize !== value.length
      || `storage:${stored.objectKey}` !== reference(request.workspaceId, namespace, hash)) fail();
    return { contentHash: hash, contentRef: `storage:${stored.objectKey}`, bytes: value.length };
  };
  await put(logNamespace, body);
  return put(observationNamespace, encoded);
}
