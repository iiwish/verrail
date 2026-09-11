import type { TargetWorkspaceAssuranceFactsV1 } from "@/api/targets";

export const TARGET_TABS = ["overview", "delivery", "timeline"] as const;
export type TargetTab = (typeof TARGET_TABS)[number];

export function targetTab(value?: string): TargetTab {
  if (["delivery", "artifacts", "evidence", "submission", "acceptance"].includes(value ?? "")) return "delivery";
  return value === "timeline" ? "timeline" : "overview";
}

export function deliveryFacts(workspace: TargetWorkspaceAssuranceFactsV1, submissionId: string | null) {
  const submission = workspace.submissions.find((item) => item.id === submissionId) ?? null;
  const results = submission
    ? workspace.verificationResults.filter((item) => submission.verificationResultIds.includes(item.id))
    : workspace.verificationResults;
  const evidenceIds = new Set(results.flatMap((item) => item.evidenceIds));
  return {
    submission,
    artifacts: submission ? workspace.artifacts.flatMap((artifact) => {
      const revisions = artifact.revisions.filter((revision) => submission.artifactRevisionIds.includes(revision.id));
      return revisions.length ? [{ ...artifact, revisions }] : [];
    }) : workspace.artifacts,
    results,
    evidence: submission ? workspace.evidence.filter((item) => evidenceIds.has(item.id)) : workspace.evidence,
    reviews: submission ? workspace.reviews.filter((item) => item.submissionId === submission.id) : [],
    acceptances: submission ? workspace.acceptances.filter((item) => item.submissionId === submission.id) : [],
    missingArtifactIds: submission?.artifactRevisionIds.filter((id) => !workspace.artifacts.some((item) => item.revisions.some((revision) => revision.id === id))) ?? [],
    missingResultIds: submission?.verificationResultIds.filter((id) => !results.some((item) => item.id === id)) ?? [],
  };
}
