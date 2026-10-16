import { z } from "zod";

const key = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const criterionProofContractSchema = z.object({
  schemaVersion: z.literal(1),
  allOf: z.array(z.discriminatedUnion("kind", [
    z.object({ id: key, kind: z.literal("independent_verification"), phase: z.enum(["pre_acceptance", "post_effect"]), assertions: z.array(z.string().min(1).max(1000).refine((value) => value.trim().length > 0)).min(1).max(20) }).strict(),
    z.object({ id: key, kind: z.literal("human_governance"), phase: z.literal("post_governance") }).strict(),
    z.object({ id: key, kind: z.literal("pull_request_effect"), phase: z.literal("post_effect") }).strict(),
  ])).min(1).max(10),
}).strict().superRefine((contract, ctx) => {
  const ids = new Set<string>();
  const phases = new Set<string>();
  for (const requirement of contract.allOf) {
    if (ids.has(requirement.id)) ctx.addIssue({ code: "custom", message: "Proof requirement IDs must be unique" });
    ids.add(requirement.id);
    if (requirement.kind !== "independent_verification") continue;
    if (phases.has(requirement.phase)) ctx.addIssue({ code: "custom", message: "Only one independent verification requirement is allowed per phase" });
    phases.add(requirement.phase);
    if (new Set(requirement.assertions).size !== requirement.assertions.length) ctx.addIssue({ code: "custom", message: "Assertions must be unique" });
  }
});
export const criterionProofContextSchema = z.object({
  requirementId: key,
  submissionId: z.string().uuid().optional(),
  effectReceiptId: z.string().uuid().optional(),
}).strict().refine((context) => Boolean(context.submissionId) === Boolean(context.effectReceiptId), "Late proof requires both Submission and EffectReceipt");
export const reviseTargetProofSchema = z.object({
  expectedTargetRevisionId: z.string().uuid(),
  criteria: z.array(z.object({ criterionId: z.string().min(1).max(100), proofContract: criterionProofContractSchema }).strict()).min(1).max(20),
}).strict().refine((input) => new Set(input.criteria.map((item) => item.criterionId)).size === input.criteria.length, "Criterion IDs must be unique");
export type ReviseTargetProofInput = z.infer<typeof reviseTargetProofSchema>;
