import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  verrailAuditEvents,
  verrailArtifactRevisions,
  verrailArtifacts,
  verrailClaims,
  verrailCollections,
  verrailEvidence,
  verrailGraphRevisions,
  verrailExecutionLeases,
  verrailRunAttempts,
  verrailRunEvents,
  verrailRuns,
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
  type AssuranceArtifactRevisionV1,
  type AssuranceArtifactV1,
  type AssuranceClaimV1,
  type AssuranceEvidenceV1,
  type AssurancePrincipalV1,
  type AssuranceVerificationResultV1,
  type TargetAttentionItemV1,
  type TargetReadModelV1,
  type TargetResourceRefV1,
  type TargetRunV1,
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

export type TargetWorkspaceAssuranceFactsV1 = Omit<TargetWorkspaceV1, "artifacts" | "evidence"> & {
  artifacts: AssuranceArtifactV1[];
  claims: AssuranceClaimV1[];
  evidence: AssuranceEvidenceV1[];
  verificationResults: AssuranceVerificationResultV1[];
};

type AssuranceFacts = {
  artifacts: Array<typeof verrailArtifacts.$inferSelect>;
  artifactRevisions: Array<typeof verrailArtifactRevisions.$inferSelect>;
  claims: Array<typeof verrailClaims.$inferSelect>;
  evidence: Array<typeof verrailEvidence.$inferSelect>;
  verificationResults: Array<typeof verrailVerificationResults.$inferSelect>;
};

const EMPTY_ASSURANCE_FACTS: AssuranceFacts = {
  artifacts: [],
  artifactRevisions: [],
  claims: [],
  evidence: [],
  verificationResults: [],
};

function byCreatedAtAsc(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
) {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
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

function attentionFor(input: {
  model: Pick<TargetReadModelV1, "targetId" | "status" | "createdAt">;
  graph: typeof verrailWorkGraphs.$inferSelect | null;
  nodes: TargetWorkItemV1[];
  runs: TargetRunV1[];
}): TargetAttentionItemV1[] {
  const items: TargetAttentionItemV1[] = [];
  if (!input.graph?.activeGraphRevisionId) {
    items.push({
      id: `draft-graph:${input.model.targetId}`,
      severity: "info",
      kind: "draft_graph",
      title: "Work graph needs activation",
      detail: "Define and activate a native graph revision before execution can start.",
      workNodeId: null,
      runId: null,
      createdAt: input.model.createdAt,
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
      createdAt: run.finishedAt ?? run.createdAt,
    });
  }
  if (input.model.status === "awaiting_acceptance") {
    items.push({
      id: `awaiting-acceptance:${input.model.targetId}`,
      severity: "warning",
      kind: "awaiting_acceptance",
      title: "Human acceptance is required",
      detail: null,
      workNodeId: null,
      runId: null,
      createdAt: input.model.createdAt,
    });
  }
  return items;
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
    const [graphs, graphRevisions, nodes, runs, artifacts, claims, evidence, verificationResults] = await Promise.all([
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
    ]);
    const runIds = runs.map((run) => run.id);
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const [attempts, leases, events, artifactRevisions] = await Promise.all([
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
    ]);
    return { graphs, graphRevisions, nodes, runs, attempts, leases, events, artifacts, artifactRevisions, claims, evidence, verificationResults };
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
    const base = {
      targetId: row.target.id,
      status: row.target.status as TargetReadModelV1["status"],
      createdAt: row.target.createdAt.toISOString(),
    };
    const attention = attentionFor({ model: base, graph, nodes: activeNodes, runs });
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
      status: row.target.status as TargetReadModelV1["status"],
      outcomeOwner: {
        principalType: row.revision.outcomeOwnerPrincipalType as "user" | "agent",
        principalId: row.revision.outcomeOwnerPrincipalId,
        displayName: row.revision.outcomeOwnerDisplayName,
      },
      currentStage: currentStage(stages),
      risk: { level: row.revision.riskLevel as TargetReadModelV1["risk"]["level"] },
      attentionSummary: {
        total: attention.length,
        highestSeverity: attention.some((item) => item.severity === "critical")
          ? "critical"
          : attention.some((item) => item.severity === "warning") ? "warning" : attention.length > 0 ? "info" : null,
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
      updatedAt: row.target.updatedAt.toISOString(),
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
      const attention = attentionFor({ model, graph, nodes: work, runs });
      const auditRows = await db.select().from(verrailAuditEvents).where(and(
        eq(verrailAuditEvents.workspaceId, model.workspaceId),
        eq(verrailAuditEvents.aggregateId, model.targetId),
      )).orderBy(asc(verrailAuditEvents.occurredAt));
      const timeline: TargetTimelineEventV1[] = auditRows.flatMap((event) => {
        const typeMap: Record<string, TargetTimelineEventV1["type"]> = {
          "target.created": "target_created",
          "graph.revision_created": "graph_revision_created",
          "graph.activated": "graph_activated",
          "run.created": "run_created",
          "run.updated": "run_updated",
        };
        const type = typeMap[event.eventType];
        return type ? [{
          id: event.id,
          type,
          title: event.eventType,
          detail: null,
          occurredAt: event.occurredAt.toISOString(),
        }] : [];
      });
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
        stages,
        work,
        attention,
        submissions: [],
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
        runs,
        timeline,
      };
    },
  };
}
