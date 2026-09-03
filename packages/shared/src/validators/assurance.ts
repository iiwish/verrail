import { z } from "zod";
import { targetIdempotencyKeySchema } from "./target.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Must be a lowercase 64-character sha256 hex digest");
const principalType = z.enum(["user", "service", "agent"]);

export const assuranceIdempotencyKeySchema = targetIdempotencyKeySchema;

export const assuranceArtifactKindSchema = z.enum(["code_change", "document", "report", "external_reference"]);
export const assuranceClaimStatusSchema = z.enum(["open", "supported", "refuted", "waived"]);
export const assuranceEvidenceKindSchema = z.enum([
  "ci_result",
  "scan_result",
  "human_review",
  "agent_observation",
  "external_reference",
]);
export const assuranceTrustLevelSchema = z.enum(["high", "medium", "low"]);
export const assuranceVerdictSchema = z.enum(["passed", "failed", "inconclusive", "waived"]);

export const createArtifactSchema = z.object({
  targetId: z.string().uuid(),
  kind: assuranceArtifactKindSchema,
  title: z.string().trim().min(1).max(200),
}).strict();

export const addArtifactRevisionSchema = z.object({
  artifactId: z.string().uuid(),
  contentHash: sha256Hex,
  contentRef: z.string().trim().min(1).max(500),
  sourceRunId: z.string().uuid().nullable().optional(),
  sourceWorkNodeId: z.string().uuid().nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
}).strict();

export const createClaimSchema = z.object({
  targetId: z.string().uuid(),
  targetRevisionId: z.string().uuid(),
  criterionKey: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
}).strict();

export const recordEvidenceSchema = z
  .object({
    targetId: z.string().uuid(),
    claimId: z.string().uuid().nullable().optional(),
    kind: assuranceEvidenceKindSchema,
    producerPrincipalType: principalType,
    producerPrincipalId: z.string().trim().min(1).max(200),
    objectHash: sha256Hex,
    reference: z.string().trim().min(1).max(500),
    trustLevel: assuranceTrustLevelSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.producerPrincipalType === "agent" && (value.kind !== "agent_observation" || value.trustLevel !== "low")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trustLevel"],
        message: "Agent-produced evidence must be a low-trust agent observation",
      });
    }
  });

export const recordVerificationResultSchema = z.object({
  claimId: z.string().uuid(),
  verdict: assuranceVerdictSchema,
  verifierVersion: z.string().trim().min(1).max(100),
  evidenceIds: z.array(z.string().uuid()).max(100),
  waiverReference: z.string().trim().min(1).max(500).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.verdict === "waived") {
    if (value.waiverReference == null) {
      context.addIssue({
        code: "custom",
        message: "A waived verdict requires a waiverReference",
        path: ["waiverReference"],
      });
    }
    return;
  }
  if (value.waiverReference != null) {
    context.addIssue({
      code: "custom",
      message: "waiverReference is only allowed for waived verdicts",
      path: ["waiverReference"],
    });
  }
  if (value.evidenceIds.length < 1) {
    context.addIssue({
      code: "custom",
      message: "A non-waived verdict requires at least one evidenceId",
      path: ["evidenceIds"],
    });
  }
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    context.addIssue({
      code: "custom",
      message: "evidenceIds must not contain duplicates",
      path: ["evidenceIds"],
    });
  }
});

export type CreateArtifactInput = z.infer<typeof createArtifactSchema>;
export type AddArtifactRevisionInput = z.infer<typeof addArtifactRevisionSchema>;
export type CreateClaimInput = z.infer<typeof createClaimSchema>;
export type RecordEvidenceInput = z.infer<typeof recordEvidenceSchema>;
export type RecordVerificationResultInput = z.infer<typeof recordVerificationResultSchema>;
