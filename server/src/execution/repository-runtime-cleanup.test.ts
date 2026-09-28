import { expect, it, vi } from "vitest";
import { createOpenCodeRepositoryRuntime } from "./opencode-repository-runtime.js";
import { GatewayRuntimeCleanupError } from "./gateway-store.js";

vi.mock("./repository-command.js", async importOriginal => ({
  ...await importOriginal<typeof import("./repository-command.js")>(),
  runRepositoryCommand: vi.fn(async () => { throw new Error("REPOSITORY_COMMAND_CLEANUP_FAILED"); }),
}));
vi.mock("./opencode-runtime.js", () => ({
  createOpenCodeToolRuntime: (options: { mcp: () => Record<string, { url: string; headers: Record<string, string> }> }) => async () => {
    const { repository } = options.mcp();
    const response = await fetch(repository.url, { method: "POST", headers: { ...repository.headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "execute_command", arguments: { command: "fixture", timeoutSeconds: 1 },
      } }) });
    await response.body?.cancel();
  },
}));

it("preserves uncertain command cleanup across MCP error sanitization and runtime teardown", async () => {
  const run = createOpenCodeRepositoryRuntime({ version: "1.17.13", launcher: "/fixture/sandbox", providers: {},
    authorize: async () => {}, consumeToolCall: async () => {}, emit: async () => {} });
  await expect(run({ runAttemptId: "11111111-1111-4111-8111-111111111111", instructions: "fixture", timeoutSeconds: 30 } as never,
    "/fixture/checkout", new AbortController().signal)).rejects.toBeInstanceOf(GatewayRuntimeCleanupError);
});
