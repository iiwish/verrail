import { z } from "zod";
import { CONVERSATION_MESSAGE_ROLES, CONVERSATION_STATUSES } from "../types/conversation.js";

export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export const conversationMessageRoleSchema = z.enum(CONVERSATION_MESSAGE_ROLES);
export const conversationContextTypeSchema = z.enum([
  "project",
  "target",
  "target_revision",
  "stage",
  "artifact_revision",
  "review",
  "run",
  "action_request",
]);

export const conversationListQuerySchema = z.object({
  status: conversationStatusSchema.optional().default("active"),
  q: z.string().trim().max(200).optional(),
}).strict();

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  contextBindings: z.array(z.object({
    contextType: conversationContextTypeSchema,
    contextId: z.string().trim().min(1).max(200),
    label: z.string().trim().max(200).nullable().optional(),
    href: z.string().trim().max(1000).nullable().optional(),
  }).strict()).max(8).optional().default([]),
}).strict();

export const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  status: conversationStatusSchema.optional(),
  pinned: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const sendConversationMessageSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
}).strict();

export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type SendConversationMessageInput = z.infer<typeof sendConversationMessageSchema>;
