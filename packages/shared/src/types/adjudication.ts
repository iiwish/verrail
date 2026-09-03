export const ADJUDICATION_SCHEMA_VERSION = 1 as const;

export const ADJUDICATION_REVIEW_VERDICTS = ["approved", "changes_requested", "rejected"] as const;

export const ADJUDICATION_ACCEPTANCE_AUTHORITIES = ["outcome_owner"] as const;

export const ADJUDICATION_ACCEPTANCE_VALIDITIES = ["valid", "invalid"] as const;

export const ADJUDICATION_ACCEPTANCE_INVALID_REASONS = [
  "superseded_submission",
  "target_revision_changed",
] as const;

export type AdjudicationReviewVerdict = (typeof ADJUDICATION_REVIEW_VERDICTS)[number];
export type AdjudicationAcceptanceAuthority = (typeof ADJUDICATION_ACCEPTANCE_AUTHORITIES)[number];
export type AdjudicationAcceptanceValidity = (typeof ADJUDICATION_ACCEPTANCE_VALIDITIES)[number];
export type AdjudicationAcceptanceInvalidReason =
  (typeof ADJUDICATION_ACCEPTANCE_INVALID_REASONS)[number];

export interface AdjudicationPrincipalV1 {
  principalType: string;
  principalId: string;
}

/**
 * Immutable candidate binding a TargetRevision to artifact revision and
 * verification result sets (ontology 147-149). Material changes require a
 * new Submission; existing rows are never modified in place.
 */
export interface AdjudicationSubmissionV1 {
  id: string;
  targetId: string;
  targetRevisionId: string;
  artifactRevisionIds: string[];
  verificationResultIds: string[];
  commitRef: string | null;
  environmentSummary: string | null;
  notes: string | null;
  submissionHash: string;
  submittedBy: AdjudicationPrincipalV1;
  createdAt: string;
}

/** Immutable reviewer conclusion bound to one Submission (ontology 151). */
export interface AdjudicationDeliveryReviewV1 {
  id: string;
  targetId: string;
  submissionId: string;
  verdict: AdjudicationReviewVerdict;
  risks: string | null;
  unprovenItems: string[];
  comments: string | null;
  reviewHash: string;
  reviewer: AdjudicationPrincipalV1;
  createdAt: string;
}

/**
 * Outcome-owner settlement of one Submission through one approved
 * DeliveryReview (ontology 153). `validity` is derived, never stored: an
 * acceptance is valid iff its submission is the latest submission for the
 * target and its target revision is still the target's active revision.
 */
export interface AdjudicationAcceptanceV1 {
  id: string;
  targetId: string;
  targetRevisionId: string;
  submissionId: string;
  reviewId: string;
  authority: AdjudicationAcceptanceAuthority;
  acceptedBy: AdjudicationPrincipalV1;
  acceptanceHash: string;
  createdAt: string;
  validity: AdjudicationAcceptanceValidity;
  invalidReason: AdjudicationAcceptanceInvalidReason | null;
}

export interface AdjudicationTargetFactsV1 {
  schemaVersion: typeof ADJUDICATION_SCHEMA_VERSION;
  submissions: AdjudicationSubmissionV1[];
  reviews: AdjudicationDeliveryReviewV1[];
  acceptances: AdjudicationAcceptanceV1[];
}
