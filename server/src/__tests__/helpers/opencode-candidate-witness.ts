import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { openCodeCandidateWitnessSchema, openCodeRuntimeDigest, openCodeWitnessDomain,
  type collectOpenCodeRuntimeWitnesses } from "../../services/opencode-runtime-observation.js";
import { observationFixtureId as id, observationFixtureTime as time, observationFixtureHash as hash } from "./repository-execution-observation.js";

/** Protocol-only synthetic data. It never represents an observed product execution. */
export function syntheticCandidateWitnesses(scriptCount = 1, manifestSha256 = "d".repeat(64)) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const identity = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id,
    runId: id, runAttemptId: id, leaseId: id, fencingToken: 2, agentVersionId: id, deploymentRevisionId: id };
  const httpSession = { sessionId: "ses_fixture", runtimeVersion: "1.17.13" as const, createdAt: time(2), homeSha256: "e".repeat(64) };
  const witnesses = (["server", "domain", "repository_executor", "opencode"] as const).map(component => {
    const node = ["server", "repository_executor"].includes(component);
    const observation = { schemaVersion: 1, observerSessionId: id, pid: component === "opencode" ? 101 : 200,
      candidateCommit: "b".repeat(40), executableSha256: "a".repeat(64), startedAt: time(0),
      observedAt: component === "opencode" ? time(7) : new Date().toISOString(),
      limitations: ["not_hostile_same_uid_isolation"], ...(node ? { kind: "verrail.node-runtime-observation",
        assurance: "observed_main_thread_scripts", manifestSha256: "a".repeat(64),
        scripts: Array.from({ length: scriptCount }, (_, index) => ({ path: `src/component-${index}.mjs`, sha256: "a".repeat(64) })),
        generatedScriptSha256: [] } : { kind: "verrail.native-runtime-observation", assurance: "launch_owned_immutable_executable",
        finishedAt: null, exitCode: null, signal: null }) };
    const witness = openCodeCandidateWitnessSchema.parse({ schemaVersion: 1, kind: "verrail.opencode-candidate-runtime-witness",
      component, phase: component === "opencode" ? "terminated" : "checkpoint", sessionId: id,
      requestId: component === "opencode" ? null : id, manifestSha256, verifierBuildSha256: "a".repeat(64),
      observerExecutableSha256: "a".repeat(64), configurationSha256: "a".repeat(64), observerPid: 100,
      observation: { ...observation, sha256: openCodeRuntimeDigest(observation) },
      executionIdentity: component === "opencode" ? identity : null, httpSession: component === "opencode" ? httpSession : null,
      launch: { rootSha256: "e".repeat(64), argvSha256: "a".repeat(64), environmentSha256: "a".repeat(64) },
      termination: component === "opencode" ? { requestedSignal: "SIGTERM", finishedAt: time(8),
        processGroupStopped: true, immutableExecutableRemoved: true } : null });
    const payload = Buffer.from(canonicalJson(witness));
    const envelope = Buffer.from(canonicalJson({ schemaVersion: 1, payload: payload.toString("base64"),
      signature: sign(null, Buffer.concat([openCodeWitnessDomain, payload]), privateKey).toString("base64") }));
    return { ...witness, envelopeRef: { contentHash: hash(envelope), bytes: envelope.length,
      contentRef: `private-witness:sha256:${hash(envelope)}` } };
  });
  return { schemaVersion: 1 as const, kind: "verrail.opencode-candidate-runtime-observation" as const,
    sessionId: id, manifestSha256, witnesses } satisfies Awaited<ReturnType<typeof collectOpenCodeRuntimeWitnesses>>;
}
