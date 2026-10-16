import type { TargetWorkspaceAssuranceFactsV1 } from "@/api/targets";
import type { TargetAttentionItemV1, TargetAvailableCommandV1, TargetWorkItemV1 } from "@paperclipai/shared";

export function attentionCommand(item: TargetAttentionItemV1, commands: TargetAvailableCommandV1[]) {
  const commandIds: Partial<Record<TargetAttentionItemV1["kind"], TargetAvailableCommandV1["id"]>> = { draft_graph: "activate_graph_revision", action_approval_required: "approve_action", action_execution_required: "execute_action", unknown_effect: "reconcile_action", awaiting_review: "record_review" };
  const commandId = commandIds[item.kind];
  // Never attach another resource's approval, permission or failure to this item.
  return commands.find((command) => command.id === commandId && item.resourceId !== null && command.resourceId === item.resourceId);
}

export function priorityWorkItem(items: TargetWorkItemV1[], attention: TargetAttentionItemV1[] = []) {
  const attentionNode = attention.find((item) => item.workNodeId && items.some((node) => node.id === item.workNodeId && node.status !== "canceled" && node.status !== "completed"));
  return items.find((node) => node.id === attentionNode?.workNodeId)
    ?? ["blocked", "running", "ready", "pending", "canceled", "completed"].flatMap((status) => items.filter((node) => node.status === status))[0];
}

export function commandReasonKey(reason: string): string | undefined {
  const reasons: Record<string, string> = {
    "Target is terminal.": "terminal",
    "A draft GraphRevision is required.": "draftGraph",
    "No ready agent task is available.": "readyNode",
    "Complete preparation work and current artifacts first.": "preparation",
    "A current Submission is required; unproven criteria remain visible for review.": "reviewSubmission",
    "Current verified criteria and an approved Review are required; Acceptance precedes external effects.": "acceptance",
    "A current Submission is required.": "submission",
    "An ActionRequest is required.": "action",
    "An approved ActionRequest and current Acceptance are required.": "approvedAction",
    "Only an unknown effect can be reconciled.": "unknownEffect",
  };
  const key = Object.hasOwn(reasons, reason) ? reasons[reason] : undefined;
  return key ? `targets.workbench.reasons.${key}` : undefined;
}

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
