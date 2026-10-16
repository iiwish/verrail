import { conversationInvocationEventSchema, type ConversationInvocationEvent, type ConversationInvocationStatus } from "@paperclipai/shared";
import { conflict } from "../errors.js";

export interface ConversationInvocationState {
  status: ConversationInvocationStatus;
  output: string;
  errorCode: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export function reduceConversationInvocation(state: ConversationInvocationState, event: ConversationInvocationEvent, now: Date): ConversationInvocationState {
  event = conversationInvocationEventSchema.parse(event);
  if (state.finishedAt || ["succeeded", "failed", "canceled"].includes(state.status)) throw conflict("Invocation is terminal");
  switch (event.type) {
    case "start":
      if (state.status === "cancel_requested" && !state.startedAt) return { ...state, startedAt: now };
      if (state.status !== "queued") throw conflict("Invocation already started");
      return { ...state, status: "running", startedAt: now };
    case "chunk": {
      if (!state.startedAt || (state.status !== "running" && state.status !== "cancel_requested")) throw conflict("Invocation has not started");
      const output = state.output + event.data.text;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) throw conflict("Invocation output exceeds limit");
      return { ...state, output };
    }
    case "cancel_requested":
      return { ...state, status: "cancel_requested" };
    case "error":
      return { ...state, status: "failed", errorCode: event.data.errorCode, finishedAt: now };
    case "done":
      if (event.data.status === "succeeded" && !state.startedAt) throw conflict("Invocation has not started");
      return { ...state, status: event.data.status, errorCode: event.data.errorCode ?? null, finishedAt: now };
  }
}
