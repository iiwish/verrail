import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  verrailAcceptances,
  verrailActionApprovals,
  verrailActionRequests,
  verrailAuditEvents,
  verrailArtifactRevisions,
  verrailArtifacts,
  verrailClaims,
  verrailCollections,
  verrailDeliveryReviews,
  verrailEffectReceipts,
  verrailEvidence,
  verrailGithubRepoBindings,
  verrailGraphRevisions,
  verrailExecutionLeases,
  verrailHumanWorkResults,
  verrailIntegrationAttempts,
  verrailIntegrationRuns,
  verrailRunAttempts,
  verrailOutboxEvents,
  verrailRunEvents,
  verrailRuns,
  verrailSubmissions,
  verrailTargetRevisions,
  verrailTargets,
  verrailVerificationResults,
  verrailWorkGraphs,
  verrailWorkNodes,
  type Db,
} from "@paperclipai/db";
import {
  TARGET_READ_MODEL_POLICY_VERSION,
  TARGET_READ_MODEL_SCHEMA_VERSION,
  TARGET_WORKSPACE_SCHEMA_VERSION,
  deriveAcceptanceValidity,
  type AdjudicationAcceptanceV1,
  type AdjudicationDeliveryReviewV1,
  type AdjudicationSubmissionV1,
  type AssuranceArtifactRevisionV1,
  type AssuranceArtifactV1,
  type AssuranceClaimV1,
  type AssuranceEvidenceV1,
  type AssurancePrincipalV1,
  type AssuranceVerificationResultV1,
  type ConnectorActionRequestV1,
  type ConnectorActionApprovalSummaryV1,
  type ConnectorActionStatus,
  type ConnectorActionType,
  type ConnectorConclusion,
  type ConnectorEffectReceiptV1,
  type ConnectorIntegrationRunV1,
  type ConnectorIntegrationAttemptV1,
  type ConnectorPrincipalV1,
  type ConnectorProvider,
  type HumanWorkResultV1,
  type TargetAttentionItemV1,
  type TargetAvailableCommandV1,
  type TargetOutcomeControlV1,
  type TargetOutcomeV1,
  type TargetReadModelV1,
  type TargetResourceRefV1,
  type TargetRunV1,
  type RunOutboxFailureV1,
  type TargetStageKey,
  type TargetStageProgressV1,
  type TargetTimelineEventV1,
  type TargetWorkItemV1,
  type TargetWorkspaceV1,
} from "@paperclipai/shared";

const STAGES = ["define", "execute", "verify", "accept"] as const;
const STAGE_LABELS: Record<(typeof STAGES)[number], string> = {
  define: "Define",
  execute: "Execute",
  verify: "Verify",
  accept: "Accept",
};

type NativeTargetRow = {
  target: typeof verrailTargets.$inferSelect;
  revision: typeof verrailTargetRevisions.$inferSelect;
  collection: typeof verrailCollections.$inferSelect | null;
};

function asIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function resourceRefs(value: Array<Record<string, unknown>>): TargetResourceRefV1[] {
  return value.flatMap((entry) => {
    if (typeof entry.kind !== "string" || typeof entry.id !== "string") return [];
    return [{
      kind: entry.kind,
      id: entry.id,
      label: typeof entry.label === "string" ? entry.label : null,
    }];
  });
}

function stageProgress(nodes: TargetWorkItemV1[]): TargetStageProgressV1[] {
  let currentAssigned = false;
  return STAGES.map((key) => {
    const stageNodes = nodes.filter((node) => node.stage === key);
    let state: TargetStageProgressV1["state"];
    if (stageNodes.some((node) => node.status === "blocked")) {
      state = "blocked";
      currentAssigned = true;
    } else if (stageNodes.length > 0 && stageNodes.every((node) => node.status === "completed")) {
      state = "completed";
    } else if (!currentAssigned && (
      stageNodes.some((node) => ["ready", "running"].includes(node.status))
      || (key === "define" && nodes.length === 0)
    )) {
      state = "current";
      currentAssigned = true;
    } else {
      state = "pending";
    }
    return { key, label: STAGE_LABELS[key], state };
  });
}

function currentStage(stages: TargetStageProgressV1[]): { key: TargetStageKey; label: string } | null {
  const stage = stages.find((item) => item.state === "current" || item.state === "blocked");
  return stage ? { key: stage.key, label: stage.label } : null;
}

function mapWorkNode(row: typeof verrailWorkNodes.$inferSelect): TargetWorkItemV1 {
  return {
    id: row.id,
    nodeKey: row.nodeKey,
    graphRevisionId: row.graphRevisionId,
    kind: row.kind as TargetWorkItemV1["kind"],
    stage: row.stageKey as TargetWorkItemV1["stage"],
    status: row.status as TargetWorkItemV1["status"],
    title: row.title,
    responsiblePrincipal: row.responsiblePrincipalType && row.responsiblePrincipalId
      ? {
          principalType: row.responsiblePrincipalType as "user" | "agent" | "service",
          principalId: row.responsiblePrincipalId,
        }
      : null,
    dependencyNodeKeys: row.dependencyNodeKeys,
    completionDefinition: row.completionDefinition || null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

type ExecutionFacts = {
  attempts: Array<typeof verrailRunAttempts.$inferSelect>;
  leases: Array<typeof verrailExecutionLeases.$inferSelect>;
  events: Array<typeof verrailRunEvents.$inferSelect>;
};

export type TargetWorkspaceAssuranceFactsV1 = Omit<TargetWorkspaceV1, "artifacts" | "evidence" | "submissions"> & {
  submissions: AdjudicationSubmissionV1[];
  reviews: AdjudicationDeliveryReviewV1[];
  acceptances: AdjudicationAcceptanceV1[];
  artifacts: AssuranceArtifactV1[];
  claims: AssuranceClaimV1[];
  evidence: AssuranceEvidenceV1[];
  verificationResults: AssuranceVerificationResultV1[];
  integrationRuns: ConnectorIntegrationRunV1[];
  humanWorkResults: HumanWorkResultV1[];
  actionRequests: ConnectorActionRequestV1[];
  effectReceipts: ConnectorEffectReceiptV1[];
  workspaceBinding: { repoOwner: string; repoName: string } | null;
};

type AssuranceFacts = {
  artifacts: Array<typeof verrailArtifacts.$inferSelect>;
  artifactRevisions: Array<typeof verrailArtifactRevisions.$inferSelect>;
  claims: Array<typeof verrailClaims.$inferSelect>;
  evidence: Array<typeof verrailEvidence.$inferSelect>;
  verificationResults: Array<typeof verrailVerificationResults.$inferSelect>;
  submissions: Array<typeof verrailSubmissions.$inferSelect>;
  deliveryReviews: Array<typeof verrailDeliveryReviews.$inferSelect>;
  acceptances: Array<typeof verrailAcceptances.$inferSelect>;
  integrationRuns: Array<typeof verrailIntegrationRuns.$inferSelect>;
  integrationAttempts: Array<typeof verrailIntegrationAttempts.$inferSelect>;
  humanWorkResults: Array<typeof verrailHumanWorkResults.$inferSelect>;
  actionRequests: Array<typeof verrailActionRequests.$inferSelect>;
  actionApprovals: Array<typeof verrailActionApprovals.$inferSelect>;
  effectReceipts: Array<typeof verrailEffectReceipts.$inferSelect>;
  githubRepoBindings: Array<typeof verrailGithubRepoBindings.$inferSelect>;
};

type NativeFacts = AssuranceFacts & {
  graphs: Array<typeof verrailWorkGraphs.$inferSelect>;
  graphRevisions: Array<typeof verrailGraphRevisions.$inferSelect>;
  nodes: Array<typeof verrailWorkNodes.$inferSelect>;
  runs: Array<typeof verrailRuns.$inferSelect>;
  attempts: Array<typeof verrailRunAttempts.$inferSelect>;
  leases: Array<typeof verrailExecutionLeases.$inferSelect>;
  events: Array<typeof verrailRunEvents.$inferSelect>;
};

const EMPTY_ASSURANCE_FACTS: AssuranceFacts = {
  artifacts: [],
  artifactRevisions: [],
  claims: [],
  evidence: [],
  verificationResults: [],
  submissions: [],
  deliveryReviews: [],
  acceptances: [],
  integrationRuns: [],
  integrationAttempts: [],
  humanWorkResults: [],
  actionRequests: [],
  actionApprovals: [],
  effectReceipts: [],
  githubRepoBindings: [],
};

function byCreatedAtAsc(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
) {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

// Newest-first on (created_at desc, id desc) — mirrors the Go "latest
// submission" ordering used by deriveAcceptanceValidity.
function byCreatedAtDesc(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
) {
  return right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id);
}

function assurancePrincipal(principalType: string, principalId: string): AssurancePrincipalV1 {
  return { principalType: principalType as AssurancePrincipalV1["principalType"], principalId };
}

function mapArtifact(row: typeof verrailArtifacts.$inferSelect, revisions: AssuranceFacts["artifactRevisions"]): AssuranceArtifactV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    kind: row.kind as AssuranceArtifactV1["kind"],
    title: row.title,
    createdBy: assurancePrincipal(row.createdByPrincipalType, row.createdByPrincipalId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revisions: revisions
      .filter((revision) => revision.artifactId === row.id)
      .sort((left, right) => left.revisionNumber - right.revisionNumber || left.id.localeCompare(right.id))
      .map((revision): AssuranceArtifactRevisionV1 => ({
        id: revision.id,
        artifactId: revision.artifactId,
        revisionNumber: revision.revisionNumber,
        contentHash: revision.contentHash,
        contentRef: revision.contentRef,
        sourceRunId: revision.sourceRunId,
        sourceWorkNodeId: revision.sourceWorkNodeId,
        baseRevisionId: revision.baseRevisionId,
        createdBy: assurancePrincipal(revision.createdByPrincipalType, revision.createdByPrincipalId),
        createdAt: revision.createdAt.toISOString(),
      })),
  };
}

function mapClaim(row: typeof verrailClaims.$inferSelect): AssuranceClaimV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    targetRevisionId: row.targetRevisionId,
    criterionKey: row.criterionKey,
    title: row.title,
    status: row.status as AssuranceClaimV1["status"],
    createdBy: assurancePrincipal(row.createdByPrincipalType, row.createdByPrincipalId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapEvidence(row: typeof verrailEvidence.$inferSelect): AssuranceEvidenceV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    claimId: row.claimId,
    kind: row.kind as AssuranceEvidenceV1["kind"],
    producer: assurancePrincipal(row.producerPrincipalType, row.producerPrincipalId),
    objectHash: row.objectHash,
    reference: row.reference,
    trustLevel: row.trustLevel as AssuranceEvidenceV1["trustLevel"],
    recordedAt: row.recordedAt.toISOString(),
    createdBy: assurancePrincipal(row.createdByPrincipalType, row.createdByPrincipalId),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapVerificationResult(row: typeof verrailVerificationResults.$inferSelect): AssuranceVerificationResultV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    claimId: row.claimId,
    verdict: row.verdict as AssuranceVerificationResultV1["verdict"],
    verifierVersion: row.verifierVersion,
    evidenceIds: row.evidenceIds,
    waiverReference: row.waiverReference,
    resultHash: row.resultHash,
    createdBy: assurancePrincipal(row.createdByPrincipalType, row.createdByPrincipalId),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapSubmission(row: typeof verrailSubmissions.$inferSelect): AdjudicationSubmissionV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    targetRevisionId: row.targetRevisionId,
    artifactRevisionIds: row.artifactRevisionIds,
    verificationResultIds: row.verificationResultIds,
    commitRef: row.commitRef,
    environmentSummary: row.environmentSummary,
    notes: row.notes,
    submissionHash: row.submissionHash,
    submittedBy: assurancePrincipal(row.submittedByPrincipalType, row.submittedByPrincipalId),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapDeliveryReview(row: typeof verrailDeliveryReviews.$inferSelect): AdjudicationDeliveryReviewV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    submissionId: row.submissionId,
    verdict: row.verdict as AdjudicationDeliveryReviewV1["verdict"],
    risks: row.risks,
    unprovenItems: row.unprovenItems,
    comments: row.comments,
    reviewHash: row.reviewHash,
    reviewer: assurancePrincipal(row.reviewerPrincipalType, row.reviewerPrincipalId),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapAcceptance(row: typeof verrailAcceptances.$inferSelect, latestSubmissionId: string | null, activeTargetRevisionId: string): AdjudicationAcceptanceV1 {
  const derived = deriveAcceptanceValidity(row.submissionId === latestSubmissionId, row.targetRevisionId === activeTargetRevisionId);
  return {
    id: row.id,
    targetId: row.targetId,
    targetRevisionId: row.targetRevisionId,
    submissionId: row.submissionId,
    reviewId: row.reviewId,
    authority: row.authority as AdjudicationAcceptanceV1["authority"],
    acceptedBy: assurancePrincipal(row.acceptedByPrincipalType, row.acceptedByPrincipalId),
    acceptanceHash: row.acceptanceHash,
    createdAt: row.createdAt.toISOString(),
    validity: derived.validity,
    invalidReason: derived.invalidReason,
  };
}

function connectorPrincipal(principalType: string, principalId: string): ConnectorPrincipalV1 {
  return { principalType, principalId };
}

function mapIntegrationAttempt(row: typeof verrailIntegrationAttempts.$inferSelect): ConnectorIntegrationAttemptV1 {
  return {
    id: row.id,
    integrationRunId: row.integrationRunId,
    attemptNumber: row.attemptNumber,
    connectorVersion: row.connectorVersion,
    connectionId: row.connectionId,
    providerRef: row.providerRef,
    idempotencyKey: row.idempotencyKey,
    providerReceipt: row.providerReceipt,
    status: row.status as ConnectorIntegrationAttemptV1["status"],
    createdAt: row.createdAt.toISOString(),
  };
}

function mapIntegrationRun(
  row: typeof verrailIntegrationRuns.$inferSelect,
  attempts: AssuranceFacts["integrationAttempts"],
): ConnectorIntegrationRunV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    targetRevisionId: row.targetRevisionId,
    graphRevisionId: row.graphRevisionId,
    claimId: row.claimId,
    workNodeId: row.workNodeId,
    connectorVersion: row.connectorVersion,
    connectionId: row.connectionId,
    provider: row.provider as ConnectorProvider,
    externalRef: row.externalRef,
    commitRef: row.commitRef,
    criterionKey: row.criterionKey,
    environmentRef: row.environmentRef,
    conclusion: row.conclusion as ConnectorConclusion,
    evidenceId: row.evidenceId,
    verificationResultId: row.verificationResultId,
    providerReceipt: row.providerReceipt,
    attempts: attempts
      .filter((attempt) => attempt.integrationRunId === row.id)
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
      .map(mapIntegrationAttempt),
    createdBy: connectorPrincipal(row.createdByPrincipalType, row.createdByPrincipalId),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapHumanWorkResult(row: typeof verrailHumanWorkResults.$inferSelect): HumanWorkResultV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    targetRevisionId: row.targetRevisionId,
    graphRevisionId: row.graphRevisionId,
    workNodeId: row.workNodeId,
    submittedBy: connectorPrincipal(row.submittedByPrincipalType, row.submittedByPrincipalId),
    inputHash: row.inputHash,
    result: row.result,
    artifactRevisionId: row.artifactRevisionId,
    attachmentHashes: row.attachmentHashes,
    resultHash: row.resultHash,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapActionRequest(row: typeof verrailActionRequests.$inferSelect, facts: AssuranceFacts): ConnectorActionRequestV1 {
  const approvals = facts.actionApprovals
    .filter((approval) => approval.actionRequestId === row.id)
    .sort((left, right) => byCreatedAtAsc(left, right));
  const latestApproval = approvals[approvals.length - 1] ?? null;
  const executedReceipt = facts.effectReceipts.find((receipt) => receipt.actionRequestId === row.id) ?? null;
  const approvalSummary: ConnectorActionApprovalSummaryV1 = {
    count: approvals.length,
    latest: latestApproval
      ? {
          id: latestApproval.id,
          approvedBy: connectorPrincipal(latestApproval.approvedByPrincipalType, latestApproval.approvedByPrincipalId),
          paramsHash: latestApproval.paramsHash,
          createdAt: latestApproval.createdAt.toISOString(),
        }
      : null,
  };
  return {
    id: row.id,
    targetId: row.targetId,
    submissionId: row.submissionId,
    actionType: row.actionType as ConnectorActionType,
    params: { title: row.params.title, head: row.params.head, base: row.params.base, body: row.params.body ?? "" },
    paramsHash: row.paramsHash,
    expectedCommitRef: row.expectedCommitRef,
    status: row.status as ConnectorActionStatus,
    providerMarker: row.providerMarker,
    executionAttemptCount: row.executionAttemptCount,
    executionStartedAt: row.executionStartedAt?.toISOString() ?? null,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    requestedBy: connectorPrincipal(row.requestedByPrincipalType, row.requestedByPrincipalId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    approvals: approvalSummary,
    executedReceipt: executedReceipt
      ? {
          id: executedReceipt.id,
          effectHash: executedReceipt.effectHash,
          externalObjectId: executedReceipt.externalObjectId,
          externalUrl: executedReceipt.externalUrl,
          createdAt: executedReceipt.createdAt.toISOString(),
        }
      : null,
  };
}

function mapEffectReceipt(row: typeof verrailEffectReceipts.$inferSelect): ConnectorEffectReceiptV1 {
  return {
    id: row.id,
    targetId: row.targetId,
    actionRequestId: row.actionRequestId,
    actionType: row.actionType as ConnectorActionType,
    provider: row.provider as ConnectorProvider,
    providerMarker: row.providerMarker,
    externalObjectId: row.externalObjectId,
    externalUrl: row.externalUrl,
    effectHash: row.effectHash,
    payload: row.payload,
    createdBy: connectorPrincipal(row.createdByPrincipalType, row.createdByPrincipalId),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapRun(row: typeof verrailRuns.$inferSelect, facts: ExecutionFacts): TargetRunV1 {
  const attempts = facts.attempts
    .filter((attempt) => attempt.runId === row.id)
    .sort((left, right) => left.attemptNumber - right.attemptNumber)
    .map((attempt) => {
      const lease = facts.leases.find((candidate) => candidate.runAttemptId === attempt.id) ?? null;
      const events = facts.events
        .filter((event) => event.runAttemptId === attempt.id)
        .sort((left, right) => left.cursor - right.cursor)
        .map((event) => ({
          id: event.id,
          runAttemptId: event.runAttemptId,
          cursor: event.cursor,
          fencingToken: event.fencingToken,
          eventType: event.eventType as TargetRunV1["attempts"][number]["events"][number]["eventType"],
          payload: event.payload,
          emittedAt: event.emittedAt.toISOString(),
          receivedAt: event.receivedAt.toISOString(),
        }));
      return {
        id: attempt.id,
        runId: attempt.runId,
        attemptNumber: attempt.attemptNumber,
        deploymentRevisionId: attempt.deploymentRevisionId,
        agentVersionId: attempt.agentVersionId,
        runtimeProfile: attempt.runtimeProfile as "host_trusted",
        executor: { principalType: "service" as const, principalId: attempt.executorPrincipalId },
        fencingToken: attempt.fencingToken,
        status: attempt.status as TargetRunV1["attempts"][number]["status"],
        lastEventCursor: attempt.lastEventCursor,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
        result: attempt.result,
        lease: lease ? {
          id: lease.id,
          runAttemptId: lease.runAttemptId,
          executorPrincipalId: lease.executorPrincipalId,
          runtimeProfile: lease.runtimeProfile as "host_trusted",
          fencingToken: lease.fencingToken,
          status: lease.status as NonNullable<TargetRunV1["attempts"][number]["lease"]>["status"],
          expiresAt: lease.expiresAt.toISOString(),
          graceExpiresAt: lease.graceExpiresAt.toISOString(),
          claimedAt: asIso(lease.claimedAt),
          lastHeartbeatAt: asIso(lease.lastHeartbeatAt),
          releasedAt: asIso(lease.releasedAt),
        } : null,
        events,
        startedAt: asIso(attempt.startedAt),
        finishedAt: asIso(attempt.finishedAt),
        createdAt: attempt.createdAt.toISOString(),
        updatedAt: attempt.updatedAt.toISOString(),
      };
    });
  return {
    id: row.id,
    kind: row.kind === "integration" ? "integration_run" : "agent_run",
    targetRevisionId: row.targetRevisionId,
    graphRevisionId: row.graphRevisionId,
    workNodeId: row.workNodeId,
    status: row.status as TargetRunV1["status"],
    actor: {
      principalType: row.actorPrincipalType as "agent" | "service",
      principalId: row.actorPrincipalId,
    },
    deploymentRevisionId: row.deploymentRevisionId,
    agentVersionId: row.agentVersionId,
    attempt: Math.max(0, row.attemptCount),
    cancelRequestedAt: asIso(row.cancelRequestedAt),
    attempts,
    startedAt: asIso(row.startedAt),
    finishedAt: asIso(row.finishedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

type ProjectionInput = {
  targetId: string;
  activeTargetRevisionId: string;
  createdAt: string;
  activityAt: string;
  persistedStatus: string;
  outcomeOwner: { principalType: string; principalId: string };
  criteria: Array<{ id: string }>;
  graph: typeof verrailWorkGraphs.$inferSelect | null;
  nodes: TargetWorkItemV1[];
  runs: TargetRunV1[];
  facts: NativeFacts;
};

function targetActivityAt(
  targetId: string,
  facts: NativeFacts,
  fallback: Date,
) {
  const artifactIds = new Set(facts.artifacts.filter((row) => row.targetId === targetId).map((row) => row.id));
  const dates: Date[] = [fallback];
  const add = (rows: Array<Record<string, unknown>>, keys: string[]) => {
    for (const row of rows) {
      for (const key of keys) {
        const value = row[key];
        if (value instanceof Date) dates.push(value);
      }
    }
  };
  add(facts.graphs.filter((row) => row.targetId === targetId), ["createdAt", "updatedAt"]);
  add(facts.graphRevisions.filter((row) => row.targetId === targetId), ["createdAt", "activatedAt"]);
  add(facts.nodes.filter((row) => row.targetId === targetId), ["createdAt", "updatedAt"]);
  add(facts.runs.filter((row) => row.targetId === targetId), ["createdAt", "updatedAt", "startedAt", "finishedAt"]);
  add(facts.artifacts.filter((row) => row.targetId === targetId), ["createdAt", "updatedAt"]);
  add(facts.artifactRevisions.filter((row) => artifactIds.has(row.artifactId)), ["createdAt"]);
  add(facts.claims.filter((row) => row.targetId === targetId), ["createdAt", "updatedAt"]);
  add(facts.evidence.filter((row) => row.targetId === targetId), ["createdAt", "recordedAt"]);
  add(facts.verificationResults.filter((row) => row.targetId === targetId), ["createdAt"]);
  add(facts.submissions.filter((row) => row.targetId === targetId), ["createdAt"]);
  add(facts.deliveryReviews.filter((row) => row.targetId === targetId), ["createdAt"]);
  add(facts.acceptances.filter((row) => row.targetId === targetId), ["createdAt"]);
  add(facts.integrationRuns.filter((row) => row.targetId === targetId), ["createdAt"]);
  add(facts.humanWorkResults.filter((row) => row.targetId === targetId), ["createdAt"]);
  add(facts.actionRequests.filter((row) => row.targetId === targetId), ["createdAt", "updatedAt"]);
  add(facts.effectReceipts.filter((row) => row.targetId === targetId), ["createdAt"]);
  return new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString();
}

type TargetProjection = {
  status: TargetReadModelV1["status"];
  outcome: TargetOutcomeV1;
  attention: TargetAttentionItemV1[];
  availableCommands: TargetAvailableCommandV1[];
};

function control(
  key: TargetOutcomeControlV1["key"],
  state: TargetOutcomeControlV1["state"],
  reason: string | null,
  resourceId: string | null = null,
): TargetOutcomeControlV1 {
  return { key, state, reason, resourceId };
}

function deriveTargetProjection(input: ProjectionInput): TargetProjection {
  const targetFacts = {
    artifacts: input.facts.artifacts.filter((row) => row.targetId === input.targetId),
    claims: input.facts.claims.filter((row) => row.targetId === input.targetId),
    verificationResults: input.facts.verificationResults.filter((row) => row.targetId === input.targetId),
    submissions: input.facts.submissions.filter((row) => row.targetId === input.targetId).sort(byCreatedAtDesc),
    reviews: input.facts.deliveryReviews.filter((row) => row.targetId === input.targetId).sort(byCreatedAtDesc),
    acceptances: input.facts.acceptances.filter((row) => row.targetId === input.targetId).sort(byCreatedAtDesc),
    actions: input.facts.actionRequests.filter((row) => row.targetId === input.targetId).sort(byCreatedAtDesc),
    receipts: input.facts.effectReceipts.filter((row) => row.targetId === input.targetId).sort(byCreatedAtDesc),
  };
  const latestSubmission = targetFacts.submissions[0] ?? null;
  const latestReview = latestSubmission
    ? targetFacts.reviews.filter((row) => row.submissionId === latestSubmission.id).sort(byCreatedAtDesc)[0] ?? null
    : null;
  const submissionActions = latestSubmission
    ? targetFacts.actions.filter((row) => row.submissionId === latestSubmission.id)
    : [];
  const receiptByActionId = new Map(targetFacts.receipts.map((row) => [row.actionRequestId, row]));

  const latestArtifactRevisionIds = new Set<string>();
  for (const artifact of targetFacts.artifacts) {
    const latest = input.facts.artifactRevisions
      .filter((row) => row.artifactId === artifact.id)
      .sort((left, right) => right.revisionNumber - left.revisionNumber || right.id.localeCompare(left.id))[0];
    if (latest) latestArtifactRevisionIds.add(latest.id);
  }
  const submittedArtifactRevisionIds = new Set(latestSubmission?.artifactRevisionIds ?? []);
  const artifactsCurrent = Boolean(latestSubmission)
    && latestArtifactRevisionIds.size > 0
    && submittedArtifactRevisionIds.size === latestArtifactRevisionIds.size
    && [...latestArtifactRevisionIds].every((id) => submittedArtifactRevisionIds.has(id));

  const activeClaims = targetFacts.claims.filter((row) => row.targetRevisionId === input.activeTargetRevisionId);
  const submittedVerificationIds = new Set(latestSubmission?.verificationResultIds ?? []);
  const criterionResults = new Map<string, typeof verrailVerificationResults.$inferSelect>();
  for (const criterion of input.criteria) {
    const claimIds = new Set(activeClaims.filter((claim) => claim.criterionKey === criterion.id).map((claim) => claim.id));
    const latest = targetFacts.verificationResults
      .filter((result) => claimIds.has(result.claimId))
      .sort(byCreatedAtDesc)[0];
    if (latest) criterionResults.set(criterion.id, latest);
  }
  const criteriaVerifiedBeforeSubmission = input.criteria.length > 0
    && input.criteria.every((criterion) => criterionResults.get(criterion.id)?.verdict === "passed");
  const criteriaVerified = criteriaVerifiedBeforeSubmission
    && Boolean(latestSubmission)
    && [...criterionResults.values()].every((result) => submittedVerificationIds.has(result.id));
  const failedResults = [...criterionResults.values()].filter((result) => result.verdict === "failed");
  const inconclusiveResults = [...criterionResults.values()].filter((result) => result.verdict === "inconclusive");

  const graphComplete = Boolean(input.graph?.activeGraphRevisionId)
    && input.nodes.length > 0
    && input.nodes.every((node) => node.status === "completed");
  const hasBlockedWork = input.nodes.some((node) => node.status === "blocked")
    || input.runs.some((run) => run.status === "failed");
  const submissionCurrent = Boolean(latestSubmission)
    && latestSubmission?.targetRevisionId === input.activeTargetRevisionId;
  const reviewApproved = Boolean(latestReview) && latestReview?.verdict === "approved";
  const storedAcceptance = latestSubmission
    ? targetFacts.acceptances.find((row) => row.submissionId === latestSubmission.id) ?? null
    : null;
  const supersededAcceptance = targetFacts.acceptances.find((row) => row.submissionId !== latestSubmission?.id) ?? null;
  const acceptanceMatches = Boolean(storedAcceptance)
    && storedAcceptance?.targetRevisionId === input.activeTargetRevisionId
    && storedAcceptance?.reviewId === latestReview?.id
    && storedAcceptance?.authority === "outcome_owner"
    && storedAcceptance?.acceptedByPrincipalType === "user"
    && input.outcomeOwner.principalType === "user"
    && storedAcceptance?.acceptedByPrincipalId === input.outcomeOwner.principalId;
  const unknownEffect = submissionActions.find((row) => row.status === "unknown_effect") ?? null;
  const unsettledAction = submissionActions.find((row) => row.status !== "executed" || !receiptByActionId.has(row.id)) ?? null;
  const effectsSettled = submissionActions.length === 0 || !unsettledAction;
  const closureInputsValid = graphComplete
    && submissionCurrent
    && artifactsCurrent
    && criteriaVerified
    && reviewApproved
    && effectsSettled
    && !unknownEffect;
  const validAcceptance = closureInputsValid && acceptanceMatches ? storedAcceptance : null;

  const controls: TargetOutcomeControlV1[] = [
    control(
      "graph_complete",
      graphComplete ? "satisfied" : hasBlockedWork ? "blocked" : "required",
      graphComplete ? null : hasBlockedWork ? "Active graph execution is blocked or failed." : "Every active graph node must complete.",
      input.graph?.activeGraphRevisionId ?? null,
    ),
    control(
      "latest_submission",
      !latestSubmission ? "required" : submissionCurrent ? "satisfied" : "invalidated",
      !latestSubmission ? "A Submission is required." : submissionCurrent ? null : "The latest Submission targets a superseded TargetRevision.",
      latestSubmission?.id ?? null,
    ),
    control(
      "artifact_revisions_current",
      !latestSubmission ? "required" : artifactsCurrent ? "satisfied" : "invalidated",
      !latestSubmission ? "Submit the latest revision of every Target artifact." : artifactsCurrent ? null : "Submitted artifact revisions are incomplete or superseded.",
      latestSubmission?.id ?? null,
    ),
    control(
      "criteria_verified",
      criteriaVerified ? "satisfied" : failedResults.length > 0 ? "blocked" : latestSubmission && criteriaVerifiedBeforeSubmission ? "invalidated" : "required",
      criteriaVerified ? null : failedResults.length > 0 ? "At least one current acceptance criterion failed verification." : latestSubmission && criteriaVerifiedBeforeSubmission ? "The latest Submission does not bind every current passing VerificationResult." : "Every current acceptance criterion needs a passing VerificationResult.",
      failedResults[0]?.id ?? null,
    ),
    control(
      "review_approved",
      !latestSubmission ? "not_applicable" : !latestReview ? "required" : reviewApproved ? "satisfied" : "blocked",
      !latestSubmission ? null : !latestReview ? "The latest Submission needs an independent DeliveryReview." : reviewApproved ? null : `The latest DeliveryReview is ${latestReview.verdict}.`,
      latestReview?.id ?? null,
    ),
    control(
      "acceptance_valid",
      validAcceptance ? "satisfied" : storedAcceptance || supersededAcceptance ? "invalidated" : reviewApproved ? "required" : "not_applicable",
      validAcceptance ? null : storedAcceptance || supersededAcceptance ? "A recorded Acceptance no longer matches the latest current closure facts." : reviewApproved ? "The outcome owner must accept the approved Submission." : null,
      storedAcceptance?.id ?? supersededAcceptance?.id ?? null,
    ),
    control(
      "external_effects_settled",
      submissionActions.length === 0 ? "not_applicable" : unknownEffect ? "blocked" : effectsSettled ? "satisfied" : "required",
      submissionActions.length === 0 ? null : unknownEffect ? "An external effect is unknown and must be reconciled." : effectsSettled ? null : "Approved external actions must produce immutable EffectReceipts.",
      (unknownEffect ?? unsettledAction)?.id ?? null,
    ),
  ];

  const canceled = input.persistedStatus === "canceled" || input.graph?.status === "canceled";
  const invalidated = controls.some((item) => item.state === "invalidated");
  const blocked = hasBlockedWork || failedResults.length > 0 || unknownEffect != null
    || latestReview?.verdict === "rejected" || latestReview?.verdict === "changes_requested" || invalidated;
  let status: TargetReadModelV1["status"];
  if (canceled) status = "canceled";
  else if (validAcceptance) status = "accepted";
  else if (blocked) status = "blocked";
  else if (!input.graph?.activeGraphRevisionId) status = "draft";
  else if (!graphComplete) {
    const started = input.nodes.some((node) => node.status === "running" || node.status === "completed") || input.runs.length > 0;
    status = started ? "active" : "ready";
  } else if (reviewApproved) status = "awaiting_acceptance";
  else status = "verifying";

  const items: TargetAttentionItemV1[] = [];
  if (!input.graph?.activeGraphRevisionId) {
    items.push({
      id: `draft-graph:${input.targetId}`,
      severity: "info",
      kind: "draft_graph",
      title: "Work graph needs activation",
      detail: "Define and activate a native graph revision before execution can start.",
      workNodeId: null,
      runId: null,
      resourceType: "target",
      resourceId: input.targetId,
      createdAt: input.createdAt,
    });
  }
  for (const node of input.nodes.filter((item) => item.status === "blocked")) {
    items.push({
      id: `blocked-node:${node.id}`,
      severity: "warning",
      kind: "blocked_node",
      title: `${node.title} is blocked`,
      detail: node.completionDefinition,
      workNodeId: node.id,
      runId: null,
      resourceType: null,
      resourceId: null,
      createdAt: node.updatedAt,
    });
  }
  for (const run of input.runs.filter((item) => item.status === "failed")) {
    items.push({
      id: `failed-run:${run.id}`,
      severity: "critical",
      kind: "failed_run",
      title: "A native run failed",
      detail: null,
      workNodeId: run.workNodeId,
      runId: run.id,
      resourceType: null,
      resourceId: null,
      createdAt: run.finishedAt ?? run.createdAt,
    });
  }
  for (const result of failedResults) {
    items.push({ id: `verification-failed:${result.id}`, severity: "critical", kind: "verification_failed", title: "A current acceptance criterion failed", detail: null, workNodeId: null, runId: null, resourceType: "verification_result", resourceId: result.id, createdAt: result.createdAt.toISOString() });
  }
  for (const result of inconclusiveResults) {
    items.push({ id: `verification-inconclusive:${result.id}`, severity: "warning", kind: "verification_inconclusive", title: "A current acceptance criterion is inconclusive", detail: null, workNodeId: null, runId: null, resourceType: "verification_result", resourceId: result.id, createdAt: result.createdAt.toISOString() });
  }
  if (graphComplete && !criteriaVerifiedBeforeSubmission && failedResults.length === 0 && inconclusiveResults.length === 0) {
    items.push({ id: `missing-evidence:${input.activeTargetRevisionId}`, severity: "warning", kind: "missing_evidence", title: "Current acceptance criteria need evidence", detail: "Record passing VerificationResults for every criterion before submission.", workNodeId: null, runId: null, resourceType: "target", resourceId: input.targetId, createdAt: input.createdAt });
  }
  if (latestSubmission && submissionCurrent && artifactsCurrent && criteriaVerified && !latestReview) {
    items.push({ id: `awaiting-review:${latestSubmission.id}`, severity: "warning", kind: "awaiting_review", title: "The latest Submission needs review", detail: null, workNodeId: null, runId: null, resourceType: "submission", resourceId: latestSubmission.id, createdAt: latestSubmission.createdAt.toISOString() });
  }
  if (status === "awaiting_acceptance") {
    items.push({
      id: `awaiting-acceptance:${input.targetId}`,
      severity: "warning",
      kind: "awaiting_acceptance",
      title: "Human acceptance is required",
      detail: null,
      workNodeId: null,
      runId: null,
      resourceType: latestReview ? "review" : "target",
      resourceId: latestReview?.id ?? input.targetId,
      createdAt: latestReview?.createdAt.toISOString() ?? input.createdAt,
    });
  }
  for (const action of submissionActions) {
    if (action.status === "pending_approval") items.push({ id: `action-approval:${action.id}`, severity: "warning", kind: "action_approval_required", title: "An external action needs human approval", detail: action.actionType, workNodeId: null, runId: null, resourceType: "action_request", resourceId: action.id, createdAt: action.createdAt.toISOString() });
    if (action.status === "approved" || action.status === "executing") items.push({ id: `action-execution:${action.id}`, severity: "warning", kind: "action_execution_required", title: "An approved external action needs execution", detail: action.actionType, workNodeId: null, runId: null, resourceType: "action_request", resourceId: action.id, createdAt: action.updatedAt.toISOString() });
    if (action.status === "unknown_effect") items.push({ id: `unknown-effect:${action.id}`, severity: "critical", kind: "unknown_effect", title: "External effect outcome is unknown", detail: "Reconcile the provider marker before any retry.", workNodeId: null, runId: null, resourceType: "action_request", resourceId: action.id, createdAt: action.updatedAt.toISOString() });
  }
  if (invalidated) {
    const stale = controls.find((item) => item.state === "invalidated")!;
    items.push({ id: `invalidated:${latestSubmission?.id ?? input.activeTargetRevisionId}:${stale.key}`, severity: "critical", kind: "invalidated_decision", title: "A previous delivery decision is stale", detail: stale.reason, workNodeId: null, runId: null, resourceType: storedAcceptance || supersededAcceptance ? "acceptance" : latestSubmission ? "submission" : "target", resourceId: storedAcceptance?.id ?? supersededAcceptance?.id ?? latestSubmission?.id ?? input.targetId, createdAt: input.activityAt });
  }

  const action = submissionActions[0] ?? null;
  const draftGraphRevisionId = input.facts.graphRevisions
      .filter((row) => row.targetId === input.targetId
        && row.targetRevisionId === input.activeTargetRevisionId
        && row.status === "draft"
        && input.facts.nodes.some((node) => node.graphRevisionId === row.id))
      .sort((left, right) => right.revisionNumber - left.revisionNumber || right.id.localeCompare(left.id))[0]?.id
    ?? null;
  const commands: TargetAvailableCommandV1[] = [
    { id: "create_graph_revision", state: canceled || status === "accepted" ? "blocked" : "available", reason: canceled || status === "accepted" ? "Target is terminal." : null, resourceId: input.graph?.id ?? null },
    { id: "activate_graph_revision", state: draftGraphRevisionId ? "available" : input.graph?.activeGraphRevisionId ? "completed" : "blocked", reason: draftGraphRevisionId || input.graph?.activeGraphRevisionId ? null : "A draft GraphRevision is required.", resourceId: draftGraphRevisionId ?? input.graph?.activeGraphRevisionId ?? null },
    { id: "create_run", state: input.nodes.some((node) => node.status === "ready" && node.kind === "agent_task") ? "available" : graphComplete ? "completed" : "blocked", reason: graphComplete ? null : "No ready agent task is available.", resourceId: input.nodes.find((node) => node.status === "ready" && node.kind === "agent_task")?.id ?? null },
    { id: "create_submission", state: latestSubmission && submissionCurrent && artifactsCurrent && criteriaVerified ? "completed" : graphComplete && criteriaVerifiedBeforeSubmission && latestArtifactRevisionIds.size > 0 ? "available" : "blocked", reason: graphComplete && criteriaVerifiedBeforeSubmission && latestArtifactRevisionIds.size > 0 ? null : "Complete work, current artifacts, and criterion verification first.", resourceId: latestSubmission?.id ?? null },
    { id: "record_review", state: reviewApproved ? "completed" : latestSubmission && submissionCurrent && artifactsCurrent && criteriaVerified ? "available" : "blocked", reason: latestSubmission && submissionCurrent && artifactsCurrent && criteriaVerified ? null : "A current complete Submission is required.", resourceId: latestSubmission?.id ?? null },
    { id: "accept_submission", state: validAcceptance ? "completed" : reviewApproved && closureInputsValid ? "available" : "blocked", reason: reviewApproved && closureInputsValid ? null : "A current approved Review and settled controls are required.", resourceId: latestReview?.id ?? null },
    { id: "request_pull_request", state: action ? "completed" : latestSubmission && submissionCurrent ? "available" : "blocked", reason: latestSubmission && submissionCurrent ? null : "A current Submission is required.", resourceId: latestSubmission?.id ?? null },
    { id: "approve_action", state: action?.status === "pending_approval" ? "available" : action ? "completed" : "blocked", reason: action ? null : "An ActionRequest is required.", resourceId: action?.id ?? null },
    { id: "execute_action", state: action?.status === "approved" ? "available" : action?.status === "executed" ? "completed" : "blocked", reason: action?.status === "approved" ? null : "An approved ActionRequest is required.", resourceId: action?.id ?? null },
    { id: "reconcile_action", state: action?.status === "unknown_effect" ? "available" : action?.status === "executed" ? "completed" : "blocked", reason: action?.status === "unknown_effect" ? null : "Only an unknown effect can be reconciled.", resourceId: action?.id ?? null },
  ];
  const outcomeState: TargetOutcomeV1["state"] = canceled ? "canceled" : validAcceptance ? "accepted" : blocked ? "blocked" : status === "awaiting_acceptance" ? "awaiting_acceptance" : "open";
  return {
    status,
    outcome: {
      state: outcomeState,
      latestSubmissionId: latestSubmission?.id ?? null,
      latestReviewId: latestReview?.id ?? null,
      validAcceptanceId: validAcceptance?.id ?? null,
      effectReceiptIds: submissionActions.flatMap((row) => receiptByActionId.get(row.id)?.id ?? []),
      controls,
    },
    attention: items,
    availableCommands: commands,
  };
}

export function targetReadModelService(db: Db) {
  async function nativeRows(workspaceId: string, targetId?: string, targetRevisionId?: string): Promise<NativeTargetRow[]> {
    const conditions = [eq(verrailTargets.workspaceId, workspaceId)];
    if (targetId) conditions.push(eq(verrailTargets.id, targetId));
    const revisionJoin = targetRevisionId
      ? and(
          eq(verrailTargetRevisions.id, targetRevisionId),
          eq(verrailTargetRevisions.targetId, verrailTargets.id),
          eq(verrailTargetRevisions.workspaceId, verrailTargets.workspaceId),
        )
      : and(
          eq(verrailTargetRevisions.id, verrailTargets.activeTargetRevisionId),
          eq(verrailTargetRevisions.workspaceId, verrailTargets.workspaceId),
        );
    const rows = await db
      .select({ target: verrailTargets, revision: verrailTargetRevisions, collection: verrailCollections })
      .from(verrailTargets)
      .innerJoin(verrailTargetRevisions, revisionJoin)
      .leftJoin(verrailCollections, and(
        eq(verrailCollections.id, verrailTargets.collectionId),
        eq(verrailCollections.workspaceId, verrailTargets.workspaceId),
      ))
      .where(and(...conditions))
      .orderBy(desc(verrailTargets.updatedAt), asc(verrailTargets.id));
    return rows;
  }

  async function readFacts(workspaceId: string, targetIds: string[]) {
    if (targetIds.length === 0) {
      return {
        graphs: [], graphRevisions: [], nodes: [], runs: [], attempts: [], leases: [], events: [],
        ...EMPTY_ASSURANCE_FACTS,
      };
    }
    const [graphs, graphRevisions, nodes, runs, artifacts, claims, evidence, verificationResults, submissions, deliveryReviews, acceptances, integrationRuns, humanWorkResults, actionRequests, actionApprovals, effectReceipts, githubRepoBindings] = await Promise.all([
      db.select().from(verrailWorkGraphs).where(and(
        eq(verrailWorkGraphs.workspaceId, workspaceId),
        inArray(verrailWorkGraphs.targetId, targetIds),
      )),
      db.select().from(verrailGraphRevisions).where(and(
        eq(verrailGraphRevisions.workspaceId, workspaceId),
        inArray(verrailGraphRevisions.targetId, targetIds),
      )),
      db.select().from(verrailWorkNodes).where(and(
        eq(verrailWorkNodes.workspaceId, workspaceId),
        inArray(verrailWorkNodes.targetId, targetIds),
      )),
      db.select().from(verrailRuns).where(and(
        eq(verrailRuns.workspaceId, workspaceId),
        inArray(verrailRuns.targetId, targetIds),
      )).orderBy(desc(verrailRuns.createdAt)),
      db.select().from(verrailArtifacts).where(and(
        eq(verrailArtifacts.workspaceId, workspaceId),
        inArray(verrailArtifacts.targetId, targetIds),
      )),
      db.select().from(verrailClaims).where(and(
        eq(verrailClaims.workspaceId, workspaceId),
        inArray(verrailClaims.targetId, targetIds),
      )),
      db.select().from(verrailEvidence).where(and(
        eq(verrailEvidence.workspaceId, workspaceId),
        inArray(verrailEvidence.targetId, targetIds),
      )),
      db.select().from(verrailVerificationResults).where(and(
        eq(verrailVerificationResults.workspaceId, workspaceId),
        inArray(verrailVerificationResults.targetId, targetIds),
      )),
      db.select().from(verrailSubmissions).where(and(
        eq(verrailSubmissions.workspaceId, workspaceId),
        inArray(verrailSubmissions.targetId, targetIds),
      )),
      db.select().from(verrailDeliveryReviews).where(and(
        eq(verrailDeliveryReviews.workspaceId, workspaceId),
        inArray(verrailDeliveryReviews.targetId, targetIds),
      )),
      db.select().from(verrailAcceptances).where(and(
        eq(verrailAcceptances.workspaceId, workspaceId),
        inArray(verrailAcceptances.targetId, targetIds),
      )),
      db.select().from(verrailIntegrationRuns).where(and(
        eq(verrailIntegrationRuns.workspaceId, workspaceId),
        inArray(verrailIntegrationRuns.targetId, targetIds),
      )),
      db.select().from(verrailHumanWorkResults).where(and(
        eq(verrailHumanWorkResults.workspaceId, workspaceId),
        inArray(verrailHumanWorkResults.targetId, targetIds),
      )),
      db.select().from(verrailActionRequests).where(and(
        eq(verrailActionRequests.workspaceId, workspaceId),
        inArray(verrailActionRequests.targetId, targetIds),
      )),
      db.select().from(verrailActionApprovals).where(eq(verrailActionApprovals.workspaceId, workspaceId)),
      db.select().from(verrailEffectReceipts).where(and(
        eq(verrailEffectReceipts.workspaceId, workspaceId),
        inArray(verrailEffectReceipts.targetId, targetIds),
      )),
      db.select().from(verrailGithubRepoBindings).where(eq(verrailGithubRepoBindings.workspaceId, workspaceId)),
    ]);
    const runIds = runs.map((run) => run.id);
    const integrationRunIds = integrationRuns.map((run) => run.id);
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const [attempts, leases, events, artifactRevisions, integrationAttempts] = await Promise.all([
      runIds.length === 0 ? [] : db.select().from(verrailRunAttempts).where(and(
        eq(verrailRunAttempts.workspaceId, workspaceId),
        inArray(verrailRunAttempts.runId, runIds),
      )),
      runIds.length === 0 ? [] : db.select().from(verrailExecutionLeases).where(and(
        eq(verrailExecutionLeases.workspaceId, workspaceId),
        inArray(verrailExecutionLeases.runId, runIds),
      )),
      runIds.length === 0 ? [] : db.select().from(verrailRunEvents).where(and(
        eq(verrailRunEvents.workspaceId, workspaceId),
        inArray(verrailRunEvents.runId, runIds),
      )),
      artifactIds.length === 0 ? [] : db.select().from(verrailArtifactRevisions).where(and(
        eq(verrailArtifactRevisions.workspaceId, workspaceId),
        inArray(verrailArtifactRevisions.artifactId, artifactIds),
      )),
      integrationRunIds.length === 0 ? [] : db.select().from(verrailIntegrationAttempts).where(and(
        eq(verrailIntegrationAttempts.workspaceId, workspaceId),
        inArray(verrailIntegrationAttempts.integrationRunId, integrationRunIds),
      )),
    ]);
    return { graphs, graphRevisions, nodes, runs, attempts, leases, events, artifacts, artifactRevisions, claims, evidence, verificationResults, submissions, deliveryReviews, acceptances, integrationRuns, integrationAttempts, humanWorkResults, actionRequests, actionApprovals, effectReceipts, githubRepoBindings };
  }

  function buildModel(
    row: NativeTargetRow,
    facts: Awaited<ReturnType<typeof readFacts>>,
    projectedAt: string,
  ): TargetReadModelV1 {
    const graph = facts.graphs.find((item) => item.targetId === row.target.id) ?? null;
    const activeNodes = graph?.activeGraphRevisionId
      ? facts.nodes.filter((item) => item.graphRevisionId === graph.activeGraphRevisionId).map(mapWorkNode)
      : [];
    const runs = facts.runs.filter((item) => item.targetId === row.target.id).map((run) => mapRun(run, facts));
    const stages = stageProgress(activeNodes);
    const updatedAt = targetActivityAt(row.target.id, facts, row.target.updatedAt);
    const projection = deriveTargetProjection({
      targetId: row.target.id,
      activeTargetRevisionId: row.revision.id,
      createdAt: row.target.createdAt.toISOString(),
      activityAt: updatedAt,
      persistedStatus: row.target.status,
      outcomeOwner: {
        principalType: row.revision.outcomeOwnerPrincipalType,
        principalId: row.revision.outcomeOwnerPrincipalId,
      },
      criteria: row.revision.acceptanceCriteria,
      graph,
      nodes: activeNodes,
      runs,
      facts,
    });
    const activeRuns = runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "cancel_requested");
    const failedRuns = runs.filter((run) => run.status === "failed");
    const latestRun = runs[0] ?? null;
    const targetArtifacts = facts.artifacts.filter((item) => item.targetId === row.target.id);
    const targetArtifactIds = new Set(targetArtifacts.map((artifact) => artifact.id));
    const targetRevisions = facts.artifactRevisions.filter((revision) => targetArtifactIds.has(revision.artifactId));
    const latestRevisionId = targetArtifacts
      .map((artifact) => targetRevisions
        .filter((revision) => revision.artifactId === artifact.id)
        .sort((left, right) => right.revisionNumber - left.revisionNumber || left.id.localeCompare(right.id))[0])
      .filter((revision) => revision != null)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id))[0]?.id ?? null;
    const targetClaims = facts.claims.filter((item) => item.targetId === row.target.id);
    const targetVerificationResults = facts.verificationResults.filter((item) => item.targetId === row.target.id);
    const verifiedClaimIds = new Set(targetVerificationResults.map((result) => result.claimId));
    const verifiedCriterionKeys = new Set(
      targetClaims.filter((claim) => verifiedClaimIds.has(claim.id)).map((claim) => claim.criterionKey),
    );
    const criteria = row.revision.acceptanceCriteria;
    const coveredCriteria = criteria.filter((criterion) => verifiedCriterionKeys.has(criterion.id)).length;
    const evidenceCoverage = criteria.length === 0 || coveredCriteria === 0
      ? "unknown"
      : coveredCriteria >= criteria.length ? "complete" : "partial";
    return {
      schemaVersion: TARGET_READ_MODEL_SCHEMA_VERSION,
      readModelPolicyVersion: TARGET_READ_MODEL_POLICY_VERSION,
      targetId: row.target.id,
      activeTargetRevisionId: row.revision.id,
      workspaceId: row.target.workspaceId,
      collection: row.collection ? { id: row.collection.id, name: row.collection.name } : null,
      title: row.revision.title,
      summary: row.revision.summary,
      status: projection.status,
      outcome: projection.outcome,
      outcomeOwner: {
        principalType: row.revision.outcomeOwnerPrincipalType as "user" | "agent",
        principalId: row.revision.outcomeOwnerPrincipalId,
        displayName: row.revision.outcomeOwnerDisplayName,
      },
      currentStage: currentStage(stages),
      risk: { level: row.revision.riskLevel as TargetReadModelV1["risk"]["level"] },
      attentionSummary: {
        total: projection.attention.length,
        highestSeverity: projection.attention.some((item) => item.severity === "critical")
          ? "critical"
          : projection.attention.some((item) => item.severity === "warning") ? "warning" : projection.attention.length > 0 ? "info" : null,
      },
      artifactSummary: { count: targetArtifacts.length, latestRevisionId },
      evidenceSummary: {
        count: facts.evidence.filter((item) => item.targetId === row.target.id).length,
        passed: targetVerificationResults.filter((item) => item.verdict === "passed").length,
        failed: targetVerificationResults.filter((item) => item.verdict === "failed").length,
        inconclusive: targetVerificationResults.filter((item) => item.verdict === "inconclusive").length,
        coverage: evidenceCoverage,
      },
      runSummary: {
        active: activeRuns.length,
        failed: failedRuns.length,
        latestRunId: latestRun?.id ?? null,
        latestRunAt: latestRun ? (latestRun.finishedAt ?? latestRun.startedAt ?? latestRun.createdAt) : null,
      },
      definition: {
        goal: row.revision.goal,
        constraints: row.revision.constraints,
        acceptanceCriteria: row.revision.acceptanceCriteria,
        deadline: row.revision.deadline,
        policySummary: row.revision.policySummary,
        resourceRefs: resourceRefs(row.revision.resourceRefs),
      },
      createdAt: row.target.createdAt.toISOString(),
      updatedAt,
      projectedAt,
    };
  }

  async function modelsFor(workspaceId: string, targetId?: string, targetRevisionId?: string) {
    const rows = await nativeRows(workspaceId, targetId, targetRevisionId);
    const facts = await readFacts(workspaceId, rows.map((row) => row.target.id));
    const projectedAt = new Date().toISOString();
    return rows.map((row) => buildModel(row, facts, projectedAt));
  }

  return {
    list: (workspaceId: string) => modelsFor(workspaceId),

    getByTargetId: async (workspaceId: string, targetId: string) =>
      (await modelsFor(workspaceId, targetId))[0] ?? null,

    getByRevisionId: async (workspaceId: string, targetId: string, targetRevisionId: string) =>
      (await modelsFor(workspaceId, targetId, targetRevisionId))[0] ?? null,

    workspace: async (model: TargetReadModelV1): Promise<TargetWorkspaceAssuranceFactsV1> => {
      const facts = await readFacts(model.workspaceId, [model.targetId]);
      const graph = facts.graphs.find((item) => item.targetId === model.targetId) ?? null;
      const activeRevision = graph?.activeGraphRevisionId
        ? facts.graphRevisions.find((item) => item.id === graph.activeGraphRevisionId) ?? null
        : null;
      const work = graph?.activeGraphRevisionId
        ? facts.nodes.filter((item) => item.graphRevisionId === graph.activeGraphRevisionId).map(mapWorkNode)
        : [];
      const runs = facts.runs.filter((item) => item.targetId === model.targetId).map((run) => mapRun(run, facts));
      const stages = stageProgress(work);
      const projection = deriveTargetProjection({
        targetId: model.targetId,
        activeTargetRevisionId: model.activeTargetRevisionId,
        createdAt: model.createdAt,
        activityAt: model.updatedAt,
        persistedStatus: model.status,
        outcomeOwner: model.outcomeOwner,
        criteria: model.definition.acceptanceCriteria,
        graph,
        nodes: work,
        runs,
        facts,
      });
      const aggregateIds = new Set<string>([
        model.targetId,
        model.activeTargetRevisionId,
        ...facts.graphs.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.graphRevisions.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.nodes.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.runs.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.submissions.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.deliveryReviews.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.acceptances.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.integrationRuns.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.humanWorkResults.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.actionRequests.filter((row) => row.targetId === model.targetId).map((row) => row.id),
        ...facts.effectReceipts.filter((row) => row.targetId === model.targetId).map((row) => row.id),
      ]);
      const auditRows = await db.select().from(verrailAuditEvents).where(and(
        eq(verrailAuditEvents.workspaceId, model.workspaceId),
        inArray(verrailAuditEvents.aggregateId, [...aggregateIds]),
      )).orderBy(asc(verrailAuditEvents.occurredAt), asc(verrailAuditEvents.id));
      const timeline: TargetTimelineEventV1[] = auditRows.map((event) => {
        const typeMap: Record<string, TargetTimelineEventV1["type"]> = {
          "target.created": "target_created",
          "target.revision_created": "target_revision_created",
          "graph.revision_created": "graph_revision_created",
          "graph.activated": "graph_activated",
          "run.created": "run_created",
          "run.updated": "run_updated",
          "adjudication.submission_created.v1": "submission_created",
          "adjudication.review_recorded.v1": "review_recorded",
          "adjudication.acceptance_created.v1": "acceptance_created",
          "connector.integration_run_recorded.v1": "integration_result_recorded",
          "connector.human_work_result_recorded.v1": "human_result_recorded",
          "connector.action_request_created.v1": "action_requested",
          "connector.action_approved.v1": "action_approved",
          "connector.action_executed.v1": "action_executed",
        };
        return {
          id: event.id,
          type: typeMap[event.eventType] ?? "domain_event",
          title: event.eventType,
          detail: Object.keys(event.payload).length > 0 ? JSON.stringify(event.payload) : null,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          occurredAt: event.occurredAt.toISOString(),
        };
      });
      const submissions = facts.submissions
        .filter((item) => item.targetId === model.targetId)
        .sort((left, right) => byCreatedAtDesc(left, right))
        .map(mapSubmission);
      const latestSubmissionId = submissions[0]?.id ?? null;
      const githubBinding = facts.githubRepoBindings
        .filter((item) => item.workspaceId === model.workspaceId)
        .sort((left, right) => byCreatedAtAsc(left, right))[0] ?? null;
      return {
        schemaVersion: TARGET_WORKSPACE_SCHEMA_VERSION,
        targetId: model.targetId,
        targetRevisionId: model.activeTargetRevisionId,
        workspaceId: model.workspaceId,
        generatedAt: new Date().toISOString(),
        graph: graph ? {
          workGraphId: graph.id,
          activeGraphRevisionId: graph.activeGraphRevisionId,
          status: graph.status as "draft" | "active" | "completed" | "canceled",
          revisionNumber: activeRevision?.revisionNumber ?? null,
        } : null,
        outcome: projection.outcome,
        availableCommands: projection.availableCommands,
        stages,
        work,
        attention: projection.attention,
        submissions,
        reviews: facts.deliveryReviews
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtDesc(left, right))
          .map(mapDeliveryReview),
        acceptances: facts.acceptances
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtDesc(left, right))
          .map((acceptance) => mapAcceptance(acceptance, latestSubmissionId, model.activeTargetRevisionId)),
        artifacts: facts.artifacts
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtAsc(left, right))
          .map((artifact) => mapArtifact(artifact, facts.artifactRevisions)),
        claims: facts.claims
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtAsc(left, right))
          .map(mapClaim),
        evidence: facts.evidence
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => left.recordedAt.getTime() - right.recordedAt.getTime() || left.id.localeCompare(right.id))
          .map(mapEvidence),
        verificationResults: facts.verificationResults
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtAsc(left, right))
          .map(mapVerificationResult),
        integrationRuns: facts.integrationRuns
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtAsc(left, right))
          .map((run) => mapIntegrationRun(run, facts.integrationAttempts)),
        humanWorkResults: facts.humanWorkResults
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtAsc(left, right))
          .map(mapHumanWorkResult),
        actionRequests: facts.actionRequests
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtAsc(left, right))
          .map((request) => mapActionRequest(request, facts)),
        effectReceipts: facts.effectReceipts
          .filter((item) => item.targetId === model.targetId)
          .sort((left, right) => byCreatedAtAsc(left, right))
          .map(mapEffectReceipt),
        workspaceBinding: githubBinding
          ? { repoOwner: githubBinding.repoOwner, repoName: githubBinding.repoName }
          : null,
        runs,
        timeline,
      };
    },

    runOutboxFailures: async (workspaceId: string, targetId: string): Promise<RunOutboxFailureV1[]> => {
      const rows = await db.select({
        eventId: verrailOutboxEvents.id, runId: verrailRuns.id,
        eventType: verrailOutboxEvents.eventType, attemptCount: verrailOutboxEvents.attemptCount,
        lastError: verrailOutboxEvents.lastError, createdAt: verrailOutboxEvents.createdAt,
      }).from(verrailOutboxEvents).innerJoin(verrailRuns, and(
        eq(verrailRuns.id, verrailOutboxEvents.aggregateId),
        eq(verrailRuns.workspaceId, verrailOutboxEvents.workspaceId),
      )).where(and(
        eq(verrailOutboxEvents.workspaceId, workspaceId), eq(verrailRuns.targetId, targetId),
        eq(verrailOutboxEvents.aggregateType, "run"), eq(verrailOutboxEvents.status, "failed"),
      )).orderBy(asc(verrailOutboxEvents.createdAt), asc(verrailOutboxEvents.id)).limit(100);
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    },

    attentionItems: async (workspaceId: string) => {
      const rows = await nativeRows(workspaceId);
      const facts = await readFacts(workspaceId, rows.map((row) => row.target.id));
      const projectedAt = new Date().toISOString();
      return rows.map((row) => {
        const model = buildModel(row, facts, projectedAt);
        const graph = facts.graphs.find((item) => item.targetId === row.target.id) ?? null;
        const nodes = graph?.activeGraphRevisionId
          ? facts.nodes.filter((item) => item.graphRevisionId === graph.activeGraphRevisionId).map(mapWorkNode)
          : [];
        const runs = facts.runs.filter((item) => item.targetId === row.target.id).map((run) => mapRun(run, facts));
        const projection = deriveTargetProjection({
          targetId: row.target.id,
          activeTargetRevisionId: row.revision.id,
          createdAt: row.target.createdAt.toISOString(),
          activityAt: model.updatedAt,
          persistedStatus: row.target.status,
          outcomeOwner: { principalType: row.revision.outcomeOwnerPrincipalType, principalId: row.revision.outcomeOwnerPrincipalId },
          criteria: row.revision.acceptanceCriteria,
          graph,
          nodes,
          runs,
          facts,
        });
        return { model, attention: projection.attention };
      });
    },
  };
}
