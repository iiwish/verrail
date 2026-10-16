import { afterEach, expect, it, vi } from "vitest";
import { type Db, verrailCriterionProofs } from "@paperclipai/db";
import { DELIVERY_PROOF_ASSERTIONS } from "@paperclipai/shared";
import { loadRepositoryRecoveryDeliveryProofContext, repositoryRecoveryAssertions } from "./repository-recovery-delivery-proof-context.js";

const deps = vi.hoisted(() => ({ execution: vi.fn(), recovery: vi.fn() }));
vi.mock("./opencode-execution-proof-context.js", () => ({ loadOpenCodeExecutionProofContext: deps.execution }));
vi.mock("./repository-recovery-proof-reader.js", () => ({ loadRepositoryRecoveryRuntimeContext: deps.recovery }));
vi.mock("./repository-recovery-proof-projection.js", () => ({ projectRepositoryRecoveryProof: (value: unknown) => value }));
afterEach(() => vi.resetAllMocks());
const id = "11111111-1111-4111-8111-111111111111", sha = "a".repeat(64);
it("uses the shared complete repository recovery assertion contract", () => {
  expect(repositoryRecoveryAssertions).toBe(DELIVERY_PROOF_ASSERTIONS.repository_recovery);
  expect(repositoryRecoveryAssertions).toHaveLength(4);
});
function fixture() {
  const identity = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id,
    runId: id, runAttemptId: id, leaseId: id, fencingToken: 2, agentVersionId: id, deploymentRevisionId: id };
  const input = { ...identity, claimId: id, artifactRevisionId: id, requirementId: id };
  const context = { targetStatus: "active", graphStatus: "active", criterionKey: "recovery", nodeStatus: "ready",
    criteria: [{ id: "recovery", proofContract: { schemaVersion: 1, allOf: [{ id, kind: "independent_verification",
      phase: "pre_acceptance", assertions: [...repositoryRecoveryAssertions] }] } }] };
  let exists = false;
  const tx = { select: () => { let proof = false;
    const query = { from: (table: unknown) => { proof = table === verrailCriterionProofs; return query; },
      innerJoin: () => query, where: () => query, limit: async () => proof ? (exists ? [{ id }] : []) : [context] }; return query;
  } };
  const db = { transaction: async (fn: (value: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;
  const source = { source: { runEventId: id }, snapshot: {}, contextSha256: sha };
  const execution = { ...identity, outputReceiptSha256: sha, executionObservation: { contentHash: sha }, logRef: { contentHash: sha },
    sessionId: "ses_fixture", runEventId: id, candidateRuntime: { sessionId: id }, executionWindow: { startedAt: "start", finishedAt: "end" }, contextSha256: sha };
  const recovered = { checkpoint: { durable: { identity, outputReceiptSha256: sha, executionObservationSha256: sha,
    executionLogSha256: sha, executionSessionId: "ses_fixture", runtimeBinding: { candidateRuntime: execution.candidateRuntime,
      runtimeWindow: execution.executionWindow } } }, preRuntime: { archived: true },
    completion: { sourceContextSha256: sha, source: { runEventId: id } } };
  deps.execution.mockImplementation(async () => structuredClone({ source, execution }));
  deps.recovery.mockImplementation(async () => structuredClone(recovered));
  const access = { schemaVersion: 4, workspaceId: id } as Parameters<typeof loadRepositoryRecoveryDeliveryProofContext>[1];
  const options = {} as Parameters<typeof loadRepositoryRecoveryDeliveryProofContext>[3];
  return { db, input, context, execution, source, recovered, access, options, existing: () => { exists = true; } };
}
it("uses closed historical runtime and rechecks complete recovery, execution and active requirement", async () => {
  const f = fixture(), result = await loadRepositoryRecoveryDeliveryProofContext(f.db, f.access, f.input, f.options);
  expect(result.source.criterionKey).toBe("recovery"); expect(result.runtime).toEqual({ archived: true });
  expect(deps.recovery).toHaveBeenCalledTimes(2); expect(deps.execution).toHaveBeenCalledTimes(2);
});
it.each(["subset", "accepted", "canceled", "graph inactive", "waiting", "completed without proof", "identity", "receipt",
  "observation", "log", "session", "runtime binding", "window", "source", "event", "missing journals", "missing log",
  "recovery changed", "execution changed", "source changed", "requirement changed"])("rejects %s", async failure => {
  const f = fixture();
  if (failure === "subset") f.context.criteria[0]!.proofContract.allOf[0]!.assertions.pop();
  if (["accepted", "canceled"].includes(failure)) f.context.targetStatus = failure;
  if (failure === "graph inactive") f.context.graphStatus = "draft";
  if (failure === "waiting") f.context.nodeStatus = "waiting";
  if (failure === "completed without proof") f.context.nodeStatus = "completed";
  if (failure === "identity") f.execution.fencingToken++;
  if (failure === "receipt") f.execution.outputReceiptSha256 = "b".repeat(64);
  if (failure === "observation") f.execution.executionObservation.contentHash = "b".repeat(64);
  if (failure === "log") f.execution.logRef.contentHash = "b".repeat(64);
  if (failure === "session") f.execution.sessionId = "ses_other";
  if (failure === "runtime binding") f.execution.candidateRuntime = { sessionId: "other" };
  if (failure === "window") f.execution.executionWindow = { startedAt: "different", finishedAt: "end" };
  if (failure === "source") f.recovered.completion.sourceContextSha256 = "b".repeat(64);
  if (failure === "event") f.execution.runEventId = "other";
  if (failure === "missing journals") deps.recovery.mockRejectedValue(new Error("missing journals"));
  if (failure === "missing log") deps.execution.mockRejectedValue(new Error("missing log"));
  if (failure === "recovery changed") deps.recovery.mockResolvedValueOnce(structuredClone(f.recovered)).mockResolvedValue({ ...f.recovered, changed: true });
  if (failure === "execution changed") deps.execution.mockResolvedValueOnce(structuredClone({ source: f.source, execution: f.execution }))
    .mockResolvedValue({ source: f.source, execution: { ...f.execution, contextSha256: "b".repeat(64) } });
  if (failure === "source changed") deps.execution.mockResolvedValueOnce(structuredClone({ source: f.source, execution: f.execution }))
    .mockResolvedValue({ source: { ...f.source, contextSha256: "b".repeat(64) }, execution: f.execution });
  if (failure === "requirement changed") deps.recovery.mockImplementation(async () => {
    f.context.targetStatus = "canceled"; return structuredClone(f.recovered);
  });
  await expect(loadRepositoryRecoveryDeliveryProofContext(f.db, f.access, f.input, f.options)).rejects.toThrow();
});
it.each(["completed", "blocked"])("requires scoped existing proof for %s replay", async status => {
  const f = fixture(); f.context.nodeStatus = status; f.existing();
  expect((await loadRepositoryRecoveryDeliveryProofContext(f.db, f.access, f.input, f.options)).source.criterionKey).toBe("recovery");
});
