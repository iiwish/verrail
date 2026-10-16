import { z } from "zod";

export const DIRECTOR_GATEWAY_TOOL_NAMES = ["get_conversation_context", "switch_current_target", "list_targets", "get_target", "propose_create_target", "propose_target_change"] as const;

export const executionGatewayRequestSchema = z.object({
  invocationId: z.string().uuid(), workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(), principalId: z.string().min(1).max(200),
  agentVersionId: z.string().uuid(), deploymentRevisionId: z.string().uuid(),
  fencingToken: z.number().int().positive().max(2147483647),
  runtime: z.literal("opencode"), model: z.string().regex(/^[^/\s]+\/.+$/).max(200),
  systemPrompt: z.string().min(1).max(80_000), prompt: z.string().min(1).max(400_000),
  directorToken: z.string().min(32).max(4096),
}).strict();

export type ExecutionGatewayRequest = z.infer<typeof executionGatewayRequestSchema>;
