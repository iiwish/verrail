import { expect, it, vi } from "vitest";
import { createRepositoryMcp } from "./repository-mcp.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("./repository-command.js", async importOriginal => ({
  ...await importOriginal<typeof import("./repository-command.js")>(), runRepositoryCommand: run,
}));
const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
function fixture() {
  const authorize = vi.fn(async () => {});
  const consumeToolCall = vi.fn(async () => {});
  const invalidate = vi.fn();
  run.mockReset().mockResolvedValue({ exitCode: 0, stdout: "done", stderr: "" });
  const handler = createRepositoryMcp({ launcher: "/trusted/sandbox", cwd: "/owned/checkout",
    signal: new AbortController().signal, authorize, consumeToolCall, invalidate });
  return { handler, authorize, consumeToolCall, invalidate };
}
it("exposes only the scoped offline repository command", async () => {
  const { handler } = fixture();
  const response = await handler(rpc("tools/list"));
  expect(response).toMatchObject({ result: { tools: [{ name: "execute_command" }] } });
  expect(JSON.stringify(response).match(/"name":"execute_command"/g)).toHaveLength(1);
});
it("uses server-bound paths, charges the call and rechecks authority", async () => {
  const { handler, authorize, consumeToolCall } = fixture();
  const result = await handler(rpc("tools/call", { name: "execute_command", arguments: { command: "make test", timeoutSeconds: 30 } }));
  expect(result).toMatchObject({ result: { content: [{ type: "text" }] } });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ launcher: "/trusted/sandbox", cwd: "/owned/checkout" }));
  expect(authorize).toHaveBeenCalledTimes(3);
  expect(consumeToolCall).toHaveBeenCalledOnce();
});
it("rejects alternate authority, injected paths and exhausted budgets", async () => {
  const { handler, consumeToolCall } = fixture();
  for (const params of [
    { name: "accept_target", arguments: {} },
    { name: "execute_command", arguments: { command: "pwd", timeoutSeconds: 1, cwd: "/etc" } },
  ]) expect(await handler(rpc("tools/call", params))).toMatchObject({ result: { isError: true } });
  consumeToolCall.mockRejectedValueOnce(new Error("secret internal diagnostic"));
  const response = await handler(rpc("tools/call", { name: "execute_command", arguments: { command: "pwd", timeoutSeconds: 1 } }));
  expect(response).toMatchObject({ result: { isError: true } });
  expect(JSON.stringify(response)).not.toContain("secret");
  expect(run).not.toHaveBeenCalled();
});
it("invalidates the attempt when sandbox cleanup cannot be confirmed", async () => {
  const { handler, invalidate } = fixture();
  run.mockRejectedValueOnce(new Error("REPOSITORY_COMMAND_CLEANUP_FAILED"));
  await handler(rpc("tools/call", { name: "execute_command", arguments: { command: "pwd", timeoutSeconds: 1 } }));
  expect(invalidate).toHaveBeenCalledOnce();
});
