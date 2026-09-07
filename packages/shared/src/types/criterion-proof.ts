export type CriterionProofPhase = "pre_acceptance" | "post_governance" | "post_effect";
export type CriterionProofRequirementV1 =
  | { id: string; kind: "independent_verification"; phase: "pre_acceptance" | "post_effect"; assertions: string[] }
  | { id: string; kind: "human_governance"; phase: "post_governance" }
  | { id: string; kind: "pull_request_effect"; phase: "post_effect" };
export interface CriterionProofContractV1 {
  schemaVersion: 1;
  allOf: CriterionProofRequirementV1[];
}
export interface CriterionProofContextV1 {
  requirementId: string;
  submissionId?: string;
  effectReceiptId?: string;
}
export interface CriterionProofStatusV1 {
  criterionId: string;
  requirementId: string;
  phase: CriterionProofPhase;
  kind: CriterionProofRequirementV1["kind"];
  state: "satisfied" | "required" | "blocked";
  resourceIds: string[];
}
export interface ReviseTargetProofResultV1 {
  schemaVersion: 1;
  targetId: string;
  targetRevisionId: string;
  revisionNumber: number;
  replayed: boolean;
}
