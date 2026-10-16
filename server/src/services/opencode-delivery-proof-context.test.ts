import { afterEach, expect, it, vi } from "vitest";
import { type Db, verrailCriterionProofs } from "@paperclipai/db";
import { DELIVERY_PROOF_ASSERTIONS } from "@paperclipai/shared";
import { loadOpenCodeDeliveryProofContext } from "./opencode-delivery-proof-context.js";

const dependencies = vi.hoisted(() => ({ execution: vi.fn(), runtime: vi.fn() }));
vi.mock("./opencode-execution-proof-context.js", () => ({ loadOpenCodeExecutionProofContext: dependencies.execution }));
vi.mock("./opencode-runtime-observation.js", () => ({ collectOpenCodeRuntimeWitnesses: dependencies.runtime }));
vi.mock("./opencode-runtime-proof-projection.js", () => ({ projectOpenCodeRuntimeProof: (value: unknown) => value }));
afterEach(() => vi.resetAllMocks());
const id = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const input = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, claimId: id,
    workNodeId: id, artifactRevisionId: id, requirementId: id, runId: id, runAttemptId: id };
  const context = { targetStatus: "active", graphStatus: "active", criterionKey: "execution", nodeStatus: "ready",
    criteria: [{ id: "execution", proofContract: { schemaVersion: 1, allOf: [{ id, kind: "independent_verification",
      phase: "pre_acceptance", assertions: [...DELIVERY_PROOF_ASSERTIONS.opencode_execution] }] } }] };
  let existing: unknown[] = [];
  const tx = { select: () => {
    let proof = false;
    const query = { from: (table: unknown) => { proof = table === verrailCriterionProofs; return query; },
      innerJoin: () => query, where: () => query, limit: async () => proof ? existing : [context] };
    return query;
  } };
  const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;
  const runtime = { witnesses: [{ component: "opencode", observerPid: 100, observation: { pid: 101 } }] };
  const source = { source: {}, snapshot: {}, contextSha256: "a".repeat(64) };
  const execution = { ...input, leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id,
    candidateRuntime: { sessionId: id, manifestSha256: "b".repeat(64), observerPid: 100, nativePid: 101,
      httpSession: { runtimeVersion: "1.17.13" } }, sessionId: "ses_fixture", sessionCreatedAt: "2026-01-01T00:00:01.000Z",
    sessionCompletedAt: "2026-01-01T00:00:02.000Z", executionWindow: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:03.000Z" },
    runtimeWitness: { before: { environment: { homeSha256: "c".repeat(64) } } }, contextSha256: "d".repeat(64) };
  dependencies.execution.mockImplementation(async () => structuredClone({ source, execution }));
  dependencies.runtime.mockResolvedValue(runtime);
  const options = { repository: { repository: "fixture/repository", connectionId: id, bindingId: id }, storage: { getObject: vi.fn() },
    runtime: { sessionId: id, manifestSha256: "b".repeat(64) } } as unknown as Parameters<typeof loadOpenCodeDeliveryProofContext>[2];
  return { db, input, context, source, execution, runtime, options, existing: () => { existing = [{ id }]; } };
}
it("requires the complete clause, independently signed runtime and stable closed context before returning source", async () => {
  const f = fixture(); const value = await loadOpenCodeDeliveryProofContext(f.db, f.input, f.options);
  expect(value.source.criterionKey).toBe("execution");
  expect(dependencies.execution).toHaveBeenCalledTimes(2); expect(dependencies.runtime).toHaveBeenCalledOnce();
  expect(dependencies.runtime.mock.calls[0]![1].identity).not.toHaveProperty("heartbeatRunId");
  expect(dependencies.runtime.mock.calls[0]![1].identity).not.toHaveProperty("claimId");
});
it.each(["legacy clause", "CI subset", "canceled target", "canceled graph", "waiting node", "completed without proof", "observer session", "manifest",
  "observer PID", "native PID", "closed context changed", "source changed", "requirement changed", "missing runtime", "missing observation"])("rejects %s", async failure => {
  const f = fixture();
  if (failure === "legacy clause") f.context.criteria[0]!.proofContract.allOf[0]!.assertions = [...DELIVERY_PROOF_ASSERTIONS.codex_execution] as never;
  if (failure === "CI subset") f.context.criteria[0]!.proofContract.allOf[0]!.assertions = [DELIVERY_PROOF_ASSERTIONS.opencode_execution[1]];
  if (failure === "canceled target") f.context.targetStatus = "canceled";
  if (failure === "canceled graph") f.context.graphStatus = "canceled";
  if (failure === "waiting node") f.context.nodeStatus = "waiting";
  if (failure === "completed without proof") f.context.nodeStatus = "completed";
  if (failure === "observer session") f.execution.candidateRuntime.sessionId = "22222222-2222-4222-8222-222222222222";
  if (failure === "manifest") f.execution.candidateRuntime.manifestSha256 = "f".repeat(64);
  if (failure === "observer PID") f.runtime.witnesses[0]!.observerPid++;
  if (failure === "native PID") f.runtime.witnesses[0]!.observation.pid++;
  if (failure === "missing runtime") dependencies.runtime.mockRejectedValue(new Error("signature unavailable"));
  if (failure === "missing observation") dependencies.execution.mockRejectedValue(new Error("observation unavailable"));
  if (["closed context changed", "source changed", "requirement changed"].includes(failure)) dependencies.runtime.mockImplementation(async () => {
    if (failure === "closed context changed") f.execution.contextSha256 = "f".repeat(64);
    if (failure === "source changed") f.source.contextSha256 = "f".repeat(64);
    if (failure === "requirement changed") f.context.targetStatus = "canceled";
    return f.runtime;
  });
  await expect(loadOpenCodeDeliveryProofContext(f.db, f.input, f.options)).rejects.toThrow();
});
it.each(["completed", "blocked"])("permits idempotent %s replay only with the same scoped requirement proof", async status => {
  const f = fixture(); f.context.nodeStatus = status; f.existing();
  expect((await loadOpenCodeDeliveryProofContext(f.db, f.input, f.options)).source.criterionKey).toBe("execution");
});
