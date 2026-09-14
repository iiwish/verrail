import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), resolve: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("../adapters/utils.js", () => ({ resolveCommandForLogs: mocks.resolve }));
import { resolveConversationRuntimeCommand } from "../services/conversation-runtime-command.js";

describe("conversation runtime command discovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolve.mockImplementation(async (command: string) => command);
    mocks.access.mockRejectedValue(new Error("missing"));
  });

  it("finds the desktop binary when the service PATH lacks Codex", async () => {
    mocks.access.mockImplementation(async (path: string) => {
      if (path !== "/Applications/ChatGPT.app/Contents/Resources/codex") throw new Error("missing");
    });
    expect(await resolveConversationRuntimeCommand("codex", "/tmp/chat", { PATH: "/usr/bin", HOME: "/Users/test" }, "darwin"))
      .toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
  });

  it("prefers the executable already on PATH", async () => {
    mocks.resolve.mockResolvedValue("/usr/local/bin/codex");
    expect(await resolveConversationRuntimeCommand("codex", "/tmp/chat", {}, "darwin")).toBe("/usr/local/bin/codex");
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it("honors explicit commands without silently falling back", async () => {
    expect(await resolveConversationRuntimeCommand("codex", "/tmp/chat", { VERRAIL_CHAT_COMMAND: "/custom/codex" }, "darwin"))
      .toBe("/custom/codex");
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("does not search app bundles on %s", async (platform) => {
    expect(await resolveConversationRuntimeCommand("codex", "/tmp/chat", {}, platform)).toBe("codex");
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it("does not substitute Codex for Claude", async () => {
    expect(await resolveConversationRuntimeCommand("claude", "/tmp/chat", {}, "darwin")).toBe("claude");
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it("leaves a missing runtime to the existing spawn error handling", async () => {
    expect(await resolveConversationRuntimeCommand("codex", "/tmp/chat", {}, "darwin")).toBe("codex");
  });
});
