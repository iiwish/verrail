import { expect, it, vi } from "vitest";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";

const runtime = vi.hoisted(() => vi.fn(async () => ({ runtime: "opencode", runtimeVersion: "1.17.13", model: "fixture/test",
  startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z", cleanup: { runtime: true, home: true } })));
const createRuntime = vi.hoisted(() => vi.fn(() => runtime));
vi.mock("./opencode-runtime.js", () => ({ createOpenCodeToolRuntime: createRuntime }));
import { createOpenCodeRepositoryRuntime } from "./opencode-repository-runtime.js";

it("propagates the repository Run budget and retains immediate cancellation", async () => {
  const controller = new AbortController();
  const request = { timeoutSeconds: 900, model: "fixture/test", instructions: "test",
    runAttemptId: "11111111-1111-4111-8111-111111111111" } as RepositoryExecutionRequest;
  const run = createOpenCodeRepositoryRuntime({ version: "1.17.13", providers: {},
    authorize: async () => {}, consumeToolCall: async () => {}, emit: async () => {} });
  await expect(run(request, "/tmp/unused", controller.signal)).resolves.toMatchObject({ exitCode: 0,
    executionFacts: { runtime: "opencode", model: "fixture/test", cleanup: { runtime: true, commands: true, home: true } } });
  expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ executionTimeoutMs: 900_000 }));
  controller.abort(new Error("canceled"));
  await expect(run(request, "/tmp/unused", controller.signal)).rejects.toThrow("canceled");
  expect(runtime).toHaveBeenCalledOnce();
});
