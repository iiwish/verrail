import { z } from "zod";
import { targetIdempotencyKeySchema } from "./target.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "Must be a lowercase 64-character sha256 hex digest");

export const adjudicationIdempotencyKeySchema = targetIdempotencyKeySchema;

export const adjudicationReviewVerdictSchema = z.enum(["approved", "changes_requested", "rejected"]);
export const adjudicationAcceptanceAuthoritySchema = z.literal("outcome_owner");
export const adjudicationAcceptanceValiditySchema = z.enum(["valid", "invalid"]);
export const adjudicationAcceptanceInvalidReasonSchema = z.enum([
  "superseded_submission",
  "target_revision_changed",
]);

export const createSubmissionSchema = z
  .object({
    targetId: z.string().uuid(),
    targetRevisionId: z.string().uuid(),
    artifactRevisionIds: z.array(z.string().uuid()).min(1).max(100),
    verificationResultIds: z.array(z.string().uuid()).max(200).default([]),
    commitRef: z.string().trim().min(1).max(500).nullable().optional(),
    environmentSummary: z.string().trim().min(1).max(2000).nullable().optional(),
    notes: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.artifactRevisionIds).size !== value.artifactRevisionIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "artifactRevisionIds must not contain duplicates",
        path: ["artifactRevisionIds"],
      });
    }
    if (new Set(value.verificationResultIds).size !== value.verificationResultIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "verificationResultIds must not contain duplicates",
        path: ["verificationResultIds"],
      });
    }
  });

export const recordDeliveryReviewSchema = z.object({
  submissionId: z.string().uuid(),
  reviewerPrincipalType: z.literal("user"),
  reviewerPrincipalId: z.string().trim().min(1).max(200),
  verdict: adjudicationReviewVerdictSchema,
  risks: z.string().trim().min(1).max(2000).nullable().optional(),
  unprovenItems: z.array(z.string().trim().min(1).max(500)).max(20),
  comments: z.string().trim().min(1).max(4000).nullable().optional(),
}).strict();

export const acceptSubmissionSchema = z.object({
  submissionId: z.string().uuid(),
  reviewId: z.string().uuid(),
}).strict();

export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;
export type RecordDeliveryReviewInput = z.infer<typeof recordDeliveryReviewSchema>;
export type AcceptSubmissionInput = z.infer<typeof acceptSubmissionSchema>;

/**
 * Derived acceptance validity (ontology invariant 10; spec.md G2.4):
 * an acceptance is valid iff its submission is the latest submission for the
 * target AND its target revision equals the target's active revision.
 * Precedence when both facts changed: superseded_submission wins. This pure
 * function mirrors the Go `deriveAcceptanceValidity` helper so the read model
 * and the domain agree on one rule.
 */
export function deriveAcceptanceValidity(
  submissionIsLatest: boolean,
  revisionMatches: boolean,
): { validity: "valid" | "invalid"; invalidReason: "superseded_submission" | "target_revision_changed" | null } {
  if (!submissionIsLatest) {
    return { validity: "invalid", invalidReason: "superseded_submission" };
  }
  if (!revisionMatches) {
    return { validity: "invalid", invalidReason: "target_revision_changed" };
  }
  return { validity: "valid", invalidReason: null };
}
