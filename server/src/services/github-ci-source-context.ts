import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { deliveryProofKindForAssertions } from "@paperclipai/shared";
import {
  type Db, companies, verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions, verrailClaims, verrailWorkNodes,
  verrailArtifacts, verrailArtifactRevisions, verrailRuns, verrailRunAttempts, verrailRunEvents, verrailAuditEvents,
  verrailCriterionProofs, verrailIntegrationRuns,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { validateNativeOutputReceipt } from "./verrail-native-output.js";
import type { GitHubCiSourceSnapshot } from "./github-ci-source-mapping.js";

export interface GitHubCiSourceContextInput {
  workspaceId: string; targetId: string; targetRevisionId: string; graphRevisionId: string;
  claimId: string; workNodeId: string; artifactRevisionId: string; requirementId: string;
}
export interface GitHubCiSourceContext {
  criterionKey: string;
  source: { runId: string; runAttemptId: string; runEventId: string; runEventContentHash: string; outputReceiptSha256: string; artifactOrdinal: number };
  snapshot: GitHubCiSourceSnapshot;
  contextSha256: string;
}
const checks = new Set(["ts_tests", "ts_typecheck", "ts_build", "go_tests"]);
function unavailable(): never { throw conflict("GitHub CI source context unavailable or changed"); }
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const nativeArtifact = z.object({ title: z.string(), kind: z.string(), contentHash: z.string(), contentRef: z.string() }).strict();

/** Trusted database associations establish authorship; receipt hashes alone do not. */
export async function loadGitHubCiSourceContext(db: Db, input: GitHubCiSourceContextInput): Promise<GitHubCiSourceContext> {
  return loadSourceContext(db, input, "fixed_ci");
}

/** Source association for the complete Codex requirement; never grants CI-only admission. */
export async function loadCodexDeliverySourceContext(db: Db, input: GitHubCiSourceContextInput): Promise<GitHubCiSourceContext> {
  return loadSourceContext(db, input, "codex_execution");
}

export async function loadFeishuDeliverySourceContext(db: Db, input: GitHubCiSourceContextInput): Promise<GitHubCiSourceContext> {
  return loadSourceContext(db, input, "feishu_target");
}

async function loadSourceContext(db: Db, input: GitHubCiSourceContextInput, kind: "fixed_ci" | "codex_execution" | "feishu_target"): Promise<GitHubCiSourceContext> {
  const { workspaceId, targetId, targetRevisionId, graphRevisionId } = input;
  return db.transaction(async tx => {
    const [context] = await tx.select({
      targetStatus: verrailTargets.status, targetUpdatedAt: verrailTargets.updatedAt, targetHash: verrailTargetRevisions.contentHash,
      criteria: verrailTargetRevisions.acceptanceCriteria, graphHash: verrailGraphRevisions.contentHash,
      graphStatus: verrailWorkGraphs.status, graphUpdatedAt: verrailWorkGraphs.updatedAt, graphActivatedAt: verrailGraphRevisions.activatedAt,
      criterionKey: verrailClaims.criterionKey, claimStatus: verrailClaims.status, claimUpdatedAt: verrailClaims.updatedAt,
      nodeStatus: verrailWorkNodes.status, nodeUpdatedAt: verrailWorkNodes.updatedAt,
    }).from(verrailTargets)
      .innerJoin(companies, and(eq(companies.id, workspaceId), eq(companies.status, "active")))
      .innerJoin(verrailTargetRevisions, and(eq(verrailTargetRevisions.id, targetRevisionId), eq(verrailTargetRevisions.id, verrailTargets.activeTargetRevisionId), eq(verrailTargetRevisions.workspaceId, workspaceId), eq(verrailTargetRevisions.targetId, targetId)))
      .innerJoin(verrailWorkGraphs, and(eq(verrailWorkGraphs.workspaceId, workspaceId), eq(verrailWorkGraphs.targetId, targetId), eq(verrailWorkGraphs.activeGraphRevisionId, graphRevisionId)))
      .innerJoin(verrailGraphRevisions, and(eq(verrailGraphRevisions.id, graphRevisionId), eq(verrailGraphRevisions.workspaceId, workspaceId), eq(verrailGraphRevisions.targetId, targetId), eq(verrailGraphRevisions.targetRevisionId, targetRevisionId), eq(verrailGraphRevisions.workGraphId, verrailWorkGraphs.id), eq(verrailGraphRevisions.status, "active")))
      .innerJoin(verrailClaims, and(eq(verrailClaims.id, input.claimId), eq(verrailClaims.workspaceId, workspaceId), eq(verrailClaims.targetId, targetId), eq(verrailClaims.targetRevisionId, targetRevisionId)))
      .innerJoin(verrailWorkNodes, and(eq(verrailWorkNodes.id, input.workNodeId), eq(verrailWorkNodes.workspaceId, workspaceId), eq(verrailWorkNodes.targetId, targetId), eq(verrailWorkNodes.graphRevisionId, graphRevisionId), eq(verrailWorkNodes.kind, "integration_task")))
      .where(and(eq(verrailTargets.id, targetId), eq(verrailTargets.workspaceId, workspaceId))).limit(1);
    if (!context || context.targetStatus === "canceled" || context.graphStatus === "canceled" || !Array.isArray(context.criteria)) unavailable();
    const criteria = context.criteria.filter(criterion => criterion.id === context.criterionKey);
    if (criteria.length !== 1) unavailable();
    const contract = criteria[0]!.proofContract;
    if (contract?.schemaVersion !== 1 || !Array.isArray(contract.allOf)) unavailable();
    const requirements = contract.allOf.filter(requirement => requirement.id === input.requirementId);
    const requirement = requirements[0];
    if (requirements.length !== 1 || requirement?.kind !== "independent_verification" || requirement.phase !== "pre_acceptance"
      || !Array.isArray(requirement.assertions) || requirement.assertions.length < 1 || requirement.assertions.length > 4
      || new Set(requirement.assertions).size !== requirement.assertions.length) unavailable();
    if (kind === "fixed_ci" ? !requirement.assertions.every(assertion => checks.has(assertion))
      : deliveryProofKindForAssertions(requirement.assertions) !== kind) unavailable();
    if (!["ready", "running"].includes(context.nodeStatus)) {
      if (!["completed", "blocked"].includes(context.nodeStatus)) unavailable();
      const [previous] = await tx.select({ id: verrailCriterionProofs.id }).from(verrailCriterionProofs)
        .innerJoin(verrailIntegrationRuns, and(eq(verrailIntegrationRuns.id, verrailCriterionProofs.integrationRunId), eq(verrailIntegrationRuns.workspaceId, workspaceId), eq(verrailIntegrationRuns.workNodeId, input.workNodeId)))
        .where(and(eq(verrailCriterionProofs.workspaceId, workspaceId), eq(verrailCriterionProofs.targetRevisionId, targetRevisionId), eq(verrailCriterionProofs.graphRevisionId, graphRevisionId), eq(verrailCriterionProofs.criterionKey, context.criterionKey), eq(verrailCriterionProofs.requirementId, input.requirementId), eq(verrailCriterionProofs.phase, "pre_acceptance"))).limit(1);
      if (!previous) unavailable();
    }
    const [artifact] = await tx.select({
      id: verrailArtifactRevisions.id, artifactId: verrailArtifacts.id, title: verrailArtifacts.title, kind: verrailArtifacts.kind,
      contentHash: verrailArtifactRevisions.contentHash, contentRef: verrailArtifactRevisions.contentRef,
      revisionNumber: verrailArtifactRevisions.revisionNumber, revisionCreatedAt: verrailArtifactRevisions.createdAt,
      runId: verrailRuns.id, nodeId: verrailRuns.workNodeId, runUpdatedAt: verrailRuns.updatedAt,
      deploymentRevisionId: verrailRuns.deploymentRevisionId, agentVersionId: verrailRuns.agentVersionId,
      attemptId: verrailRunAttempts.id, fencingToken: verrailRunAttempts.fencingToken, cursor: verrailRunAttempts.lastEventCursor,
      attemptUpdatedAt: verrailRunAttempts.updatedAt,
    }).from(verrailArtifactRevisions)
      .innerJoin(verrailArtifacts, and(eq(verrailArtifacts.id, verrailArtifactRevisions.artifactId), eq(verrailArtifacts.workspaceId, workspaceId), eq(verrailArtifacts.targetId, targetId), eq(verrailArtifacts.kind, "code_change"), eq(verrailArtifacts.createdByPrincipalType, "service"), eq(verrailArtifacts.createdByPrincipalId, "verrail-host-runner")))
      .innerJoin(verrailRuns, and(eq(verrailRuns.id, verrailArtifactRevisions.sourceRunId), eq(verrailRuns.workNodeId, verrailArtifactRevisions.sourceWorkNodeId), eq(verrailRuns.workspaceId, workspaceId), eq(verrailRuns.targetId, targetId), eq(verrailRuns.targetRevisionId, targetRevisionId), eq(verrailRuns.graphRevisionId, graphRevisionId), eq(verrailRuns.kind, "agent"), eq(verrailRuns.status, "succeeded")))
      .innerJoin(verrailRunAttempts, and(eq(verrailRunAttempts.runId, verrailRuns.id), eq(verrailRunAttempts.workspaceId, workspaceId), eq(verrailRunAttempts.attemptNumber, verrailRuns.attemptCount), eq(verrailRunAttempts.deploymentRevisionId, verrailRuns.deploymentRevisionId), eq(verrailRunAttempts.agentVersionId, verrailRuns.agentVersionId), eq(verrailRunAttempts.status, "succeeded"), eq(verrailRunAttempts.runtimeProfile, "host_trusted"), eq(verrailRunAttempts.executorPrincipalType, "service"), eq(verrailRunAttempts.executorPrincipalId, "verrail-host-runner")))
      .where(and(eq(verrailArtifactRevisions.id, input.artifactRevisionId), eq(verrailArtifactRevisions.workspaceId, workspaceId), eq(verrailArtifactRevisions.createdByPrincipalType, "service"), eq(verrailArtifactRevisions.createdByPrincipalId, "verrail-host-runner"))).limit(1);
    if (!artifact || !artifact.deploymentRevisionId || !artifact.agentVersionId || artifact.revisionNumber !== 1) unavailable();
    const [sourceNode] = await tx.select({ id: verrailWorkNodes.id, status: verrailWorkNodes.status, updatedAt: verrailWorkNodes.updatedAt }).from(verrailWorkNodes)
      .where(and(eq(verrailWorkNodes.id, artifact.nodeId), eq(verrailWorkNodes.workspaceId, workspaceId), eq(verrailWorkNodes.targetId, targetId), eq(verrailWorkNodes.graphRevisionId, graphRevisionId), eq(verrailWorkNodes.kind, "agent_task"), eq(verrailWorkNodes.status, "completed"))).limit(1);
    if (!sourceNode) unavailable();
    const events = await tx.select().from(verrailRunEvents).where(and(eq(verrailRunEvents.workspaceId, workspaceId), eq(verrailRunEvents.runId, artifact.runId), eq(verrailRunEvents.runAttemptId, artifact.attemptId), eq(verrailRunEvents.eventType, "succeeded"))).limit(2);
    const event = events[0];
    if (events.length !== 1 || !event || event.fencingToken !== artifact.fencingToken || event.cursor !== artifact.cursor
      || !/^[a-f0-9]{64}$/.test(event.contentHash) || canonical(event.payload).length > 2_000_000) unavailable();
    const facts = z.object({ heartbeatRunId: z.string().min(1), agentId: z.string().min(1) }).safeParse(event.payload);
    if (!facts.success) unavailable();
    const receipt = validateNativeOutputReceipt(event.payload.outputReceipt, { workspaceId, runId: artifact.runId, attemptId: artifact.attemptId,
      deploymentRevisionId: artifact.deploymentRevisionId, agentVersionId: artifact.agentVersionId, ...facts.data });
    if (!receipt || receipt.schemaVersion !== 2 || !receipt.executionFacts || !receipt.finalizedAt || receipt.sourceStatus !== "stable"
      || Object.entries(receipt.executionFacts).some(([key, value]) => canonical(event.payload[key]) !== canonical(value))
      || canonical(event.payload.sourceObservation) !== canonical(receipt.beforeSource)) unavailable();
    const matches = receipt.artifacts.filter(entry => "sourceSnapshot" in entry && entry.type === "source_snapshot"
      && entry.title === artifact.title && entry.kind === artifact.kind && entry.contentHash === artifact.contentHash && entry.contentRef === artifact.contentRef);
    const mapping = matches[0];
    if (matches.length !== 1 || !mapping || !("sourceSnapshot" in mapping)) unavailable();
    const registered = z.array(nativeArtifact).max(10).safeParse(event.payload.artifacts);
    if (!registered.success || registered.data.length !== receipt.artifacts.length || registered.data.some((entry, index) => {
      const original = receipt.artifacts[index]!; return entry.title !== original.title || entry.kind !== original.kind || entry.contentHash !== original.contentHash || entry.contentRef !== original.contentRef;
    })) unavailable();
    const audits = await tx.select().from(verrailAuditEvents).where(and(eq(verrailAuditEvents.workspaceId, workspaceId), eq(verrailAuditEvents.aggregateId, input.artifactRevisionId), eq(verrailAuditEvents.aggregateType, "artifact_revision"), eq(verrailAuditEvents.eventType, "assurance.artifact_revision_added.v1"), eq(verrailAuditEvents.principalType, "service"), eq(verrailAuditEvents.principalId, "verrail-host-runner"))).limit(2);
    const audit = audits[0];
    const expectedAudit = { schemaVersion: 1, resourceType: "artifact_revision", resourceId: artifact.id, runId: artifact.runId, runAttemptId: artifact.attemptId, workNodeId: artifact.nodeId, fencingToken: artifact.fencingToken, contentHash: artifact.contentHash };
    if (audits.length !== 1 || !audit || canonical(audit.payload) !== canonical(expectedAudit)) unavailable();
    return { criterionKey: context.criterionKey,
      source: { runId: artifact.runId, runAttemptId: artifact.attemptId, runEventId: event.id, runEventContentHash: event.contentHash, outputReceiptSha256: receipt.sha256, artifactOrdinal: mapping.ordinal },
      snapshot: { sourceSnapshotTreeSha: mapping.sourceSnapshot.snapshotTree, sourceContentSha256: mapping.sourceSnapshot.sourceContentSha256 },
      contextSha256: createHash("sha256").update(canonical({ input, context, artifact, sourceNode, event, audit })).digest("hex"),
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
