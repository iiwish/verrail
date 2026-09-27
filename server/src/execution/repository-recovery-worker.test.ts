import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { runRepositoryRecoveryWorker } from "./repository-recovery-worker.js";

const f = vi.hoisted(() => ({ list: vi.fn(), reconcile: vi.fn() }));
vi.mock("./repository-reconciliation.js", () => ({ listPendingRepositoryCompletions: f.list, reconcileRepositoryCompletion: f.reconcile }));
beforeEach(() => vi.resetAllMocks());
const setup = () => {
  const controller = new AbortController();
  const options = { db: {} as never, domainApi: {} as never, workspaceIds: [randomUUID()],
    signal: controller.signal, intervalMs: 100, onFailure: vi.fn() };
  return { controller, options };
};

it("continues after a rejected record and does not disclose raw errors", async () => {
  const { controller, options } = setup();
  const ids = [randomUUID(), randomUUID()];
  f.list.mockResolvedValue(ids.map(runAttemptId => ({ runAttemptId })));
  f.reconcile.mockRejectedValueOnce(new Error("private provider credential"))
    .mockImplementationOnce(async () => { controller.abort(); });
  await runRepositoryRecoveryWorker(options);
  expect(f.reconcile).toHaveBeenCalledTimes(2);
  expect(options.onFailure).toHaveBeenCalledExactlyOnceWith({ workspaceId: options.workspaceIds[0],
    runAttemptId: ids[0], code: "REPOSITORY_RECOVERY_REGISTRATION_FAILED" });
});

it("advances a full page even if every result is rejected", async () => {
  const { controller, options } = setup();
  const records = Array.from({ length: 20 }, () => ({ runAttemptId: randomUUID() }));
  f.list.mockResolvedValueOnce(records).mockImplementationOnce(async () => { controller.abort(); return []; });
  f.reconcile.mockRejectedValue(new Error("LEASE_LOST"));
  await runRepositoryRecoveryWorker(options);
  expect(f.list.mock.calls[1][0].after).toBe(records[19].runAttemptId);
  expect(f.reconcile).toHaveBeenCalledTimes(20);
});

it("isolates a failed workspace scan from the next workspace", async () => {
  const { controller, options } = setup();
  options.workspaceIds.push(randomUUID());
  f.list.mockRejectedValueOnce(new Error("database failure"))
    .mockImplementationOnce(async () => { controller.abort(); return []; });
  await runRepositoryRecoveryWorker(options);
  expect(f.list.mock.calls.map(([arg]) => arg.workspaceId)).toEqual(options.workspaceIds);
  expect(options.onFailure).toHaveBeenCalledExactlyOnceWith({ workspaceId: options.workspaceIds[0], code: "REPOSITORY_RECOVERY_SCAN_FAILED" });
});

it("does not start another record after shutdown", async () => {
  const { controller, options } = setup();
  f.list.mockResolvedValue([{ runAttemptId: randomUUID() }, { runAttemptId: randomUUID() }]);
  f.reconcile.mockImplementation(async () => { controller.abort(); throw new Error("aborted"); });
  await runRepositoryRecoveryWorker(options);
  expect(f.reconcile).toHaveBeenCalledTimes(1);
  expect(options.onFailure).not.toHaveBeenCalled();
});

it("validates scope and avoids work when already stopped", async () => {
  const { controller, options } = setup();
  await expect(runRepositoryRecoveryWorker({ ...options, workspaceIds: [] })).rejects.toThrow();
  await expect(runRepositoryRecoveryWorker({ ...options, workspaceIds: [options.workspaceIds[0], options.workspaceIds[0]] })).rejects.toThrow("DUPLICATE_WORKSPACE");
  controller.abort();
  await runRepositoryRecoveryWorker(options);
  expect(f.list).not.toHaveBeenCalled();
});

it("revisits an incomplete page on the next tick", async () => {
  const { controller, options } = setup();
  f.list.mockResolvedValueOnce([{ runAttemptId: randomUUID() }])
    .mockImplementationOnce(async () => { controller.abort(); return []; });
  f.reconcile.mockRejectedValue(new Error("temporary failure"));
  await runRepositoryRecoveryWorker(options);
  expect(f.list.mock.calls[1][0].after).toBeUndefined();
});

it("shutdown interrupts the polling delay", async () => {
  const { controller, options } = setup();
  f.list.mockResolvedValue([]);
  const running = runRepositoryRecoveryWorker({ ...options, intervalMs: 60_000 });
  await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
  controller.abort();
  await running;
  expect(f.list).toHaveBeenCalledTimes(1);
});

it.each([true, false])("reports the completed cycle's failure state: %s", async failed => {
  const { controller, options } = setup();
  if (failed) f.list.mockRejectedValue(new Error("database unavailable"));
  else f.list.mockResolvedValue([]);
  const onCycle = vi.fn(() => controller.abort());
  await runRepositoryRecoveryWorker({ ...options, onCycle });
  expect(onCycle).toHaveBeenCalledExactlyOnceWith({ failed });
});
