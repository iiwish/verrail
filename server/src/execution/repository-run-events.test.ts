import { expect, it, vi } from "vitest";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import type { VerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { createRepositoryRunReporter } from "./repository-run-events.js";

const id = "11111111-1111-4111-8111-111111111111";
const request: RepositoryExecutionRequest = { schemaVersion: 1, kind: "target_repository_execution", workspaceId: id,
  targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id, runId: id, runAttemptId: id,
  leaseId: id, fencingToken: 4, agentVersionId: id, deploymentRevisionId: id,
  source: { artifactId: id, contentHash: "a".repeat(64), baseCommit: "b".repeat(40), format: "git_bundle" },
  runtime: "opencode", model: "fixture/test", instructions: "Test", timeoutSeconds: 60,
  output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 } };
function fixture() {
  const reportRunEvent = vi.fn<VerrailDomainApiClient["reportRunEvent"]>(async command => ({
    schemaVersion: 1, runId: command.runId, runAttemptId: command.runAttemptId,
    cursor: command.input.cursor, eventType: command.input.eventType, authoritative: true,
    rejectionCode: null, runStatus: command.input.eventType === "succeeded" ? "succeeded" : "running",
    attemptStatus: command.input.eventType === "succeeded" ? "succeeded" : "running",
    leaseStatus: command.input.eventType === "succeeded" ? "released" : "active", replayed: false,
  }));
  return { reportRunEvent, reporter: createRepositoryRunReporter({ request, lastEventCursor: 2, domainApi: { reportRunEvent } }) };
}
it("serializes progress and lease renewal under the fixed executor identity", async () => {
  const { reportRunEvent, reporter } = fixture();
  const signal = new AbortController().signal;
  await Promise.all([reporter.progress("one", signal), reporter.renew(signal), reporter.progress("two", signal)]);
  expect(reportRunEvent.mock.calls.map(([c]) => c.input.cursor)).toEqual([3, 4, 5]);
  expect(reportRunEvent.mock.calls.map(([c]) => c.input.eventType)).toEqual(["progress", "heartbeat", "progress"]);
  for (const [command] of reportRunEvent.mock.calls) {
    expect(command).toMatchObject({ workspaceId: id, runId: id, runAttemptId: id,
      principalType: "service", principalId: "verrail-repository-runner", input: { leaseId: id, fencingToken: 4 } });
    expect(command.idempotencyKey).toBe(`repository:${id}:${command.input.cursor}`);
  }
});
it.each([new Error("connection lost"), undefined])("never sends another event after an ambiguous response", async rejection => {
  const { reportRunEvent, reporter } = fixture();
  reportRunEvent.mockRejectedValueOnce(rejection);
  const signal = new AbortController().signal;
  const outcomes = await Promise.allSettled([reporter.progress("one", signal), reporter.renew(signal)]);
  expect(outcomes.every(outcome => outcome.status === "rejected")).toBe(true);
  expect(reportRunEvent).toHaveBeenCalledTimes(1);
  await expect(reporter.fail(signal)).rejects.toThrow("REPOSITORY_EVENT_STREAM_UNCERTAIN");
});
it("rejects authoritative responses with mismatched identity or cursor", async () => {
  const { reportRunEvent, reporter } = fixture();
  reportRunEvent.mockResolvedValue({ authoritative: true, runId: id, runAttemptId: id, cursor: 99, eventType: "heartbeat" } as never);
  await expect(reporter.renew(new AbortController().signal)).rejects.toThrow("REPOSITORY_EVENT_REJECTED");
});
it("passes bounded artifacts to the Go success event rather than writing domain tables", async () => {
  const { reportRunEvent, reporter } = fixture();
  const artifact = { ordinal: 0, path: "result.txt", title: "Result", kind: "report", bytes: 10,
    contentHash: "c".repeat(64), contentRef: `storage:${id}/verrail/run-artifacts/sha256/${"c".repeat(64)}` };
  const result = { runId: id, runAttemptId: id, leaseId: id, fencingToken: 4, source: request.source, artifacts: [artifact] };
  await reporter.succeed(result, new AbortController().signal);
  expect(reportRunEvent.mock.calls[0][0].input).toMatchObject({ eventType: "succeeded", payload: { repositoryOutput: result },
    artifacts: [{ title: "Result", kind: "report", contentHash: artifact.contentHash, contentRef: artifact.contentRef }] });
});
it("uses a distinct terminal key and requires authoritative canceled/released states", async () => {
  const { reportRunEvent, reporter } = fixture();
  reportRunEvent.mockImplementation(async command => ({ schemaVersion: 1, runId: id, runAttemptId: id,
    cursor: command.input.cursor, eventType: "terminated", authoritative: true, rejectionCode: null,
    runStatus: "canceled", attemptStatus: "canceled", leaseStatus: "released", replayed: false }));
  await reporter.terminate(new AbortController().signal);
  expect(reportRunEvent.mock.calls[0][0]).toMatchObject({ idempotencyKey: `repository:${id}:terminated:3`,
    input: { eventType: "terminated", leaseId: id, fencingToken: 4, cursor: 3, payload: { cleanupConfirmed: true } } });
  const rejected = fixture();
  await expect(rejected.reporter.terminate(new AbortController().signal)).rejects.toThrow("REPOSITORY_EVENT_REJECTED");
});
