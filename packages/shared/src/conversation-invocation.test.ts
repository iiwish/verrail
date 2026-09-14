import { describe, expect, it } from "vitest";
import { conversationInvocationEventSchema, startConversationInvocationSchema } from "./conversation-invocation.js";

describe("conversation invocation wire contracts", () => {
  it("accepts only user text and idempotency, never caller-supplied authority", () => {
    expect(startConversationInvocationSchema.parse({ body: " Hello ", idempotencyKey: "turn-1" }).body).toBe("Hello");
    for (const key of ["workspaceId", "principalId", "agentVersionId", "command", "token", "cwd"]) {
      expect(startConversationInvocationSchema.safeParse({ body: "Hello", idempotencyKey: "turn-1", [key]: "forged" }).success).toBe(false);
    }
  });
  it("bounds prompts and deltas and prevents unstructured error diagnostics", () => {
    expect(startConversationInvocationSchema.safeParse({ body: "x".repeat(20001), idempotencyKey: "turn" }).success).toBe(false);
    expect(conversationInvocationEventSchema.safeParse({ type: "chunk", data: { text: "x".repeat(65537) } }).success).toBe(false);
    expect(conversationInvocationEventSchema.safeParse({ type: "error", data: { errorCode: "PROVIDER_FAILED" } }).success).toBe(true);
    expect(conversationInvocationEventSchema.safeParse({ type: "error", data: { errorCode: "secret value in diagnostic" } }).success).toBe(false);
  });
  it("requires an explicit terminal disposition", () => {
    expect(conversationInvocationEventSchema.safeParse({ type: "done", data: {} }).success).toBe(false);
    expect(conversationInvocationEventSchema.parse({ type: "done", data: { status: "canceled" } })).toEqual({ type: "done", data: { status: "canceled" } });
  });
});
