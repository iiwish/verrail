import { z } from "zod";

export const manageTargetInputSchema = z.object({
  expectedTargetRevisionId: z.string().uuid(),
  operation: z.enum(["update", "cancel", "archive", "restore"]),
  expectedArchiveVersion: z.number().int().nonnegative().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  summary: z.string().trim().min(1).max(2000).optional(),
  goal: z.string().trim().min(1).max(4000).optional(),
}).strict().superRefine((input, ctx) => {
  const hasChange = input.title !== undefined || input.summary !== undefined || input.goal !== undefined;
  if ((input.operation === "update") !== hasChange) {
    ctx.addIssue({ code: "custom", message: "Updates require fields; cancellation cannot change fields" });
  }
  const archival = input.operation === "archive" || input.operation === "restore";
  if (archival !== (input.expectedArchiveVersion !== undefined)) {
    ctx.addIssue({ code: "custom", message: "Only archive/restore require expectedArchiveVersion" });
  }
});

export const directorTargetProposalSchema = z.object({
  kind: z.literal("director_target_proposal"),
  targetId: z.string().uuid(),
  targetTitle: z.string(),
  initiatedByPrincipalId: z.string(),
  sourceMessageId: z.string().uuid(),
  before: z.object({ title: z.string(), summary: z.string().nullable(), goal: z.string() }).strict(),
  input: manageTargetInputSchema,
}).strict();

export type ManageTargetInput = z.infer<typeof manageTargetInputSchema>;
export type DirectorTargetProposal = z.infer<typeof directorTargetProposalSchema>;
export interface ManageTargetResult {
  targetId: string;
  targetRevisionId: string;
  operation: "update" | "cancel" | "archive" | "restore";
  archiveVersion?: number;
  archivedAt?: string | null;
  replayed: boolean;
}
