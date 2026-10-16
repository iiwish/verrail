import { z } from "zod";
import { collectOpenCodeRuntimeWitnesses, openCodeCandidateIdentitySchema, openCodeHttpSessionSchema,
  openCodeCandidateWitnessSchema } from "./opencode-runtime-observation.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/), timestamp = z.iso.datetime();
const summary = z.object({ schemaVersion: z.literal(1), kind: z.literal("verrail.opencode-candidate-runtime-witness-summary"),
  component: z.enum(["server", "domain", "repository_executor", "opencode"]), phase: z.enum(["checkpoint", "terminated"]),
  sessionId: z.string().uuid(), requestId: z.string().uuid().nullable(), manifestSha256: hash,
  verifierBuildSha256: hash, observerExecutableSha256: hash, configurationSha256: hash, observerPid: z.number().int().positive(),
  observation: z.object({ sourceKind: z.enum(["verrail.node-runtime-observation", "verrail.native-runtime-observation"]),
    observerSessionId: z.string().uuid(), pid: z.number().int().positive(), candidateCommit: z.string().regex(/^[a-f0-9]{40}$/),
    executableSha256: hash, startedAt: timestamp, observedAt: timestamp, observationSha256: hash,
    sourceManifestSha256: hash.nullable(), scriptCount: z.number().int().min(0).max(10000),
    generatedScriptCount: z.number().int().min(0).max(256), finishedAt: timestamp.nullable(), exitCode: z.number().int().nullable(),
    signal: z.string().max(32).nullable(), limitations: z.array(z.string().min(1).max(128)).max(8),
  }).strict(), executionIdentity: openCodeCandidateIdentitySchema.nullable(), httpSession: openCodeHttpSessionSchema.nullable(),
  launch: openCodeCandidateWitnessSchema.shape.launch, termination: openCodeCandidateWitnessSchema.shape.termination,
  envelopeRef: z.object({ contentHash: hash, bytes: z.number().int().min(1).max(1024 * 1024),
    contentRef: z.string().regex(/^private-witness:sha256:[a-f0-9]{64}$/) }).strict(),
}).strict();
export const openCodeRuntimeProofSchema = z.object({ schemaVersion: z.literal(1),
  kind: z.literal("verrail.opencode-candidate-runtime-proof"), sessionId: z.string().uuid(), manifestSha256: hash,
  witnesses: z.array(summary).length(4),
}).strict().refine(value => new Set(value.witnesses.map(item => item.component)).size === 4
  && value.witnesses.every(item => item.sessionId === value.sessionId && item.manifestSha256 === value.manifestSha256
    && item.envelopeRef.contentRef === `private-witness:sha256:${item.envelopeRef.contentHash}`));

/** Only after independent full-witness verification and immutable private archival. */
export function projectOpenCodeRuntimeProof(runtime: Awaited<ReturnType<typeof collectOpenCodeRuntimeWitnesses>>) {
  return openCodeRuntimeProofSchema.parse({ schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-proof",
    sessionId: runtime.sessionId, manifestSha256: runtime.manifestSha256,
    witnesses: runtime.witnesses.map(witness => {
      const observation = witness.observation, node = observation.kind === "verrail.node-runtime-observation";
      return { schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-witness-summary", component: witness.component,
        phase: witness.phase, sessionId: witness.sessionId, requestId: witness.requestId, manifestSha256: witness.manifestSha256,
        verifierBuildSha256: witness.verifierBuildSha256, observerExecutableSha256: witness.observerExecutableSha256,
        configurationSha256: witness.configurationSha256, observerPid: witness.observerPid,
        observation: { sourceKind: observation.kind, observerSessionId: observation.observerSessionId, pid: observation.pid,
          candidateCommit: observation.candidateCommit, executableSha256: observation.executableSha256,
          startedAt: observation.startedAt, observedAt: observation.observedAt, observationSha256: observation.sha256,
          sourceManifestSha256: node ? observation.manifestSha256 : null,
          scriptCount: node ? observation.scripts.length : 0, generatedScriptCount: node ? observation.generatedScriptSha256.length : 0,
          finishedAt: node ? null : observation.finishedAt, exitCode: node ? null : observation.exitCode,
          signal: node ? null : observation.signal, limitations: observation.limitations },
        executionIdentity: witness.executionIdentity, httpSession: witness.httpSession, launch: witness.launch,
        termination: witness.termination, envelopeRef: witness.envelopeRef };
    }),
  });
}
