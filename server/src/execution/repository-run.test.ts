import { beforeEach, expect, it, vi } from "vitest";
import { createStartedRepositoryRunExecutor } from "./repository-run.js";

const f = vi.hoisted(() => ({ execute: vi.fn(), controller: vi.fn(), reporter: vi.fn(),
  renew: vi.fn(), progress: vi.fn(), succeed: vi.fn(), fail: vi.fn(), reconcile: vi.fn() }));
vi.mock("./repository-controller.js", () => ({ createRepositoryExecutionController: f.controller }));
vi.mock("./repository-run-events.js", () => ({ createRepositoryRunReporter: f.reporter }));
vi.mock("./repository-reconciliation.js", () => ({ reconcileRepositoryCompletion: f.reconcile }));
beforeEach(() => {
  vi.resetAllMocks();
  f.controller.mockReturnValue(f.execute);
  f.reporter.mockReturnValue(f);
});
it("reconciles a durable canceled receipt with a fresh deadline rather than the aborted execution stream", async () => {
  f.execute.mockResolvedValue({ status: "canceled" });
  f.reconcile.mockResolvedValue({ status: "registered" });
  expect(await createStartedRepositoryRunExecutor({} as never)(request, 2, AbortSignal.abort())).toEqual({ status: "canceled" });
  expect(f.reconcile.mock.calls[0][0].signal.aborted).toBe(false);
  expect(f.reconcile.mock.calls[0][1]).toBe("canceled");
  expect(f.succeed).not.toHaveBeenCalled();
  expect(f.fail).not.toHaveBeenCalled();
});
it("does not claim cancellation if its Go registration is inactive or uncertain", async () => {
  f.execute.mockResolvedValue({ status: "canceled" });
  f.reconcile.mockResolvedValue({ status: "inactive" });
  await expect(createStartedRepositoryRunExecutor({} as never)(request, 2, signal)).rejects.toThrow("CANCELLATION_NOT_REGISTERED");
  f.reconcile.mockRejectedValue(new Error("RESPONSE_LOST"));
  await expect(createStartedRepositoryRunExecutor({} as never)(request, 2, signal)).rejects.toThrow("RESPONSE_LOST");
  expect(f.fail).not.toHaveBeenCalled();
});
const request = { runId: "fixture" } as never;
const signal = new AbortController().signal;
it("connects real callback interfaces and forwards only durable success to Go", async () => {
  const result = { artifacts: [] };
  f.execute.mockResolvedValue({ status: "succeeded", result });
  f.succeed.mockResolvedValue({ authoritative: true });
  const run = createStartedRepositoryRunExecutor({ domainApi: {} } as never);
  expect(await run(request, 2, signal)).toMatchObject({ status: "succeeded", result, event: { authoritative: true } });
  expect(f.succeed).toHaveBeenCalledWith(result, signal);
  const callbacks = f.controller.mock.calls[0][0];
  await callbacks.renewRun(request, signal);
  await callbacks.emit(request, "text", signal);
  expect(f.renew).toHaveBeenCalledWith(signal);
  expect(f.progress).toHaveBeenCalledWith("text", signal);
});
it("does not report success or failure for a duplicate dispatch", async () => {
  f.execute.mockResolvedValue({ status: "already_dispatched" });
  expect(await createStartedRepositoryRunExecutor({} as never)(request, 2, signal)).toEqual({ status: "already_dispatched" });
  expect(f.succeed).not.toHaveBeenCalled();
  expect(f.fail).not.toHaveBeenCalled();
});
it.each(["claim", "success-response"])("does not turn ambiguous %s into a competing failure", async stage => {
  if (stage === "claim") f.execute.mockRejectedValue(new Error("UNKNOWN"));
  else {
    f.execute.mockResolvedValue({ status: "succeeded", result: {} });
    f.succeed.mockRejectedValue(new Error("UNKNOWN"));
  }
  await expect(createStartedRepositoryRunExecutor({} as never)(request, 2, signal)).rejects.toThrow("UNKNOWN");
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.fail).not.toHaveBeenCalled();
});
