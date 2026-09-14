import { describe, expect, it } from "vitest";
import { reduceConversationInvocation } from "./conversation-invocation-state.js";

const state = { status: "queued" as const, output: "", errorCode: null, startedAt: null, finishedAt: null };
const now = new Date("2026-09-14T00:00:00Z");

describe("conversation invocation transitions", () => {
  it("starts, accumulates output and records terminal time", () => {
    const running = reduceConversationInvocation(state, { type: "start", data: {} }, now);
    const streaming = reduceConversationInvocation(running, { type: "chunk", data: { text: "Hello" } }, now);
    expect(reduceConversationInvocation(streaming, { type: "done", data: { status: "succeeded" } }, now)).toMatchObject({ status: "succeeded", output: "Hello", startedAt: now, finishedAt: now });
  });
  it("does not equate a cancellation request with a stopped runtime", () => {
    const running = reduceConversationInvocation(state, { type: "start", data: {} }, now);
    const stopping = reduceConversationInvocation(running, { type: "cancel_requested", data: {} }, now);
    expect(stopping).toMatchObject({ status: "cancel_requested", finishedAt: null });
    expect(reduceConversationInvocation(stopping, { type: "chunk", data: { text: "partial" } }, now).status).toBe("cancel_requested");
    expect(reduceConversationInvocation(stopping, { type: "done", data: { status: "canceled" } }, now).finishedAt).toEqual(now);
  });
  it("rejects output before start and changes after terminal results", () => {
    expect(() => reduceConversationInvocation(state, { type: "chunk", data: { text: "Hello" } }, now)).toThrow();
    const failed = reduceConversationInvocation(state, { type: "error", data: { errorCode: "RUNTIME_UNAVAILABLE" } }, now);
    expect(failed).toMatchObject({ status: "failed", errorCode: "RUNTIME_UNAVAILABLE", finishedAt: now });
    expect(() => reduceConversationInvocation(failed, { type: "start", data: {} }, now)).toThrow();
  });
  it("bounds UTF-8 output bytes", () => {
    const running = { ...state, status: "running" as const, startedAt: now, output: "x".repeat(2 * 1024 * 1024 - 1) };
    expect(() => reduceConversationInvocation(running, { type: "chunk", data: { text: "界" } }, now)).toThrow("limit");
  });
  it("does not accept successful completion without a started runtime", () => {
    expect(() => reduceConversationInvocation(state, { type: "done", data: { status: "succeeded" } }, now)).toThrow();
    expect(reduceConversationInvocation(state, { type: "done", data: { status: "canceled" } }, now).status).toBe("canceled");
  });
  it("preserves a racing cancellation while acknowledging a start", () => {
    const pending = reduceConversationInvocation(state, { type: "cancel_requested", data: {} }, now);
    expect(() => reduceConversationInvocation(pending, { type: "chunk", data: { text: "premature" } }, now)).toThrow();
    expect(reduceConversationInvocation(pending, { type: "start", data: {} }, now)).toMatchObject({ status: "cancel_requested", startedAt: now });
  });
});
