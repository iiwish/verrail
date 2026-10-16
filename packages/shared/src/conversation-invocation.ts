import { z } from "zod";

export const CONVERSATION_INVOCATION_STATUSES = ["queued", "running", "cancel_requested", "succeeded", "failed", "canceled"] as const;
export type ConversationInvocationStatus = typeof CONVERSATION_INVOCATION_STATUSES[number];
export const startConversationInvocationSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict();

export const conversationInvocationEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), data: z.object({}).strict() }).strict(),
  z.object({ type: z.literal("chunk"), data: z.object({ text: z.string().min(1).max(65_536) }).strict() }).strict(),
  z.object({ type: z.literal("cancel_requested"), data: z.object({}).strict() }).strict(),
  z.object({ type: z.literal("done"), data: z.object({ status: z.enum(["succeeded", "failed", "canceled"]), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional() }).strict() }).strict(),
  z.object({ type: z.literal("error"), data: z.object({ errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/) }).strict() }).strict(),
]);

export type ConversationInvocationEvent = z.infer<typeof conversationInvocationEventSchema>;
export type StartConversationInvocationInput = z.infer<typeof startConversationInvocationSchema>;

export interface ConversationInvocationView {
  id: string;
  workspaceId: string;
  conversationId: string;
  sourceMessageId: string;
  principalId: string;
  agentVersionId: string;
  deploymentRevisionId: string;
  status: ConversationInvocationStatus;
  lastEventCursor: number;
  output: string;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
