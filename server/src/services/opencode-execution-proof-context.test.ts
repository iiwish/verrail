import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { repositoryExecutionIdentitySchema, repositoryExecutionRequestSchema } from "@paperclipai/shared";
import { repositoryObservationFixture, observationFixtureHash as hash, observationFixtureId as id } from "../__tests__/helpers/repository-execution-observation.js";
import { persistRepositoryExecutionObservation } from "../execution/repository-execution-observation.js";
import { repositoryRequestSha256 } from "../execution/repository-output-receipt.js";
import { loadOpenCodeExecutionProofContext } from "./opencode-execution-proof-context.js";

const sourceLoader = vi.hoisted(() => vi.fn());
vi.mock("./github-ci-repository-source-context.js", () => ({ loadRepositoryCiSourceContext: sourceLoader }));
afterEach(() => vi.resetAllMocks());

async function fixture() {
  const vector = JSON.parse(await readFile(new URL("../../../services/domain-api/internal/target/testdata/repository-source-collector-v1.json", import.meta.url), "utf8"));
  const request = repositoryExecutionRequestSchema.parse(vector.request), f = repositoryObservationFixture(request);
  Object.assign(f.execution.facts, { candidateRuntime: { kind: "verrail.opencode-session-bound", nativePid: 101,
    observerPid: 100, sessionId: id, manifestSha256: "d".repeat(64),
    executionIdentitySha256: hash(canonicalJson(repositoryExecutionIdentitySchema.strip().parse(request))),
    httpSession: { sessionId: f.execution.facts.sessionId, runtimeVersion: "1.17.13", createdAt: f.execution.facts.sessionCreatedAt,
      homeSha256: f.execution.facts.runtimeWitness.before.environment.homeSha256 } } });
  const ref = await persistRepositoryExecutionObservation(f);
  const receipt = vector.result.outputReceipt;
  receipt.executionFacts = { ...f.expected, cleanup: { ...f.expected.cleanup, checkout: true },
    requestSha256: repositoryRequestSha256(request), exitCode: 0 };
  receipt.executionObservation = ref; receipt.finalizedAt = new Date(Date.now() + 1000).toISOString();
  const source = { source: { runId: id, runAttemptId: id, runEventId: id, runEventContentHash: "a".repeat(64),
    outputReceiptSha256: "", artifactOrdinal: 0 }, snapshot: {}, contextSha256: "b".repeat(64) };
  const resign = () => { const { sha256: _, ...body } = receipt; receipt.sha256 = hash(canonicalJson(body)); source.source.outputReceiptSha256 = receipt.sha256; };
  resign(); sourceLoader.mockResolvedValue(source);
  const dispatch = { input: request, result: vector.result, requestHash: repositoryRequestSha256(request),
    leaseId: request.leaseId, fencingToken: request.fencingToken, finishedAt: new Date(), errorCode: null };
  const limit = vi.fn(async () => [dispatch]);
  const query = { from: () => query, where: () => query, limit };
  const tx = { select: () => query };
  const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) } as unknown as Db;
  const storage = { getObject: vi.fn(async (_workspace: string, key: string) => {
    const body = f.objects.get(key); if (!body) throw new Error("Not found");
    return { stream: Readable.from([body]), contentLength: body.length };
  }) };
  const input = { workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, claimId: id,
    workNodeId: id, artifactRevisionId: id, requirementId: id, runId: id, runAttemptId: id };
  const options = { storage, repository: { repository: "fixture/repository", connectionId: id, bindingId: id } };
  const replaceObservation = (mutate: (value: any) => void) => {
    const value = JSON.parse(f.objects.get(ref.contentRef.slice(8))!.toString()); mutate(value);
    const body = Buffer.from(canonicalJson(value)), digest = hash(body);
    const newRef = { contentHash: digest, contentRef: `storage:${id}/verrail/repository-execution-observations/sha256/${digest}`, bytes: body.length };
    f.objects.set(newRef.contentRef.slice(8), body); receipt.executionObservation = newRef; resign();
  };
  return { db, input, options, receipt, dispatch, source, f, limit, resign, replaceObservation };
}

it("replays real stored message bytes and projects a version/attempt-bound context, not raw logs", async () => {
  const f = await fixture();
  const result = await loadOpenCodeExecutionProofContext(f.db, f.input, f.options);
  expect(result.execution).toMatchObject({ workspaceId: id, runAttemptId: id, fencingToken: 2,
    outputReceiptSha256: f.receipt.sha256, usageStatus: "complete", usage: { total: 3 },
    costStatus: "unavailable", costBasis: "opencode-estimate", reportedCostUsd: 0,
    runtimeWitness: { before: { environment: { worktree: "global" } } } });
  expect(result.execution).not.toHaveProperty("messages");
  expect(result.execution).not.toHaveProperty("fullHistoryBody");
  expect(f.options.storage.getObject).toHaveBeenCalledTimes(2);
});

it.each(["missing observation", "source receipt", "source attempt", "request", "fence", "duplicate dispatch", "changed raw bytes",
  "forged usage", "forged permissions", "environment drift", "late observation", "unknown usage", "missing candidate", "candidate identity"])("fails closed on %s", async failure => {
  const f = await fixture();
  if (failure === "missing observation") { delete f.receipt.executionObservation; f.resign(); }
  if (failure === "source receipt") f.source.source.outputReceiptSha256 = "f".repeat(64);
  if (failure === "source attempt") f.source.source.runAttemptId = "22222222-2222-4222-8222-222222222222";
  if (failure === "request") f.dispatch.requestHash = "f".repeat(64);
  if (failure === "fence") f.dispatch.fencingToken++;
  if (failure === "duplicate dispatch") f.limit.mockResolvedValue([f.dispatch, f.dispatch]);
  if (failure === "changed raw bytes") {
    const entry = [...f.f.objects].find(([key]) => key.includes("repository-execution-logs"))!;
    f.f.objects.set(entry[0], Buffer.from("[]"));
  }
  if (failure === "forged usage") f.replaceObservation(value => { value.facts.usage.input++; });
  if (failure === "forged permissions") f.replaceObservation(value => { value.facts.runtimeWitness.before.permissions.allowedTools = ["bash"]; });
  if (failure === "environment drift") f.replaceObservation(value => { value.facts.runtimeWitness.after.environment.homeSha256 = "f".repeat(64); });
  if (failure === "late observation") f.replaceObservation(value => { value.recordedAt = "2099-01-01T00:00:00.000Z"; });
  if (failure === "unknown usage") f.replaceObservation(value => { value.facts.usageStatus = "unavailable"; value.facts.usage = null; });
  if (failure === "missing candidate") f.replaceObservation(value => { delete value.facts.candidateRuntime; });
  if (failure === "candidate identity") f.replaceObservation(value => { value.facts.candidateRuntime.executionIdentitySha256 = "f".repeat(64); });
  await expect(loadOpenCodeExecutionProofContext(f.db, f.input, f.options)).rejects.toThrow();
});
