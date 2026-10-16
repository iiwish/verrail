import { and, eq } from "drizzle-orm";
import { type Db, verrailRuns, verrailAgentVersions, verrailTargetRevisions, verrailWorkNodes } from "@paperclipai/db";
import { repositoryExecutionRequestSchema, type RepositoryExecutionRequest } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { loadBoundRepositorySource } from "./repository-bound-source.js";
import { createRepositoryOfferedLeaseValidator } from "./repository-lease.js";

export const repositoryAttemptIdentitySchema = repositoryExecutionRequestSchema.pick({ workspaceId: true, runId: true, runAttemptId: true,
  targetId: true, targetRevisionId: true, graphRevisionId: true, workNodeId: true,
  leaseId: true, fencingToken: true, agentVersionId: true, deploymentRevisionId: true });
type Identity = Pick<RepositoryExecutionRequest, keyof typeof repositoryAttemptIdentitySchema.shape>;

export async function buildOfferedRepositoryRequest(options: {
  db: Db; storage: Pick<StorageService, "getObject">; identity: Identity; signal: AbortSignal;
  timeoutSeconds: number; output: RepositoryExecutionRequest["output"];
}) {
  const identity = repositoryAttemptIdentitySchema.parse(options.identity);
  const { db, signal } = options;
  signal.throwIfAborted();
  const [context] = await db.select({ runtime: verrailAgentVersions.runtime, model: verrailAgentVersions.model,
    prompt: verrailAgentVersions.prompt, title: verrailTargetRevisions.title, goal: verrailTargetRevisions.goal,
    constraints: verrailTargetRevisions.constraints, acceptanceCriteria: verrailTargetRevisions.acceptanceCriteria,
    nodeTitle: verrailWorkNodes.title, completionDefinition: verrailWorkNodes.completionDefinition })
    .from(verrailRuns)
    .innerJoin(verrailAgentVersions, and(eq(verrailAgentVersions.id, verrailRuns.agentVersionId), eq(verrailAgentVersions.workspaceId, verrailRuns.workspaceId)))
    .innerJoin(verrailTargetRevisions, and(eq(verrailTargetRevisions.id, verrailRuns.targetRevisionId), eq(verrailTargetRevisions.workspaceId, verrailRuns.workspaceId), eq(verrailTargetRevisions.targetId, verrailRuns.targetId)))
    .innerJoin(verrailWorkNodes, and(eq(verrailWorkNodes.id, verrailRuns.workNodeId), eq(verrailWorkNodes.workspaceId, verrailRuns.workspaceId), eq(verrailWorkNodes.graphRevisionId, verrailRuns.graphRevisionId)))
    .where(and(eq(verrailRuns.id, identity.runId), eq(verrailRuns.workspaceId, identity.workspaceId),
      eq(verrailRuns.agentVersionId, identity.agentVersionId), eq(verrailRuns.deploymentRevisionId, identity.deploymentRevisionId),
      eq(verrailRuns.targetRevisionId, identity.targetRevisionId), eq(verrailRuns.targetId, identity.targetId),
      eq(verrailRuns.graphRevisionId, identity.graphRevisionId), eq(verrailRuns.workNodeId, identity.workNodeId))).limit(1);
  signal.throwIfAborted();
  if (!context) throw new Error("REPOSITORY_RUN_INPUT_UNAVAILABLE");
  const manifest = await loadBoundRepositorySource({ db, storage: options.storage, request: identity, signal });
  const request = repositoryExecutionRequestSchema.parse({ schemaVersion: 1, kind: "target_repository_execution", ...identity,
    source: { artifactId: manifest.source.artifactId, contentHash: manifest.source.contentHash,
      baseCommit: manifest.baseCommit, format: "git_bundle" }, runtime: context.runtime, model: context.model,
    instructions: `${context.prompt}\n\nTarget work input:\n${JSON.stringify({ title: context.title, goal: context.goal,
      constraints: context.constraints, acceptanceCriteria: context.acceptanceCriteria,
      task: context.nodeTitle, completionDefinition: context.completionDefinition })}`,
    timeoutSeconds: options.timeoutSeconds, output: options.output });
  await createRepositoryOfferedLeaseValidator(db)(request, signal);
  return request;
}
