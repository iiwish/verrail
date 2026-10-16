import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { deriveOpenCodeExecutionFacts } from "@paperclipai/adapter-opencode-local/http-client";

export const observationFixtureId = "11111111-1111-4111-8111-111111111111";
const id = observationFixtureId;
export const observationFixtureRequest: RepositoryExecutionRequest = { schemaVersion: 1, kind: "target_repository_execution", workspaceId: id,
  targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id, runId: id, runAttemptId: id,
  leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id, runtime: "opencode", model: "fixture/test",
  source: { artifactId: id, contentHash: "a".repeat(64), baseCommit: "b".repeat(40), format: "git_bundle" },
  instructions: "Fixture", timeoutSeconds: 60, output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 } };
export const observationFixtureHash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const base = Date.parse("2026-01-01T00:00:00.000Z");
export const observationFixtureTime = (n: number) => new Date(base + n * 1000).toISOString();

export function repositoryObservationFixture(request = observationFixtureRequest) {
  const session = "ses_fixture", time = observationFixtureTime, hash = observationFixtureHash;
  const part = (id: string, messageID: string) => ({ id, messageID, sessionID: session });
  const raw = [
    { info: { id: "msg_user", sessionID: session, role: "user", model: { providerID: "fixture", modelID: "test" }, time: { created: base + 4000 } },
      parts: [{ ...part("prt_user", "msg_user"), type: "text", text: "Fixture only" }] },
    { info: { id: "msg_assistant", sessionID: session, role: "assistant", parentID: "msg_user", providerID: "fixture", modelID: "test",
      time: { created: base + 5000, completed: base + 6000 }, finish: "stop" }, parts: [
      { ...part("prt_start", "msg_assistant"), type: "step-start" },
      { ...part("prt_text", "msg_assistant"), type: "text", text: "Fixture result" },
      { ...part("prt_finish", "msg_assistant"), type: "step-finish", reason: "stop", cost: 0,
        tokens: { total: 3, input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
    ] },
  ];
  const fullHistoryBody = Buffer.from(JSON.stringify(raw));
  const replay = deriveOpenCodeExecutionFacts(raw, { model: request.model, finalMessageId: "msg_assistant" }, session,
    { time: { created: base + 2000 } }, { version: "1.17.13", verifiedAt: time(1) });
  const witness = { permissions: { default: "deny", allowedTools: ["repository_execute_command"], sessionRulesSha256: "c".repeat(64), configRulesSha256: "d".repeat(64) },
    environment: { homeSha256: "e".repeat(64), directory: ".", config: "config/opencode", state: "state/opencode", worktree: "global" },
    configuration: { share: "disabled", model: request.model, smallModel: request.model, enabledProviders: ["fixture"] } };
  const expected = { runtime: "opencode" as const, runtimeVersion: "1.17.13", model: request.model,
    startedAt: time(0), finishedAt: time(8), cleanup: { runtime: true as const, home: true as const, commands: true as const } };
  const facts = { ...replay, ...expected, fullHistory: { sha256: hash(fullHistoryBody), bytes: fullHistoryBody.length,
    messageCount: 2, partCount: 4, projectionSha256: hash(canonicalJson(replay.messages)) },
    runtimeWitness: { before: { ...structuredClone(witness), checkedAt: time(3) }, after: { ...structuredClone(witness), checkedAt: time(7) } } };
  const objects = new Map<string, Buffer>();
  const putFile = vi.fn(async (input: { companyId: string; namespace: string; body: Buffer }) => {
    const objectKey = `${input.companyId}/${input.namespace}/sha256/${hash(input.body)}`;
    objects.set(objectKey, Buffer.from(input.body));
    return { provider: "local_disk" as const, objectKey, sha256: hash(input.body), byteSize: input.body.length,
      contentType: "application/json", originalFilename: "observation.json" };
  });
  return { request, expected, execution: { facts, fullHistoryBody }, objects, storage: { putFile }, revalidate: vi.fn(async () => {}) };
}
