export const ASSURANCE_SCHEMA_VERSION = 1 as const;

export const ASSURANCE_ARTIFACT_KINDS = [
  "code_change",
  "document",
  "report",
  "external_reference",
] as const;

export const ASSURANCE_CLAIM_STATUSES = ["open", "supported", "refuted", "waived"] as const;

export const ASSURANCE_EVIDENCE_KINDS = [
  "ci_result",
  "scan_result",
  "human_review",
  "agent_observation",
  "external_reference",
] as const;

export const ASSURANCE_TRUST_LEVELS = ["high", "medium", "low"] as const;

export const ASSURANCE_VERDICTS = ["passed", "failed", "inconclusive", "waived"] as const;

export const ASSURANCE_PRINCIPAL_TYPES = ["user", "service", "agent"] as const;

export type AssuranceArtifactKind = (typeof ASSURANCE_ARTIFACT_KINDS)[number];
export type AssuranceClaimStatus = (typeof ASSURANCE_CLAIM_STATUSES)[number];
export type AssuranceEvidenceKind = (typeof ASSURANCE_EVIDENCE_KINDS)[number];
export type AssuranceTrustLevel = (typeof ASSURANCE_TRUST_LEVELS)[number];
export type AssuranceVerdict = (typeof ASSURANCE_VERDICTS)[number];
export type AssurancePrincipalType = (typeof ASSURANCE_PRINCIPAL_TYPES)[number];

export interface AssurancePrincipalV1 {
  principalType: AssurancePrincipalType;
  principalId: string;
}

export interface AssuranceArtifactRevisionV1 {
  id: string;
  artifactId: string;
  revisionNumber: number;
  contentHash: string;
  contentRef: string;
  sourceRunId: string | null;
  sourceWorkNodeId: string | null;
  baseRevisionId: string | null;
  createdBy: AssurancePrincipalV1;
  createdAt: string;
}

export interface AssuranceArtifactV1 {
  id: string;
  targetId: string;
  kind: AssuranceArtifactKind;
  title: string;
  createdBy: AssurancePrincipalV1;
  createdAt: string;
  updatedAt: string;
  revisions: AssuranceArtifactRevisionV1[];
}

export interface AssuranceClaimV1 {
  id: string;
  targetId: string;
  targetRevisionId: string;
  criterionKey: string;
  title: string;
  status: AssuranceClaimStatus;
  createdBy: AssurancePrincipalV1;
  createdAt: string;
  updatedAt: string;
}

export interface AssuranceEvidenceV1 {
  id: string;
  targetId: string;
  claimId: string | null;
  kind: AssuranceEvidenceKind;
  producer: AssurancePrincipalV1;
  objectHash: string;
  reference: string;
  trustLevel: AssuranceTrustLevel;
  recordedAt: string;
  createdBy: AssurancePrincipalV1;
  createdAt: string;
}

export interface AssuranceVerificationResultV1 {
  id: string;
  targetId: string;
  claimId: string;
  verdict: AssuranceVerdict;
  verifierVersion: string;
  evidenceIds: string[];
  waiverReference: string | null;
  resultHash: string;
  createdBy: AssurancePrincipalV1;
  createdAt: string;
}

export interface AssuranceTargetFactsV1 {
  schemaVersion: typeof ASSURANCE_SCHEMA_VERSION;
  artifacts: AssuranceArtifactV1[];
  claims: AssuranceClaimV1[];
  evidence: AssuranceEvidenceV1[];
  verificationResults: AssuranceVerificationResultV1[];
}
