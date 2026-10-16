import { expect, it } from "vitest";
import { repositoryObservationFixture as fixture, observationFixtureId as id, observationFixtureRequest as request,
  observationFixtureHash as hash, observationFixtureTime as time } from "../__tests__/helpers/repository-execution-observation.js";
import { persistRepositoryExecutionObservation, validateRepositoryExecutionObservation } from "./repository-execution-observation.js";

it("stores the exact private log and bounded closed observation outside model output budgets", async () => {
  const f = fixture();
  const ref = await persistRepositoryExecutionObservation(f);
  expect(f.storage.putFile).toHaveBeenCalledTimes(2);
  expect(f.revalidate).toHaveBeenCalledTimes(4);
  expect(f.storage.putFile.mock.calls[0]![0].body).toEqual(f.execution.fullHistoryBody);
  const encoded = f.storage.putFile.mock.calls[1]![0].body;
  const value = validateRepositoryExecutionObservation(JSON.parse(encoded.toString()), f.execution.fullHistoryBody, request, f.expected);
  expect(value.facts.usage).toEqual({ total: 3, input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } });
  expect(value.facts.costStatus).toBe("unavailable");
  expect(value.facts.reportedCostUsd).toBe(0);
  expect(ref).toEqual({ contentHash: hash(encoded), contentRef: `storage:${id}/verrail/repository-execution-observations/sha256/${hash(encoded)}`, bytes: encoded.length });
  expect(value).not.toHaveProperty("fullHistoryBody");
});

it.each(["body", "projection", "usage", "permissions", "environment", "time", "model", "count", "extra field", "oversize log"])(
  "rejects %s tampering before writing a private object", async failure => {
    const f = fixture();
    if (failure === "body") f.execution.fullHistoryBody = Buffer.from("[]");
    if (failure === "projection") f.execution.facts.messages[1]!.steps[0]!.tokens.input = 999;
    if (failure === "usage") f.execution.facts.usage!.total = 999;
    if (failure === "permissions") f.execution.facts.runtimeWitness.after.permissions.allowedTools = ["bash"];
    if (failure === "environment") f.execution.facts.runtimeWitness.after.environment.homeSha256 = "f".repeat(64);
    if (failure === "time") f.execution.facts.runtimeWitness.before.checkedAt = time(5);
    if (failure === "model") f.execution.facts.model = "fixture/foreign";
    if (failure === "count") f.execution.facts.fullHistory.partCount++;
    if (failure === "extra field") Object.assign(f.execution.facts, { authorization: "must not persist" });
    if (failure === "oversize log") f.execution.fullHistoryBody = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(persistRepositoryExecutionObservation(f)).rejects.toThrow();
    expect(f.storage.putFile).not.toHaveBeenCalled();
  },
);

it("does not publish an observation reference after a partial upload or revoked authority", async () => {
  for (const failure of ["metadata", "authority"]) {
    const f = fixture();
    if (failure === "metadata") f.storage.putFile.mockResolvedValueOnce({ provider: "local_disk", objectKey: "foreign",
      sha256: "f".repeat(64), byteSize: 1, contentType: "application/json", originalFilename: "observation.json" });
    else f.revalidate.mockResolvedValueOnce().mockRejectedValueOnce(new Error("revoked"));
    await expect(persistRepositoryExecutionObservation(f)).rejects.toThrow();
    expect(f.storage.putFile).toHaveBeenCalledTimes(1);
  }
});
