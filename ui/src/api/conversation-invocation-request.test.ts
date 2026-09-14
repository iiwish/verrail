// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDurableConversationInvocation } from "./conversation-invocation-request";
const start = vi.hoisted(() => vi.fn());
vi.mock("./conversations", () => ({ conversationsApi: { startInvocation: start } }));
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("durable conversation request identity", () => {
  it("retains the same idempotency key after a lost response without storing message text", async () => {
    vi.stubGlobal("crypto", webcrypto);
    start.mockRejectedValueOnce(new Error("connection lost"));
    await expect(startDurableConversationInvocation("workspace", "conversation", "Private user message")).rejects.toThrow("connection lost");
    const key = start.mock.calls[0][3];
    expect(sessionStorage.getItem("verrail:pending-invocation:workspace:conversation")).not.toContain("Private user message");
    start.mockResolvedValue({ invocation: { id: "accepted" }, replayed: true });
    await startDurableConversationInvocation("workspace", "conversation", "Private user message");
    expect(start.mock.calls[1][3]).toBe(key);
    expect(sessionStorage.getItem("verrail:pending-invocation:workspace:conversation")).toBeNull();
    await startDurableConversationInvocation("workspace", "conversation", "Private user message");
    expect(start.mock.calls[2][3]).not.toBe(key);
  });
});
