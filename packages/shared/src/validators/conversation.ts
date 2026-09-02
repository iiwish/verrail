import { z } from "zod";
import {
  CONVERSATION_MESSAGE_ROLES,
  CONVERSATION_STATUSES,
  TARGET_CREATION_DRAFT_STATUSES,
} from "../types/conversation.js";

export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export const conversationMessageRoleSchema = z.enum(CONVERSATION_MESSAGE_ROLES);
export const targetCreationDraftStatusSchema = z.enum(TARGET_CREATION_DRAFT_STATUSES);
export const conversationContextTypeSchema = z.enum([
  "collection",
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

export const targetDraftResourceRefSchema = z.object({
  kind: z.string().trim().min(1).max(100),
  id: z.string().trim().min(1).max(500),
  label: z.string().trim().min(1).max(300).nullable().optional(),
  href: z.string().trim().min(1).max(1_000).nullable().optional(),
  contentHash: z.string().trim().min(1).max(256).nullable().optional(),
}).strict();

export const targetDraftDefinitionPatchSchema = z.object({
  collectionId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(160).nullable().optional(),
  summary: z.string().trim().min(1).max(2_000).nullable().optional(),
  outcomeOwner: z.discriminatedUnion("principalType", [
    z.object({
      principalType: z.literal("user"),
      principalId: z.string().trim().min(1).max(200),
    }).strict(),
    z.object({
      principalType: z.literal("agent"),
      principalId: z.string().uuid(),
    }).strict(),
  ]).nullable().optional(),
  goal: z.string().trim().min(1).max(4_000).nullable().optional(),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
  acceptanceCriteria: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000).nullable().optional(),
  }).strict()).max(20).optional(),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).nullable().optional(),
  deadline: z.iso.date().nullable().optional(),
  policySummary: z.string().trim().min(1).max(4_000).nullable().optional(),
  resourceRefs: z.array(targetDraftResourceRefSchema).max(50).optional(),
}).strict();

export const createTargetCreationDraftSchema = z.object({
  sourceMessageId: z.string().uuid(),
  initial: targetDraftDefinitionPatchSchema.optional().default({}),
  fieldSources: z.record(z.string(), z.record(z.string(), z.unknown())).optional().default({}),
}).strict();

export const updateTargetCreationDraftSchema = z.object({
  expectedRevisionNumber: z.number().int().positive(),
  patch: targetDraftDefinitionPatchSchema,
  fieldSources: z.record(z.string(), z.record(z.string(), z.unknown())).optional().default({}),
}).strict().refine((value) => Object.keys(value.patch).length > 0, "At least one draft field is required");

export const confirmTargetCreationDraftSchema = z.object({
  expectedRevisionNumber: z.number().int().positive(),
}).strict();

export const createProviderConversationBindingSchema = z.object({
  conversationId: z.string().uuid(),
  providerKey: z.string().trim().min(1).max(100),
  connectionId: z.string().trim().min(1).max(200),
  externalConversationType: z.enum(["group", "direct"]),
  externalConversationId: z.string().trim().min(1).max(500),
}).strict();

export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type SendConversationMessageInput = z.infer<typeof sendConversationMessageSchema>;
export type TargetDraftDefinitionPatch = z.infer<typeof targetDraftDefinitionPatchSchema>;
export type CreateTargetCreationDraftInput = z.infer<typeof createTargetCreationDraftSchema>;
export type UpdateTargetCreationDraftInput = z.infer<typeof updateTargetCreationDraftSchema>;
export type ConfirmTargetCreationDraftInput = z.infer<typeof confirmTargetCreationDraftSchema>;
export type CreateProviderConversationBindingInput = z.infer<typeof createProviderConversationBindingSchema>;
