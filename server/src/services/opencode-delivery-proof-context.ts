import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Db, companies, verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions,
  verrailClaims, verrailWorkNodes, verrailCriterionProofs, verrailIntegrationRuns } from "@paperclipai/db";
import { deliveryProofKindForAssertions, repositoryExecutionIdentitySchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { conflict } from "../errors.js";
import type { GitHubCiSourceContextInput } from "./github-ci-source-context.js";
import type { RepositoryCiSourceOptions } from "./github-ci-repository-source-context.js";
import { loadOpenCodeExecutionProofContext } from "./opencode-execution-proof-context.js";
import { collectOpenCodeRuntimeWitnesses } from "./opencode-runtime-observation.js";
import { projectOpenCodeRuntimeProof } from "./opencode-runtime-proof-projection.js";

function unavailable(): never { throw conflict("OpenCode delivery proof context unavailable or changed"); }
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");

async function readRequirement(db: Db, input: GitHubCiSourceContextInput) {
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
    const requirements = contract.allOf.filter(requirement => requirement.id === input.requirementId), requirement = requirements[0];
    if (requirements.length !== 1 || requirement?.kind !== "independent_verification" || requirement.phase !== "pre_acceptance"
      || !Array.isArray(requirement.assertions) || requirement.assertions.length < 1 || requirement.assertions.length > 4
      || new Set(requirement.assertions).size !== requirement.assertions.length
      || deliveryProofKindForAssertions(requirement.assertions) !== "opencode_execution") unavailable();
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

/** No source-only admission: the complete execution and independently signed runtime are mandatory. */
export async function loadOpenCodeDeliveryProofContext(db: Db,
  input: GitHubCiSourceContextInput & { runId: string; runAttemptId: string },
  options: RepositoryCiSourceOptions & { runtime: Parameters<typeof collectOpenCodeRuntimeWitnesses>[0] }) {
  const requirement = await readRequirement(db, input);
  const loaded = await loadOpenCodeExecutionProofContext(db, input, options), execution = loaded.execution;
  if (execution.candidateRuntime.sessionId !== options.runtime.sessionId
    || execution.candidateRuntime.manifestSha256 !== options.runtime.manifestSha256) unavailable();
  const runtime = await collectOpenCodeRuntimeWitnesses(options.runtime, {
    identity: repositoryExecutionIdentitySchema.strip().parse(execution), runtimeWindow: execution.executionWindow,
    httpSession: { sessionId: execution.sessionId, runtimeVersion: execution.candidateRuntime.httpSession.runtimeVersion,
      createdAt: execution.sessionCreatedAt, homeSha256: execution.runtimeWitness.before.environment.homeSha256,
      completedAt: execution.sessionCompletedAt },
  });
  const native = runtime.witnesses.find(witness => witness.component === "opencode");
  if (!native || native.observerPid !== execution.candidateRuntime.observerPid
    || native.observation.pid !== execution.candidateRuntime.nativePid) unavailable();
  const again = await loadOpenCodeExecutionProofContext(db, input, options);
  if (again.execution.contextSha256 !== execution.contextSha256 || again.source.contextSha256 !== loaded.source.contextSha256
    || (await readRequirement(db, input)).contextSha256 !== requirement.contextSha256) unavailable();
  return { source: { ...loaded.source, criterionKey: requirement.criterionKey,
    contextSha256: digest({ requirement, repository: loaded.source.contextSha256 }) }, execution, runtime: projectOpenCodeRuntimeProof(runtime) };
}
