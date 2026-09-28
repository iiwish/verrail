import { z } from "zod";

export const DIRECTOR_INSTRUCTIONS_CONFIG_KEY = "directorChatInstructions";
export const directorRolePromptSchema = z.string().trim().min(1).max(24_000);
export const previewDirectorInstructionsSchema = z.object({ rolePrompt: directorRolePromptSchema }).strict();
export const applyDirectorInstructionsSchema = previewDirectorInstructionsSchema.extend({
  expectedConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const directorInstructionsSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  rolePrompt: directorRolePromptSchema,
  appliedAt: z.string().datetime(),
  appliedByUserId: z.string().min(1),
}).strict();

export type DirectorInstructionsSnapshot = z.infer<typeof directorInstructionsSnapshotSchema>;
export type ApplyDirectorInstructionsInput = z.infer<typeof applyDirectorInstructionsSchema>;
export interface DirectorInstructionsView {
  schemaVersion: 1;
  mode: "local_compatibility" | "execution_gateway";
  runtime: "codex" | "claude" | "opencode";
  available: boolean;
  revision: number;
  configHash: string;
  roleSource: "builtin" | "custom";
  rolePrompt: string;
  defaultPrompt: string;
  roleHash: string;
  policyVersion: string;
  platformRules: string;
  toolRules: string;
  systemPrompt: string;
  effectiveHash: string;
  appliedAt: string | null;
  preview: boolean;
}

export function isWorkspaceDirector(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const marker = (metadata as Record<string, unknown>).paperclipBuiltInAgent;
  return Boolean(marker && typeof marker === "object" && !Array.isArray(marker)
    && (marker as Record<string, unknown>).key === "director");
}
