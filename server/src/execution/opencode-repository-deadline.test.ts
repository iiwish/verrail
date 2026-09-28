import { expect, it, vi } from "vitest";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";

const runtime = vi.hoisted(() => vi.fn(async () => {}));
const createRuntime = vi.hoisted(() => vi.fn(() => runtime));
vi.mock("./opencode-runtime.js", () => ({ createOpenCodeToolRuntime: createRuntime }));
import { createOpenCodeRepositoryRuntime } from "./opencode-repository-runtime.js";

it("propagates the repository Run budget and retains immediate cancellation", async () => {
  const controller = new AbortController();
  const request = { timeoutSeconds: 900, model: "fixture/test", instructions: "test",
    runAttemptId: "11111111-1111-4111-8111-111111111111" } as RepositoryExecutionRequest;
  const run = createOpenCodeRepositoryRuntime({ version: "1.17.13", providers: {},
    authorize: async () => {}, consumeToolCall: async () => {}, emit: async () => {} });
  await expect(run(request, "/tmp/unused", controller.signal)).resolves.toEqual({ exitCode: 0 });
  expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ executionTimeoutMs: 900_000 }));
  controller.abort(new Error("canceled"));
  await expect(run(request, "/tmp/unused", controller.signal)).rejects.toThrow("canceled");
  expect(runtime).toHaveBeenCalledOnce();
});
