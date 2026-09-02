import { z } from "zod";

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const stringList = z.array(z.string().trim().min(1).max(200)).max(200).default([]);

export const createAgentDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: nullableText(4_000),
  compatibilityAgentId: z.string().uuid().nullable().optional(),
}).strict();

export const updateAgentDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableText(4_000),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const publishAgentVersionSchema = z.object({
  runtime: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(300),
  prompt: z.string().min(1).max(200_000),
  skills: stringList,
  tools: stringList,
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  capabilityCeiling: stringList,
  supplyChain: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const recordEvaluationRunSchema = z.object({
  candidateAgentVersionId: z.string().uuid(),
  baselineAgentVersionId: z.string().uuid().nullable().optional(),
  status: z.enum(["passed", "failed", "inconclusive"]),
  qualityScore: z.number().int().min(0).max(100).nullable().optional(),
  costCents: z.number().int().nonnegative().nullable().optional(),
  latencyMs: z.number().int().nonnegative().nullable().optional(),
  safetyStatus: z.enum(["passed", "failed", "not_run"]),
  summary: nullableText(10_000),
}).strict().superRefine((value, context) => {
  if (value.status === "passed" && value.safetyStatus !== "passed") {
    context.addIssue({ code: "custom", message: "A passing evaluation requires passing safety", path: ["safetyStatus"] });
  }
});

export const createDeploymentSchema = z.object({
  agentDefinitionId: z.string().uuid(),
  agentVersionId: z.string().uuid(),
  evaluationRunId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  isDefault: z.boolean().default(false),
  runtimeConfig: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const reviseDeploymentSchema = z.object({
  action: z.enum(["pause", "resume", "upgrade", "rollback", "retire", "set_default"]),
  agentVersionId: z.string().uuid().optional(),
  evaluationRunId: z.string().uuid().optional(),
  sourceDeploymentRevisionId: z.string().uuid().optional(),
  runtimeConfig: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "upgrade" && (!value.agentVersionId || !value.evaluationRunId)) {
    context.addIssue({ code: "custom", message: "Upgrade requires agentVersionId and evaluationRunId" });
  }
  if (value.action === "rollback" && !value.sourceDeploymentRevisionId) {
    context.addIssue({ code: "custom", message: "Rollback requires sourceDeploymentRevisionId" });
  }
});

export type CreateAgentDefinitionInput = z.infer<typeof createAgentDefinitionSchema>;
export type UpdateAgentDefinitionInput = z.infer<typeof updateAgentDefinitionSchema>;
export type PublishAgentVersionInput = z.infer<typeof publishAgentVersionSchema>;
export type RecordEvaluationRunInput = z.infer<typeof recordEvaluationRunSchema>;
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;
export type ReviseDeploymentInput = z.infer<typeof reviseDeploymentSchema>;
