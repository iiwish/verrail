import { createHash, randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  verrailAgentDefinitions,
  verrailAgentVersions,
  verrailDeploymentRevisions,
  verrailDeployments,
  verrailEvaluationRuns,
  verrailAuditEvents,
} from "@paperclipai/db";
import {
  AGENT_LIFECYCLE_SCHEMA_VERSION,
  type AgentLifecycleReadModelV1,
  type AgentVersionV1,
  type DeploymentRevisionV1,
  type DeploymentV1,
  type EvaluationRunV1,
} from "@paperclipai/shared";

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function agentLifecycleService(db: Db) {
  return {
    async ensurePausedDefault(workspaceId: string): Promise<string> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId + "\ndefault-deployment"}, 0))`);
        const existing = await tx.select({ id: verrailDeployments.id }).from(verrailDeployments).where(eq(verrailDeployments.workspaceId, workspaceId)).then((rows) => rows.find((row) => row.id) ?? null);
        const currentDefault = await tx.select({ id: verrailDeployments.id, isDefault: verrailDeployments.isDefault }).from(verrailDeployments).where(eq(verrailDeployments.workspaceId, workspaceId)).then((rows) => rows.find((row) => row.isDefault) ?? null);
        if (currentDefault) return currentDefault.id;
        if (existing) {
          await tx.update(verrailDeployments).set({ isDefault: true, updatedAt: new Date() }).where(eq(verrailDeployments.id, existing.id));
          return existing.id;
        }
        const compatibilityAgent = await tx.select().from(agents).where(eq(agents.companyId, workspaceId)).orderBy(asc(agents.createdAt)).then((rows) => rows[0] ?? null);
        const definitionId = randomUUID();
        const versionId = randomUUID();
        const evaluationId = randomUUID();
        const deploymentId = randomUUID();
        const revisionId = randomUUID();
        const runtime = compatibilityAgent?.adapterType ?? "unconfigured";
        const model = typeof compatibilityAgent?.adapterConfig?.model === "string" ? compatibilityAgent.adapterConfig.model : "unconfigured";
        const prompt = compatibilityAgent?.capabilities ?? "Compatibility snapshot. Publish a governed version before production use.";
        const contentHash = createHash("sha256").update(JSON.stringify({ runtime, model, prompt, compatibilityAgentId: compatibilityAgent?.id ?? null })).digest("hex");
        await tx.insert(verrailAgentDefinitions).values({ id: definitionId, workspaceId, compatibilityAgentId: compatibilityAgent?.id ?? null, name: compatibilityAgent?.name ?? "Workspace Director", description: "Compatibility snapshot imported as a paused default identity; evaluate before activation.", status: "published", createdByPrincipalType: "service", createdByPrincipalId: "workspace-provisioner" });
        await tx.insert(verrailAgentVersions).values({ id: versionId, workspaceId, agentDefinitionId: definitionId, versionNumber: 1, runtime, model, prompt, skills: [], tools: [], outputSchema: {}, capabilityCeiling: [], supplyChain: { compatibilityImport: true, compatibilityAgentId: compatibilityAgent?.id ?? null }, contentHash, createdByPrincipalType: "service", createdByPrincipalId: "workspace-provisioner" });
        await tx.insert(verrailEvaluationRuns).values({ id: evaluationId, workspaceId, candidateAgentVersionId: versionId, status: "inconclusive", safetyStatus: "not_run", summary: "Compatibility import is intentionally not a passing production evaluation.", createdByPrincipalType: "service", createdByPrincipalId: "workspace-provisioner" });
        await tx.insert(verrailDeployments).values({ id: deploymentId, workspaceId, agentDefinitionId: definitionId, name: "Workspace default", status: "paused", isDefault: true, createdByPrincipalType: "service", createdByPrincipalId: "workspace-provisioner" });
        await tx.insert(verrailDeploymentRevisions).values({ id: revisionId, workspaceId, deploymentId, revisionNumber: 1, agentVersionId: versionId, evaluationRunId: evaluationId, state: "paused", runtimeConfig: {}, contentHash, createdByPrincipalType: "service", createdByPrincipalId: "workspace-provisioner" });
        await tx.insert(verrailAuditEvents).values({ id: randomUUID(), workspaceId, principalType: "service", principalId: "workspace-provisioner", eventType: "deployment.default_provisioned", aggregateType: "deployment", aggregateId: deploymentId, idempotencyKey: `workspace-default:${workspaceId}`, payload: { schemaVersion: 1, deploymentId, state: "paused" } });
        return deploymentId;
      });
    },
    async getWorkspace(workspaceId: string): Promise<AgentLifecycleReadModelV1> {
      const [definitions, versions, evaluations, deployments, revisions] = await Promise.all([
        db.select().from(verrailAgentDefinitions).where(eq(verrailAgentDefinitions.workspaceId, workspaceId)).orderBy(asc(verrailAgentDefinitions.name)),
        db.select().from(verrailAgentVersions).where(eq(verrailAgentVersions.workspaceId, workspaceId)).orderBy(asc(verrailAgentVersions.versionNumber)),
        db.select().from(verrailEvaluationRuns).where(eq(verrailEvaluationRuns.workspaceId, workspaceId)).orderBy(asc(verrailEvaluationRuns.createdAt)),
        db.select().from(verrailDeployments).where(eq(verrailDeployments.workspaceId, workspaceId)).orderBy(asc(verrailDeployments.name)),
        db.select().from(verrailDeploymentRevisions).where(eq(verrailDeploymentRevisions.workspaceId, workspaceId)).orderBy(asc(verrailDeploymentRevisions.revisionNumber)),
      ]);

      const mappedVersions: AgentVersionV1[] = versions.map((version) => ({
        id: version.id,
        workspaceId: version.workspaceId,
        agentDefinitionId: version.agentDefinitionId,
        versionNumber: version.versionNumber,
        runtime: version.runtime,
        model: version.model,
        prompt: version.prompt,
        skills: version.skills,
        tools: version.tools,
        outputSchema: version.outputSchema,
        capabilityCeiling: version.capabilityCeiling,
        supplyChain: version.supplyChain,
        contentHash: version.contentHash,
        createdAt: iso(version.createdAt),
      }));
      const mappedEvaluations: EvaluationRunV1[] = evaluations.map((evaluation) => ({
        id: evaluation.id,
        workspaceId: evaluation.workspaceId,
        candidateAgentVersionId: evaluation.candidateAgentVersionId,
        baselineAgentVersionId: evaluation.baselineAgentVersionId,
        status: evaluation.status as EvaluationRunV1["status"],
        qualityScore: evaluation.qualityScore,
        costCents: evaluation.costCents,
        latencyMs: evaluation.latencyMs,
        safetyStatus: evaluation.safetyStatus as EvaluationRunV1["safetyStatus"],
        summary: evaluation.summary,
        createdAt: iso(evaluation.createdAt),
      }));
      const mappedRevisions: DeploymentRevisionV1[] = revisions.map((revision) => ({
        id: revision.id,
        workspaceId: revision.workspaceId,
        deploymentId: revision.deploymentId,
        revisionNumber: revision.revisionNumber,
        agentVersionId: revision.agentVersionId,
        evaluationRunId: revision.evaluationRunId,
        state: revision.state as DeploymentRevisionV1["state"],
        runtimeConfig: revision.runtimeConfig,
        contentHash: revision.contentHash,
        createdAt: iso(revision.createdAt),
      }));
      const mappedDeployments: DeploymentV1[] = deployments.map((deployment) => {
        const deploymentRevisions = mappedRevisions.filter((revision) => revision.deploymentId === deployment.id);
        return {
          id: deployment.id,
          workspaceId: deployment.workspaceId,
          agentDefinitionId: deployment.agentDefinitionId,
          name: deployment.name,
          status: deployment.status as DeploymentV1["status"],
          isDefault: deployment.isDefault,
          activeRevision: deploymentRevisions.at(-1) ?? null,
          revisions: deploymentRevisions,
          createdAt: iso(deployment.createdAt),
          updatedAt: iso(deployment.updatedAt),
        };
      });

      return {
        schemaVersion: AGENT_LIFECYCLE_SCHEMA_VERSION,
        workspaceId,
        generatedAt: new Date().toISOString(),
        defaultDeploymentId: mappedDeployments.find((deployment) => deployment.isDefault)?.id ?? null,
        definitions: definitions.map((definition) => ({
          id: definition.id,
          workspaceId: definition.workspaceId,
          compatibilityAgentId: definition.compatibilityAgentId,
          name: definition.name,
          description: definition.description,
          status: definition.status as "draft" | "published" | "retired",
          versions: mappedVersions.filter((version) => version.agentDefinitionId === definition.id),
          evaluations: mappedEvaluations.filter((evaluation) => mappedVersions.some((version) => version.agentDefinitionId === definition.id && version.id === evaluation.candidateAgentVersionId)),
          deployments: mappedDeployments.filter((deployment) => deployment.agentDefinitionId === definition.id),
          createdAt: iso(definition.createdAt),
          updatedAt: iso(definition.updatedAt),
        })),
      };
    },
  };
}
