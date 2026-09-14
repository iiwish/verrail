import { describe, expect, it, vi } from "vitest";
import { createDirectorToolSessions, directorMcpRuntimeArgs } from "../services/director-tools.js";
import { manageTargetInputSchema } from "@paperclipai/shared";

const request = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("Director scoped tools", () => {
  it("requires a bounded archive version exclusively for archival operations", () => {
    const input = { operation: "archive", expectedTargetRevisionId: "00000000-0000-4000-8000-000000000001" };
    expect(manageTargetInputSchema.safeParse(input).success).toBe(false);
    for (const expectedArchiveVersion of [-1, 0.5]) expect(manageTargetInputSchema.safeParse({ ...input, expectedArchiveVersion }).success).toBe(false);
    expect(manageTargetInputSchema.safeParse({ ...input, expectedArchiveVersion: 0 }).success).toBe(true);
    expect(manageTargetInputSchema.safeParse({ ...input, operation: "restore", expectedArchiveVersion: 1 }).success).toBe(true);
    expect(manageTargetInputSchema.safeParse({ ...input, operation: "cancel", expectedArchiveVersion: 0 }).success).toBe(false);
    expect(manageTargetInputSchema.safeParse({ ...input, expectedArchiveVersion: 0, title: "Changed" }).success).toBe(false);
  });
  it("authorizes only the six bounded tools without weakening the sandbox or passing a secret in arguments", () => {
    const args = directorMcpRuntimeArgs(3270).join("\n");
    expect(args).toContain('http://127.0.0.1:3270/api/director/mcp');
    expect(args.match(/approval_mode="approve"/g)).toHaveLength(6);
    expect(args).toContain("switch_current_target");
    expect(args).not.toContain("danger-full-access");
    expect(args).not.toContain("default_tools_approval_mode");
    expect(args).not.toContain("bearer_token=");
  });
  it("rejects missing, revoked and expired capabilities", async () => {
    let now = 0;
    const sessions = createDirectorToolSessions(() => now);
    const call = vi.fn();
    const session = sessions.create(call);
    await expect(sessions.handle("unknown", request("list_targets", {}))).rejects.toThrow();
    now = 120_000;
    await expect(sessions.handle(session.token, request("list_targets", {}))).rejects.toThrow();
    const next = sessions.create(call);
    next.revoke();
    await expect(sessions.handle(next.token, request("list_targets", {}))).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("lists only read and proposal tools, never confirmation or execution", async () => {
    const sessions = createDirectorToolSessions();
    const { token } = sessions.create(vi.fn());
    const result = await sessions.handle(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.stringify(result)).toContain("list_targets");
    expect(JSON.stringify(result)).not.toContain('"name":"confirm');
    expect(JSON.stringify(result)).not.toContain('"name":"run');
  });

  it("rejects workspace/principal injection, unbounded reads, unknown tools and malformed mutations", async () => {
    const sessions = createDirectorToolSessions();
    const call = vi.fn();
    const { token } = sessions.create(call);
    for (const [name, args] of [
      ["list_targets", { workspaceId: "other" }],
      ["list_targets", { principalId: "owner" }],
      ["list_targets", { limit: 1000 }],
      ["confirm_target", {}],
      ["propose_target_change", { targetId: "x", input: {} }],
      ["switch_current_target", { targetId: null, expectedContextVersion: 0, workspaceId: "other" }],
      ["switch_current_target", { targetId: null, expectedContextVersion: -1 }],
    ] as const) {
      expect(await sessions.handle(token, request(name, args))).toMatchObject({ result: { isError: true } });
    }
    expect(call).not.toHaveBeenCalled();
    await sessions.handle(token, request("list_targets", {}));
    expect(call).toHaveBeenCalledWith("list_targets", { archiveState: "unarchived", offset: 0, limit: 10 });
    const withProgress = request("list_targets", {});
    expect(await sessions.handle(token, { ...withProgress, params: { ...withProgress.params, _meta: { progressToken: 1 } } })).toMatchObject({ result: { content: expect.any(Array) } });
  });

  it("limits tools per invocation", async () => {
    const sessions = createDirectorToolSessions();
    const call = vi.fn().mockResolvedValue({ targets: [] });
    const { token } = sessions.create(call);
    for (let i = 0; i < 21; i++) await sessions.handle(token, request("list_targets", {}));
    expect(call).toHaveBeenCalledTimes(20);
  });
});
