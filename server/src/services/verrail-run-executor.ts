import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  agents,
  heartbeatRuns,
  verrailAgentDefinitions,
  verrailAgentVersions,
  verrailDeployments,
  verrailDeploymentRevisions,
  verrailExecutionLeases,
  verrailRunAttempts,
  verrailRuns,
  verrailTargetRevisions,
  verrailWorkNodes,
  type Db,
} from "@paperclipai/db";
import type { ReportRunEventResponseV1, RunArtifactInputV1 } from "@paperclipai/shared";
import { NativeRunArtifactError, nativeRunArtifactDirectory } from "./verrail-run-artifacts.js";
import type { VerrailDomainApiClient } from "./verrail-domain-api-client.js";

const EXECUTOR_PRINCIPAL_ID = "verrail-host-runner";
const ACTIVE_HEARTBEAT_STATUSES = new Set(["queued", "running", "scheduled_retry"]);
const TERMINAL_HEARTBEAT_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

export interface NativeRunLeaseCandidate {
  workspaceId: string;
  runId: string;
  runAttemptId: string;
  leaseId: string;
  leaseStatus: string;
  attemptStatus: string;
  runStatus: string;
  fencingToken: number;
  lastEventCursor: number;
  attemptUpdatedAt: Date;
  runtimeProfile: string;
  executorPrincipalId: string;
  deploymentRevisionId: string;
  runDeploymentRevisionId: string | null;
  deploymentRevisionState: string;
  deploymentStatus: string;
  deploymentAgentDefinitionId: string;
  agentVersionId: string;
  runAgentVersionId: string | null;
  revisionAgentVersionId: string;
  agentDefinitionId: string;
  agentRuntime: string;
  agentModel: string;
  agentPrompt: string;
  compatibilityAgentId: string | null;
  compatibilityAgentWorkspaceId: string | null;
  compatibilityAgentAdapterType: string | null;
  compatibilityAgentAdapterConfig: Record<string, unknown> | null;
  compatibilityAgentCapabilities: string | null;
  responsibleUserId: string | null;
  targetId: string;
  targetRevisionId: string;
  graphRevisionId: string;
  workNodeId: string;
  workNodeKey: string;
  workNodeTitle: string;
  completionDefinition: string;
  targetTitle: string;
  targetGoal: string;
  targetConstraints: string[];
  targetAcceptanceCriteria: Array<{ id: string; title: string; description: string | null }>;
}

export interface NativeHeartbeatRun {
  id: string;
  agentId: string;
  status: string;
  contextSnapshot: Record<string, unknown> | null;
  usageJson: Record<string, unknown> | null;
  logStore: string | null;
  logRef: string | null;
  logSha256: string | null;
  logBytes: number | null;
  exitCode: number | null;
  errorCode: string | null;
  error: string | null;
}

export interface VerrailRunExecutorStore {
  listCandidates(executorPrincipalId: string): Promise<NativeRunLeaseCandidate[]>;
  findHeartbeatRun(runAttemptId: string): Promise<NativeHeartbeatRun | null>;
}

export interface NativeHeartbeatExecutor {
  invoke(input: {
    agentId: string;
    idempotencyKey: string;
    responsibleUserId: string | null;
    contextSnapshot: Record<string, unknown>;
  }): Promise<NativeHeartbeatRun | null>;
  cancelRun(runId: string, reason: string): Promise<unknown>;
}

type NativeRunEventType = "claimed" | "heartbeat" | "started" | "succeeded" | "failed" | "cancel_acknowledged" | "terminated";

function buildNativeTaskMarkdown(candidate: NativeRunLeaseCandidate) {
  const constraints = candidate.targetConstraints.length > 0
    ? candidate.targetConstraints.map((item) => `- ${item}`).join("\n")
    : "- None recorded.";
  const criteria = candidate.targetAcceptanceCriteria.length > 0
    ? candidate.targetAcceptanceCriteria.map((item) => `- [${item.id}] ${item.title}${item.description ? `: ${item.description}` : ""}`).join("\n")
    : "- None recorded.";
  return [
    `# ${candidate.targetTitle}`,
    "",
    "## Versioned Agent Instructions",
    `AgentVersion: ${candidate.agentVersionId}`,
    candidate.agentPrompt,
    "",
    "## Native Execution Identity",
    `Workspace: ${candidate.workspaceId}`,
    `Target: ${candidate.targetId}`,
    `TargetRevision: ${candidate.targetRevisionId}`,
    `GraphRevision: ${candidate.graphRevisionId}`,
    `WorkNode: ${candidate.workNodeId}`,
    `Run: ${candidate.runId}`,
    `RunAttempt: ${candidate.runAttemptId}`,
    `DeploymentRevision: ${candidate.deploymentRevisionId}`,
    `FencingToken: ${candidate.fencingToken}`,
    "Use these authoritative bindings in generated artifacts; do not infer them from historical runs or other sessions.",
    "",
    "## Native Run Authority",
    "This is a native Verrail Run, not a legacy Issue. Work on the assigned node; do not create substitute Issues or delegate work unless explicitly authorized.",
    "Executor success is not Target Acceptance. Do not issue human Review, ActionApproval or Acceptance decisions, or perform external effects without their required approval.",
    "",
    "## Goal",
    candidate.targetGoal,
    "",
    "## Assigned Work",
    `${candidate.workNodeTitle} (${candidate.workNodeKey})`,
    "",
    "## Completion Definition",
    candidate.completionDefinition,
    "",
    "## Constraints",
    constraints,
    "",
    "## Acceptance Criteria",
    criteria,
    "",
    "## Artifact Output Protocol",
    `For deliverable files, write ${nativeRunArtifactDirectory(candidate.runAttemptId)}/manifest.json relative to the deployment cwd.`,
    'Format: {"schemaVersion":1,"artifacts":[{"title":"Candidate report","kind":"report","path":"report.md"}]}',
    "Store each listed file directly beside the manifest, using a plain ASCII filename (letters, digits, dots, underscores, hyphens; start with a letter or digit).",
    "Allowed kinds: code_change, document, report. Maximum 10 files, 32 MiB per file, 64 MiB total; no links, nested paths, credentials, or secret configuration.",
    "The trusted executor hashes, uploads, and registers these files against this Run and WorkNode. Do not impersonate a human or call Board write APIs to register artifacts.",
  ].join("\n");
}

function validateCandidate(candidate: NativeRunLeaseCandidate, executorPrincipalId: string) {
  if (candidate.executorPrincipalId !== executorPrincipalId || candidate.runtimeProfile !== "host_trusted") {
    return "Lease is not owned by the configured trusted host executor.";
  }
  if (candidate.deploymentRevisionState !== "active" || candidate.deploymentStatus !== "active") {
    return "Deployment and DeploymentRevision must both be active.";
  }
  if (
    candidate.deploymentRevisionId !== candidate.runDeploymentRevisionId
    || candidate.agentVersionId !== candidate.runAgentVersionId
    || candidate.agentVersionId !== candidate.revisionAgentVersionId
  ) {
    return "RunAttempt does not match the Run and DeploymentRevision version binding.";
  }
  if (candidate.deploymentAgentDefinitionId !== candidate.agentDefinitionId) {
    return "Deployment and AgentVersion do not share an AgentDefinition.";
  }
  if (!candidate.compatibilityAgentId || candidate.compatibilityAgentWorkspaceId !== candidate.workspaceId) {
    return "AgentDefinition has no same-workspace compatibility executor.";
  }
  if (candidate.compatibilityAgentAdapterType !== candidate.agentRuntime) {
    return "Versioned runtime does not match the compatibility executor adapter.";
  }
  const configuredModel = typeof candidate.compatibilityAgentAdapterConfig?.model === "string"
    ? candidate.compatibilityAgentAdapterConfig.model.trim()
    : "unconfigured";
  if (candidate.agentModel !== configuredModel) {
    return "Versioned model does not match the compatibility executor model.";
  }
  if (candidate.agentPrompt.trim() !== (candidate.compatibilityAgentCapabilities ?? "").trim()) {
    return "Versioned prompt does not match the compatibility executor capabilities prompt.";
  }
  return null;
}

function executionFacts(run: NativeHeartbeatRun) {
  return {
    heartbeatRunId: run.id,
    heartbeatStatus: run.status,
    agentId: run.agentId,
    logStore: run.logStore,
    logRef: run.logRef,
    logSha256: run.logSha256,
    logBytes: run.logBytes,
    usage: run.usageJson,
    exitCode: run.exitCode,
    errorCode: run.errorCode,
    environmentManifest: run.contextSnapshot?.verrailEnvironmentManifest ?? null,
  };
}

export function createDrizzleVerrailRunExecutorStore(db: Db): VerrailRunExecutorStore {
  return {
    async listCandidates(executorPrincipalId) {
      return db
        .select({
          workspaceId: verrailRunAttempts.workspaceId,
          runId: verrailRunAttempts.runId,
          runAttemptId: verrailRunAttempts.id,
          leaseId: verrailExecutionLeases.id,
          leaseStatus: verrailExecutionLeases.status,
          attemptStatus: verrailRunAttempts.status,
          runStatus: verrailRuns.status,
          fencingToken: verrailRunAttempts.fencingToken,
          lastEventCursor: verrailRunAttempts.lastEventCursor,
          attemptUpdatedAt: verrailRunAttempts.updatedAt,
          runtimeProfile: verrailRunAttempts.runtimeProfile,
          executorPrincipalId: verrailRunAttempts.executorPrincipalId,
          deploymentRevisionId: verrailRunAttempts.deploymentRevisionId,
          runDeploymentRevisionId: verrailRuns.deploymentRevisionId,
          deploymentRevisionState: verrailDeploymentRevisions.state,
          deploymentStatus: verrailDeployments.status,
          deploymentAgentDefinitionId: verrailDeployments.agentDefinitionId,
          agentVersionId: verrailRunAttempts.agentVersionId,
          runAgentVersionId: verrailRuns.agentVersionId,
          revisionAgentVersionId: verrailDeploymentRevisions.agentVersionId,
          agentDefinitionId: verrailAgentVersions.agentDefinitionId,
          agentRuntime: verrailAgentVersions.runtime,
          agentModel: verrailAgentVersions.model,
          agentPrompt: verrailAgentVersions.prompt,
          compatibilityAgentId: verrailAgentDefinitions.compatibilityAgentId,
          compatibilityAgentWorkspaceId: agents.companyId,
          compatibilityAgentAdapterType: agents.adapterType,
          compatibilityAgentAdapterConfig: agents.adapterConfig,
          compatibilityAgentCapabilities: agents.capabilities,
          responsibleUserId: sql<string | null>`case when ${verrailTargetRevisions.outcomeOwnerPrincipalType} = 'user' then ${verrailTargetRevisions.outcomeOwnerPrincipalId} else null end`,
          targetId: verrailRuns.targetId,
          targetRevisionId: verrailRuns.targetRevisionId,
          graphRevisionId: verrailRuns.graphRevisionId,
          workNodeId: verrailRuns.workNodeId,
          workNodeKey: verrailWorkNodes.nodeKey,
          workNodeTitle: verrailWorkNodes.title,
          completionDefinition: verrailWorkNodes.completionDefinition,
          targetTitle: verrailTargetRevisions.title,
          targetGoal: verrailTargetRevisions.goal,
          targetConstraints: verrailTargetRevisions.constraints,
          targetAcceptanceCriteria: verrailTargetRevisions.acceptanceCriteria,
        })
        .from(verrailExecutionLeases)
        .innerJoin(verrailRunAttempts, and(
          eq(verrailRunAttempts.id, verrailExecutionLeases.runAttemptId),
          eq(verrailRunAttempts.workspaceId, verrailExecutionLeases.workspaceId),
        ))
        .innerJoin(verrailRuns, and(
          eq(verrailRuns.id, verrailRunAttempts.runId),
          eq(verrailRuns.workspaceId, verrailRunAttempts.workspaceId),
        ))
        .innerJoin(verrailWorkNodes, and(
          eq(verrailWorkNodes.id, verrailRuns.workNodeId),
          eq(verrailWorkNodes.workspaceId, verrailRuns.workspaceId),
        ))
        .innerJoin(verrailTargetRevisions, and(
          eq(verrailTargetRevisions.id, verrailRuns.targetRevisionId),
          eq(verrailTargetRevisions.workspaceId, verrailRuns.workspaceId),
        ))
        .innerJoin(verrailDeploymentRevisions, and(
          eq(verrailDeploymentRevisions.id, verrailRunAttempts.deploymentRevisionId),
          eq(verrailDeploymentRevisions.workspaceId, verrailRunAttempts.workspaceId),
        ))
        .innerJoin(verrailDeployments, and(
          eq(verrailDeployments.id, verrailDeploymentRevisions.deploymentId),
          eq(verrailDeployments.workspaceId, verrailRunAttempts.workspaceId),
        ))
        .innerJoin(verrailAgentVersions, and(
          eq(verrailAgentVersions.id, verrailRunAttempts.agentVersionId),
          eq(verrailAgentVersions.workspaceId, verrailRunAttempts.workspaceId),
        ))
        .innerJoin(verrailAgentDefinitions, and(
          eq(verrailAgentDefinitions.id, verrailAgentVersions.agentDefinitionId),
          eq(verrailAgentDefinitions.workspaceId, verrailRunAttempts.workspaceId),
        ))
        .leftJoin(agents, eq(agents.id, verrailAgentDefinitions.compatibilityAgentId))
        .where(and(
          eq(verrailExecutionLeases.executorPrincipalId, executorPrincipalId),
          inArray(verrailExecutionLeases.status, ["offered", "active", "suspect"]),
          gt(verrailExecutionLeases.graceExpiresAt, new Date()),
          inArray(verrailRunAttempts.status, ["pending", "running", "cancel_requested", "cancel_acknowledged"]),
        ))
        .orderBy(asc(verrailExecutionLeases.createdAt), asc(verrailExecutionLeases.id));
    },

    async findHeartbeatRun(runAttemptId) {
      return db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          usageJson: heartbeatRuns.usageJson,
          logStore: heartbeatRuns.logStore,
          logRef: heartbeatRuns.logRef,
          logSha256: heartbeatRuns.logSha256,
          logBytes: heartbeatRuns.logBytes,
          exitCode: heartbeatRuns.exitCode,
          errorCode: heartbeatRuns.errorCode,
          error: heartbeatRuns.error,
        })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.contextSnapshot} ->> 'verrailRunAttemptId' = ${runAttemptId}`)
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },
  };
}

export function createVerrailRunExecutor(input: {
  store: VerrailRunExecutorStore;
  domainApi: Pick<VerrailDomainApiClient, "reportRunEvent">;
  heartbeat: NativeHeartbeatExecutor;
  collectArtifacts?: (candidate: NativeRunLeaseCandidate, heartbeatRun: NativeHeartbeatRun) => Promise<RunArtifactInputV1[]>;
  executorPrincipalId?: string;
  leaseExtensionSeconds?: number;
  onError?: (error: unknown, candidate: NativeRunLeaseCandidate) => void;
}) {
  const executorPrincipalId = input.executorPrincipalId ?? EXECUTOR_PRINCIPAL_ID;
  const leaseExtensionSeconds = input.leaseExtensionSeconds ?? 120;
  const inFlight = new Set<string>();

  async function process(candidate: NativeRunLeaseCandidate) {
    let cursor = candidate.lastEventCursor;
    let leaseStatus = candidate.leaseStatus;
    let attemptStatus = candidate.attemptStatus;

    const report = async (
      eventType: NativeRunEventType,
      payload: Record<string, unknown> = {},
      extendLeaseSeconds?: number,
      artifacts?: RunArtifactInputV1[],
    ): Promise<ReportRunEventResponseV1> => {
      const nextCursor = cursor + 1;
      const response = await input.domainApi.reportRunEvent({
        workspaceId: candidate.workspaceId,
        principalType: "service",
        principalId: executorPrincipalId,
        runId: candidate.runId,
        runAttemptId: candidate.runAttemptId,
        idempotencyKey: `verrail-run-attempt:${candidate.runAttemptId}:cursor:${nextCursor}`,
        input: {
          leaseId: candidate.leaseId,
          fencingToken: candidate.fencingToken,
          cursor: nextCursor,
          eventType,
          emittedAt: new Date(candidate.attemptUpdatedAt.getTime() + nextCursor).toISOString(),
          payload,
          ...(artifacts?.length ? { artifacts } : {}),
          ...(extendLeaseSeconds ? { extendLeaseSeconds } : {}),
        },
      });
      if (!response.authoritative) {
        throw new Error(`Native Run event ${eventType} rejected: ${response.rejectionCode ?? "UNKNOWN"}`);
      }
      cursor = response.cursor;
      leaseStatus = response.leaseStatus;
      attemptStatus = response.attemptStatus;
      return response;
    };

    let heartbeatRun = await input.store.findHeartbeatRun(candidate.runAttemptId);

    if (candidate.runStatus === "cancel_requested" || attemptStatus === "cancel_requested" || attemptStatus === "cancel_acknowledged") {
      if (heartbeatRun && ACTIVE_HEARTBEAT_STATUSES.has(heartbeatRun.status)) {
        await input.heartbeat.cancelRun(heartbeatRun.id, `Native Run ${candidate.runId} requested cancellation`);
        heartbeatRun = await input.store.findHeartbeatRun(candidate.runAttemptId);
      }
      if (attemptStatus === "cancel_requested") {
        await report("cancel_acknowledged", heartbeatRun ? executionFacts(heartbeatRun) : {});
      }
      if (!heartbeatRun || TERMINAL_HEARTBEAT_STATUSES.has(heartbeatRun.status)) {
        await report("terminated", heartbeatRun ? executionFacts(heartbeatRun) : { heartbeatRunId: null });
        return "terminated" as const;
      }
      return "canceling" as const;
    }

    if (leaseStatus === "offered") {
      await report("claimed", { executorPrincipalId, runtimeProfile: candidate.runtimeProfile });
    } else if (leaseStatus === "suspect") {
      await report("heartbeat", { heartbeatRunId: heartbeatRun?.id ?? null }, leaseExtensionSeconds);
    }

    const validationError = validateCandidate(candidate, executorPrincipalId);
    if (validationError) {
      await report("failed", {
        errorCode: "NATIVE_EXECUTION_IDENTITY_INVALID",
        errorMessage: validationError,
      });
      return "failed" as const;
    }

    if (!heartbeatRun) {
      heartbeatRun = await input.heartbeat.invoke({
        agentId: candidate.compatibilityAgentId!,
        idempotencyKey: `verrail-run-attempt:${candidate.runAttemptId}`,
        responsibleUserId: candidate.responsibleUserId,
        contextSnapshot: {
          verrailRunAttemptId: candidate.runAttemptId,
          verrailRunId: candidate.runId,
          verrailTargetId: candidate.targetId,
          verrailTargetRevisionId: candidate.targetRevisionId,
          verrailGraphRevisionId: candidate.graphRevisionId,
          verrailWorkNodeId: candidate.workNodeId,
          verrailDeploymentRevisionId: candidate.deploymentRevisionId,
          verrailAgentVersionId: candidate.agentVersionId,
          taskKey: `verrail:run:${candidate.runId}`,
          responsibleUserId: candidate.responsibleUserId,
          verrailTaskMarkdown: buildNativeTaskMarkdown(candidate),
        },
      });
      if (!heartbeatRun) {
        await report("failed", {
          errorCode: "HEARTBEAT_DISPATCH_SKIPPED",
          errorMessage: "Trusted heartbeat executor did not create a run.",
        });
        return "failed" as const;
      }
    }

    if (heartbeatRun.status === "succeeded") {
      if (attemptStatus === "pending") {
        await report("started", { heartbeatRunId: heartbeatRun.id, agentId: heartbeatRun.agentId });
      }
      let artifacts: RunArtifactInputV1[] | undefined;
      try {
        artifacts = await input.collectArtifacts?.(candidate, heartbeatRun);
      } catch (error) {
        if (!(error instanceof NativeRunArtifactError)) throw error;
        await report("failed", { ...executionFacts(heartbeatRun), errorCode: "NATIVE_ARTIFACT_INVALID", errorMessage: error.message });
        return "failed" as const;
      }
      await report("succeeded", executionFacts(heartbeatRun), undefined, artifacts);
      return "succeeded" as const;
    }
    if (TERMINAL_HEARTBEAT_STATUSES.has(heartbeatRun.status)) {
      await report("failed", {
        ...executionFacts(heartbeatRun),
        errorCode: heartbeatRun.errorCode ?? "HEARTBEAT_EXECUTION_FAILED",
        errorMessage: heartbeatRun.error ?? `Heartbeat run ended with status ${heartbeatRun.status}.`,
      });
      return "failed" as const;
    }

    if (attemptStatus === "pending" && heartbeatRun.status === "running") {
      await report("started", { heartbeatRunId: heartbeatRun.id, agentId: heartbeatRun.agentId });
      return "started" as const;
    }

    await report("heartbeat", { heartbeatRunId: heartbeatRun.id, heartbeatStatus: heartbeatRun.status }, leaseExtensionSeconds);
    return "renewed" as const;
  }

  return {
    async tick() {
      const candidates = await input.store.listCandidates(executorPrincipalId);
      const result = { checked: candidates.length, processed: 0, started: 0, renewed: 0, succeeded: 0, failed: 0, canceling: 0, terminated: 0, errors: 0 };
      for (const candidate of candidates) {
        if (inFlight.has(candidate.runAttemptId)) continue;
        inFlight.add(candidate.runAttemptId);
        try {
          const outcome = await process(candidate);
          result.processed += 1;
          result[outcome] += 1;
        } catch (error) {
          result.errors += 1;
          input.onError?.(error, candidate);
        } finally {
          inFlight.delete(candidate.runAttemptId);
        }
      }
      return result;
    },
  };
}
