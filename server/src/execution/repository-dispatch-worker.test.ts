import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), build: vi.fn(), start: vi.fn() }));
vi.mock("./repository-offers.js", () => ({ listOfferedRepositoryAttempts: mocks.list }));
vi.mock("./repository-request-builder.js", () => ({ buildOfferedRepositoryRequest: mocks.build }));
vi.mock("./repository-start.js", () => ({ startOfferedRepositoryAttempt: mocks.start }));
import { runRepositoryDispatchWorker } from "./repository-dispatch-worker.js";

beforeEach(() => { vi.resetAllMocks(); });
function fixture() {
  const workspaceId = randomUUID();
  const offer = { runAttemptId: randomUUID(), runId: randomUUID(), targetId: randomUUID(), targetRevisionId: randomUUID(),
    graphRevisionId: randomUUID(), workNodeId: randomUUID(), leaseId: randomUUID(), fencingToken: 1,
    agentVersionId: randomUUID(), deploymentRevisionId: randomUUID() };
  const request = { workspaceId, ...offer } as RepositoryExecutionRequest;
  mocks.list.mockResolvedValue([offer]); mocks.build.mockResolvedValue(request); mocks.start.mockResolvedValue(43);
  const query = { select: vi.fn(), from: vi.fn(), where: vi.fn(), limit: vi.fn().mockResolvedValue([{ cursor: 41 }]) };
  for (const fn of [query.select, query.from, query.where]) fn.mockReturnValue(query);
  const controller = new AbortController();
  const execute = vi.fn(async () => { controller.abort(); });
  const onFailure = vi.fn();
  const onActive = vi.fn();
  const options = { db: query as unknown as Db, storage: { getObject: vi.fn() }, domainApi: { reportRunEvent: vi.fn() },
    workspaceIds: [workspaceId], signal: controller.signal, intervalMs: 100, execute, onFailure, onActive };
  return { options, controller, offer, request, execute, onFailure };
}

it("discovers, builds and starts from the persisted cursor before executing", async () => {
  const f = fixture(); await runRepositoryDispatchWorker(f.options);
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: f.options.workspaceIds[0], limit: 1 }));
  expect(mocks.build).toHaveBeenCalledWith(expect.objectContaining({ identity: { workspaceId: f.options.workspaceIds[0], ...f.offer } }));
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ lastEventCursor: 41, request: f.request }));
  expect(f.execute).toHaveBeenCalledWith(f.request, 43, f.controller.signal);
  expect(f.onFailure).not.toHaveBeenCalled();
  expect(f.options.onActive.mock.calls).toEqual([[true], [false]]);
});

it("waits for active execution cleanup and never dispatches concurrently", async () => {
  const f = fixture();
  let release!: () => void; let entered!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  f.execute.mockImplementation(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  let finished = false;
  const worker = runRepositoryDispatchWorker(f.options).then(() => { finished = true; });
  await active; f.controller.abort(); await Promise.resolve();
  expect(finished).toBe(false); expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.options.onActive.mock.calls).toEqual([[true]]);
  release(); await worker;
  expect(f.options.onActive.mock.calls).toEqual([[true], [false]]);
  expect(mocks.list).toHaveBeenCalledTimes(1);
});

it("does not claim work after cancellation during input construction", async () => {
  const f = fixture(); mocks.build.mockImplementation(async () => { f.controller.abort(); return f.request; });
  await runRepositoryDispatchWorker(f.options);
  expect(mocks.start).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});

it("does not launch a harness after an ambiguous start", async () => {
  const f = fixture(); mocks.start.mockRejectedValue(new Error("credential-secret-do-not-log"));
  f.onFailure.mockImplementation(() => f.controller.abort());
  await runRepositoryDispatchWorker(f.options);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.onFailure).toHaveBeenCalledWith({ workspaceId: f.options.workspaceIds[0], runAttemptId: f.offer.runAttemptId, code: "REPOSITORY_DISPATCH_FAILED" });
});

it("advances beyond a bad offer instead of starving the next one", async () => {
  const f = fixture(); const next = { ...f.offer, runAttemptId: randomUUID() };
  mocks.list.mockResolvedValueOnce([f.offer]).mockResolvedValueOnce([next]);
  mocks.build.mockRejectedValueOnce(new Error("invalid source")).mockResolvedValue(f.request);
  await runRepositoryDispatchWorker(f.options);
  expect(mocks.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: f.offer.runAttemptId }));
  expect(f.onFailure).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledTimes(1);
});

it("continues to another workspace after a scan failure", async () => {
  const f = fixture(); const second = randomUUID(); f.options.workspaceIds.push(second);
  mocks.list.mockRejectedValueOnce(new Error("private diagnostic")).mockImplementationOnce(async () => { f.controller.abort(); return []; });
  await runRepositoryDispatchWorker(f.options);
  expect(mocks.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ workspaceId: second }));
  expect(f.onFailure).toHaveBeenCalledWith({ workspaceId: f.options.workspaceIds[0], code: "REPOSITORY_SCAN_FAILED" });
});

it("rejects duplicate scope before scanning", async () => {
  const f = fixture(); f.options.workspaceIds.push(f.options.workspaceIds[0]);
  await expect(runRepositoryDispatchWorker(f.options)).rejects.toThrow("DUPLICATE_WORKSPACE");
  expect(mocks.list).not.toHaveBeenCalled();
});
