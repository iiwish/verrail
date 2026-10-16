import { z } from "zod";
import { repositoryExecutionIdentitySchema } from "@paperclipai/shared";
import { recoveryProcessIdentitySchema, recoveryRuntimeDigest, repositoryRecoveryFinalSchema,
  recoveryStaleResponseSchema } from "./repository-recovery-runtime-observation.js";
import type { loadRepositoryRecoveryRuntimeContext } from "./repository-recovery-proof-reader.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), uuid = z.string().uuid(), time = z.iso.datetime();
const reference = z.object({ contentHash: hash, bytes: z.number().int().min(1).max(1024 * 1024),
  contentRef: z.string().regex(/^private-recovery:sha256:[a-f0-9]{64}$/) }).strict()
  .refine(value => value.contentRef === `private-recovery:sha256:${value.contentHash}`);
const snapshot = z.object({ process: recoveryProcessIdentitySchema, observerSessionId: uuid,
  candidateCommit: z.string().regex(/^[a-f0-9]{40}$/), executableSha256: hash, sourceManifestSha256: hash,
  observationSha256: hash, startedAt: time, observedAt: time }).strict();
const probe = z.object({ journalSha256: hash, requestSha256: hash, responseSha256: hash,
  challenge: uuid, issuedAt: time, receivedAt: time }).strict();
export const repositoryRecoveryProofSchema = z.object({ schemaVersion: z.literal(1),
  kind: z.literal("verrail.repository-recovery-closed-context"), recoverySessionId: uuid, nonce: uuid,
  candidateSessionId: uuid, runtimeManifestSha256: hash, configurationSha256: hash,
  identity: repositoryExecutionIdentitySchema, preRuntimeProofSha256: hash,
  authorizationSha256: hash, transitionSha256: hash, completionAuthorizationSha256: hash, finalSha256: hash,
  before: z.object({ contextSha256: hash, observedAt: time, durableSha256: hash, outputReceiptSha256: hash,
    executionObservationSha256: hash, executionLogSha256: hash, executionSessionId: z.string().regex(/^ses_[A-Za-z0-9]+$/),
    artifactCount: z.number().int().min(1).max(10) }).strict(),
  after: z.object({ contextSha256: hash, sourceContextSha256: hash, eventsSha256: hash,
    artifactsSha256: hash, authoritativeResultSha256: hash }).strict(),
  runtime: z.object({ observerProcess: recoveryProcessIdentitySchema, old: snapshot, next: snapshot,
    oldStopped: repositoryRecoveryFinalSchema.shape.oldStopped, nextStopped: repositoryRecoveryFinalSchema.shape.nextStopped,
    ownedCleanup: repositoryRecoveryFinalSchema.shape.ownedCleanup }).strict(),
  probes: z.object({ authorizationSha256: hash, baselineSha256: hash, staleCheckpointSha256: hash,
    oldAttemptId: uuid, oldAttemptNumber: z.number().int().positive(), oldLeaseId: uuid,
    oldFencingToken: z.number().int().positive(), nextCursor: z.number().int().positive(),
    oldAttemptSha256: hash, oldLeaseSha256: hash, oldEventsSha256: hash,
    currentAttemptSha256: hash, currentRunSha256: hash, currentLeaseSha256: hash,
    duplicate: probe, stale: probe.extend({ requestHash: hash, idempotencyKey: z.string().min(1).max(200),
      receiptId: uuid, receiptSha256: hash, receiptCreatedAt: time, auditId: uuid, auditSha256: hash,
      auditOccurredAt: time, response: recoveryStaleResponseSchema }).strict() }).strict(),
  archives: z.object({ before: reference, probe: reference, after: reference, ready: reference, authorization: reference,
    transition: reference, probeAuthorization: reference, duplicateJournal: reference, staleJournal: reference,
    completionAuthorization: reference, final: reference }).strict(),
  limitations: z.tuple([z.literal("not_hostile_same_uid_isolation"), z.literal("known_detached_groups_only"),
    z.literal("command_cleanup_from_candidate_executor_stop_ack"), z.literal("not_full_host_disaster_recovery")]),
}).strict();

/** Full signatures, actual journals and DB/storage facts are validated before this bounded projection. */
export function projectRepositoryRecoveryProof(context: Awaited<ReturnType<typeof loadRepositoryRecoveryRuntimeContext>>) {
  const { ready, checkpoint, completion, transition, terminal, staleContext } = context;
  const summarizeSnapshot = (value: typeof ready.old) => ({ process: value.process,
    observerSessionId: value.observation.observerSessionId, candidateCommit: value.observation.candidateCommit,
    executableSha256: value.observation.executableSha256, sourceManifestSha256: value.observation.manifestSha256,
    observationSha256: value.observation.sha256, startedAt: value.observation.startedAt, observedAt: value.observation.observedAt });
  const summarizeProbe = (journal: typeof context.staleJournal) => ({ journalSha256: recoveryRuntimeDigest(journal),
    requestSha256: journal.requestSha256, responseSha256: journal.responseSha256,
    challenge: JSON.parse(journal.request).challenge, issuedAt: journal.issuedAt, receivedAt: journal.receivedAt });
  const baseline = staleContext.probeCheckpoint;
  return repositoryRecoveryProofSchema.parse({ schemaVersion: 1, kind: "verrail.repository-recovery-closed-context",
    recoverySessionId: ready.recoverySessionId, nonce: ready.nonce, candidateSessionId: ready.candidateSessionId,
    runtimeManifestSha256: ready.runtimeManifestSha256, configurationSha256: ready.configurationSha256, identity: ready.identity,
    preRuntimeProofSha256: recoveryRuntimeDigest(context.preRuntime), authorizationSha256: recoveryRuntimeDigest(context.authorization),
    transitionSha256: recoveryRuntimeDigest(transition), completionAuthorizationSha256: recoveryRuntimeDigest(context.completionAuthorization),
    finalSha256: recoveryRuntimeDigest(terminal), before: { contextSha256: checkpoint.contextSha256, observedAt: checkpoint.observedAt,
      durableSha256: recoveryRuntimeDigest(checkpoint.durable), outputReceiptSha256: checkpoint.durable.outputReceiptSha256,
      executionObservationSha256: checkpoint.durable.executionObservationSha256, executionLogSha256: checkpoint.durable.executionLogSha256,
      executionSessionId: checkpoint.durable.executionSessionId, artifactCount: checkpoint.durable.artifactCount },
    after: { contextSha256: completion.contextSha256, sourceContextSha256: completion.sourceContextSha256,
      eventsSha256: completion.eventsSha256, artifactsSha256: completion.artifactsSha256,
      authoritativeResultSha256: completion.authoritativeResultSha256 },
    runtime: { observerProcess: ready.observerProcess, old: summarizeSnapshot(transition.old), next: summarizeSnapshot(terminal.next),
      oldStopped: terminal.oldStopped, nextStopped: terminal.nextStopped, ownedCleanup: terminal.ownedCleanup },
    probes: { authorizationSha256: recoveryRuntimeDigest(context.probeAuthorization), baselineSha256: context.probeAuthorization.completionBaselineSha256,
      staleCheckpointSha256: baseline.contextSha256, oldAttemptId: baseline.oldAttemptId, oldAttemptNumber: baseline.oldAttemptNumber,
      oldLeaseId: baseline.oldLeaseId, oldFencingToken: baseline.oldFencingToken, nextCursor: baseline.nextCursor,
      oldAttemptSha256: baseline.oldAttemptSha256, oldLeaseSha256: baseline.oldLeaseSha256, oldEventsSha256: baseline.oldEventsSha256,
      currentAttemptSha256: baseline.currentAttemptSha256, currentRunSha256: baseline.currentRunSha256, currentLeaseSha256: baseline.currentLeaseSha256,
      duplicate: summarizeProbe(context.duplicateJournal), stale: { ...summarizeProbe(context.staleJournal),
        requestHash: staleContext.requestHash, idempotencyKey: staleContext.idempotencyKey, receiptId: staleContext.receiptId,
        receiptSha256: staleContext.receiptSha256, receiptCreatedAt: staleContext.receiptCreatedAt,
        auditId: staleContext.auditId, auditSha256: staleContext.auditSha256, auditOccurredAt: staleContext.auditOccurredAt,
        response: staleContext.response } }, archives: context.archives,
    limitations: ["not_hostile_same_uid_isolation", "known_detached_groups_only", "command_cleanup_from_candidate_executor_stop_ack",
      "not_full_host_disaster_recovery"] });
}
