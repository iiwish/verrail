import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Db, companies, verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions,
  verrailClaims, verrailWorkNodes, verrailCriterionProofs, verrailIntegrationRuns } from "@paperclipai/db";
import { DELIVERY_PROOF_ASSERTIONS, deliveryProofKindForAssertions, repositoryExecutionIdentitySchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import type { GitHubCiSourceContextInput } from "./github-ci-source-context.js";
import type { RepositoryCiSourceOptions } from "./github-ci-repository-source-context.js";
import type { DeliveryProofReaderAccess } from "./delivery-proof-reader-access.js";
import { loadOpenCodeExecutionProofContext } from "./opencode-execution-proof-context.js";
import { loadRepositoryRecoveryRuntimeContext, type RepositoryRecoveryReaderConfiguration } from "./repository-recovery-proof-reader.js";
import { projectRepositoryRecoveryProof } from "./repository-recovery-proof-projection.js";

export const repositoryRecoveryAssertions = DELIVERY_PROOF_ASSERTIONS.repository_recovery;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function unavailable(): never { throw new Error("REPOSITORY_RECOVERY_DELIVERY_CONTEXT_UNAVAILABLE"); }

async function readRequirement(db: Db, input: GitHubCiSourceContextInput) {
  const { workspaceId, targetId, targetRevisionId, graphRevisionId } = input;
  return db.transaction(async tx => {
    const [context] = await tx.select({ targetStatus: verrailTargets.status, targetUpdatedAt: verrailTargets.updatedAt,
      targetHash: verrailTargetRevisions.contentHash, criteria: verrailTargetRevisions.acceptanceCriteria,
      graphHash: verrailGraphRevisions.contentHash, graphStatus: verrailWorkGraphs.status, graphUpdatedAt: verrailWorkGraphs.updatedAt,
      graphActivatedAt: verrailGraphRevisions.activatedAt, criterionKey: verrailClaims.criterionKey,
      claimStatus: verrailClaims.status, claimUpdatedAt: verrailClaims.updatedAt,
      nodeStatus: verrailWorkNodes.status, nodeUpdatedAt: verrailWorkNodes.updatedAt }).from(verrailTargets)
      .innerJoin(companies, and(eq(companies.id, workspaceId), eq(companies.status, "active")))
      .innerJoin(verrailTargetRevisions, and(eq(verrailTargetRevisions.id, targetRevisionId), eq(verrailTargetRevisions.id, verrailTargets.activeTargetRevisionId), eq(verrailTargetRevisions.workspaceId, workspaceId), eq(verrailTargetRevisions.targetId, targetId)))
      .innerJoin(verrailWorkGraphs, and(eq(verrailWorkGraphs.workspaceId, workspaceId), eq(verrailWorkGraphs.targetId, targetId), eq(verrailWorkGraphs.activeGraphRevisionId, graphRevisionId)))
      .innerJoin(verrailGraphRevisions, and(eq(verrailGraphRevisions.id, graphRevisionId), eq(verrailGraphRevisions.workspaceId, workspaceId), eq(verrailGraphRevisions.targetId, targetId), eq(verrailGraphRevisions.targetRevisionId, targetRevisionId), eq(verrailGraphRevisions.workGraphId, verrailWorkGraphs.id), eq(verrailGraphRevisions.status, "active")))
      .innerJoin(verrailClaims, and(eq(verrailClaims.id, input.claimId), eq(verrailClaims.workspaceId, workspaceId), eq(verrailClaims.targetId, targetId), eq(verrailClaims.targetRevisionId, targetRevisionId)))
      .innerJoin(verrailWorkNodes, and(eq(verrailWorkNodes.id, input.workNodeId), eq(verrailWorkNodes.workspaceId, workspaceId), eq(verrailWorkNodes.targetId, targetId), eq(verrailWorkNodes.graphRevisionId, graphRevisionId), eq(verrailWorkNodes.kind, "integration_task")))
      .where(and(eq(verrailTargets.id, targetId), eq(verrailTargets.workspaceId, workspaceId))).limit(1);
    if (!context || ["canceled", "accepted"].includes(context.targetStatus) || context.graphStatus !== "active" || !Array.isArray(context.criteria)) unavailable();
    const criteria = context.criteria.filter(criterion => criterion.id === context.criterionKey);
    if (criteria.length !== 1) unavailable();
    const contract = criteria[0]!.proofContract;
    if (contract?.schemaVersion !== 1 || !Array.isArray(contract.allOf)) unavailable();
    const requirements = contract.allOf.filter(requirement => requirement.id === input.requirementId), requirement = requirements[0];
    if (requirements.length !== 1 || requirement?.kind !== "independent_verification" || requirement.phase !== "pre_acceptance"
      || !Array.isArray(requirement.assertions) || deliveryProofKindForAssertions(requirement.assertions) !== "repository_recovery") unavailable();
    if (!["ready", "running"].includes(context.nodeStatus)) {
      if (!["completed", "blocked"].includes(context.nodeStatus)) unavailable();
      const [previous] = await tx.select({ id: verrailCriterionProofs.id }).from(verrailCriterionProofs)
        .innerJoin(verrailIntegrationRuns, and(eq(verrailIntegrationRuns.id, verrailCriterionProofs.integrationRunId), eq(verrailIntegrationRuns.workspaceId, workspaceId), eq(verrailIntegrationRuns.workNodeId, input.workNodeId)))
        .where(and(eq(verrailCriterionProofs.workspaceId, workspaceId), eq(verrailCriterionProofs.targetRevisionId, targetRevisionId), eq(verrailCriterionProofs.graphRevisionId, graphRevisionId), eq(verrailCriterionProofs.criterionKey, context.criterionKey), eq(verrailCriterionProofs.requirementId, input.requirementId), eq(verrailCriterionProofs.phase, "pre_acceptance"))).limit(1);
      if (!previous) unavailable();
    }
    return { criterionKey: context.criterionKey, contextSha256: digest({ input, context }) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Uses authenticated historical pre-runtime archives, never a fresh nonce for the stopped executor. */
export async function loadRepositoryRecoveryDeliveryProofContext(db: Db, access: DeliveryProofReaderAccess,
  input: GitHubCiSourceContextInput & { runId: string; runAttemptId: string },
  options: RepositoryCiSourceOptions & { config: RepositoryRecoveryReaderConfiguration }) {
  const requirement = await readRequirement(db, input);
  const recovered = await loadRepositoryRecoveryRuntimeContext(db, access, options);
  const loaded = await loadOpenCodeExecutionProofContext(db, input, options), execution = loaded.execution;
  const before = recovered.checkpoint.durable;
  if (!same(before.identity, repositoryExecutionIdentitySchema.strip().parse(execution))
    || before.outputReceiptSha256 !== execution.outputReceiptSha256
    || before.executionObservationSha256 !== execution.executionObservation.contentHash
    || before.executionLogSha256 !== execution.logRef.contentHash || before.executionSessionId !== execution.sessionId
    || !same(before.runtimeBinding.candidateRuntime, execution.candidateRuntime)
    || !same(before.runtimeBinding.runtimeWindow, execution.executionWindow)
    || recovered.completion.sourceContextSha256 !== loaded.source.contextSha256
    || recovered.completion.source.runEventId !== execution.runEventId) unavailable();
  const again = await loadOpenCodeExecutionProofContext(db, input, options);
  const rechecked = await loadRepositoryRecoveryRuntimeContext(db, access, options);
  if (again.execution.contextSha256 !== execution.contextSha256 || again.source.contextSha256 !== loaded.source.contextSha256
    || !same(rechecked, recovered) || (await readRequirement(db, input)).contextSha256 !== requirement.contextSha256) unavailable();
  return { source: { ...loaded.source, criterionKey: requirement.criterionKey,
    contextSha256: digest({ requirement, repository: loaded.source.contextSha256 }) }, execution,
    runtime: recovered.preRuntime, recovery: projectRepositoryRecoveryProof(recovered) };
}
