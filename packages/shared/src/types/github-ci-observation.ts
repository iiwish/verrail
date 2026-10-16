/** Fixed CI observations do not establish CriterionProof or Artifact equivalence. */
export interface GithubCiObservation {
  kind: "verrail.fixed-ci-observation";
  schemaVersion: 1;
  repository: string;
  repositoryId: number;
  providerRunId: string;
  providerAttempt: number;
  workflowExecutionSha: string;
  testedCandidateSha: string;
  workflowPath: string;
  workflowSha256: string;
  helperSha256: string;
  artifactId: string;
  archiveSha256: string;
  reportSha256: string;
  verifiedAt: string;
  reference: string;
  checks: Array<{ id: "ts_tests" | "ts_typecheck" | "ts_build" | "go_tests"; status: "passed" }>;
  unsupportedObligations: Array<"live_feishu" | "live_codex" | "live_recovery" | "secret_non_persistence" | "human_governance" | "pr_effect">;
  receiptSha256: string;
}

export interface GithubCiObservationReceipt {
  schemaVersion: 1;
  workspaceId: string;
  targetId: string;
  targetRevisionId: string;
  graphRevisionId: string;
  connectionId: string;
  bindingId: string;
  policySha256: string;
  auditEventId: string;
  observation: GithubCiObservation;
}
