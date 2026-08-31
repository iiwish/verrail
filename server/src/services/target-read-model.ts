import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  caseIssueLinks,
  cases,
  companyMemberships,
  companies,
  heartbeatRuns,
  issues,
  projects,
  targetProjectionRevisions,
  targetProjectionSources,
  verrailTargetRevisions,
  verrailTargets,
} from "@paperclipai/db";
import {
  TARGET_PROJECTION_POLICY_VERSION,
  TARGET_READ_MODEL_SCHEMA_VERSION,
  TARGET_STATUSES,
  isPluginOperationIssueOriginKind,
  parseStoredTargetReadModelV1,
  type RegisterTargetProjectionInput,
  type TargetReadModelV1,
  type TargetRiskLevel,
  type TargetSourceType,
  type TargetStageKey,
  type TargetStatus,
} from "@paperclipai/shared";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";

const TARGET_NAMESPACE = "91552506-d624-4f00-97cc-e5b6f4dff680";
const TARGET_REVISION_NAMESPACE = "ae165b56-f7dd-4ce7-af56-8c5896162dd3";
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const RISK_LEVELS = new Set<TargetRiskLevel>(["low", "medium", "high", "critical"]);
const SYSTEM_ISSUE_ORIGINS = new Set([
  "routine_execution",
  "harness_liveness_escalation",
  "stale_active_run_evaluation",
  "task_watchdog",
  "task_watchdog_product_bug",
  "issue_productivity_review",
  "stranded_issue_recovery",
  "onboarding_first_task",
  "built_in_agent_bundle",
  "skill_test",
  "pipeline_case_conversation",
  "pipeline_automation",
]);
const reportedProjectionProblems = new Set<string>();

type ProjectionDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function uuidBytes(value: string) {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

export function targetProjectionUuidV5(namespace: string, name: string) {
  const digest = createHash("sha1").update(uuidBytes(namespace)).update(name, "utf8").digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceTargetId(workspaceId: string, sourceType: TargetSourceType, sourceId: string) {
  return targetProjectionUuidV5(
    TARGET_NAMESPACE,
    `${workspaceId.toLowerCase()}\n${sourceType}\n${sourceId.toLowerCase()}`,
  );
}

function targetRevisionId(
  targetId: string,
  sourceRevisionKey: string,
  sourceSnapshotHash: string,
) {
  return targetProjectionUuidV5(
    TARGET_REVISION_NAMESPACE,
    `${targetId}\n${TARGET_PROJECTION_POLICY_VERSION}\n${sourceRevisionKey}\n${sourceSnapshotHash}`,
  );
}

function stageForStatus(status: TargetStatus): { key: TargetStageKey; label: string } | null {
  if (status === "draft" || status === "ready") return { key: "define", label: "Define" };
  if (status === "active") return { key: "execute", label: "Execute" };
  if (status === "verifying") return { key: "verify", label: "Verify" };
  if (status === "awaiting_acceptance" || status === "accepted") return { key: "accept", label: "Accept" };
  return { key: "unknown", label: "Unknown" };
}

function withCompatibilityWarning(model: TargetReadModelV1, warning: string): TargetReadModelV1 {
  if (!model.compatibility) return model;
  return {
    ...model,
    compatibility: {
      ...model.compatibility,
      warnings: [...new Set([...model.compatibility.warnings, warning])],
    },
  };
}

function mapCaseStatus(status: string): { status: TargetStatus; completionUnverified: boolean } {
  if (status === "draft") return { status: "draft", completionUnverified: false };
  if (status === "in_progress") return { status: "active", completionUnverified: false };
  if (status === "in_review") return { status: "verifying", completionUnverified: false };
  if (status === "approved" || status === "done") {
    return { status: "awaiting_acceptance", completionUnverified: status === "done" };
  }
  if (status === "cancelled") return { status: "canceled", completionUnverified: false };
  throw unprocessable("Unsupported Case status for Target projection", { status });
}

function mapIssueStatus(status: string): { status: TargetStatus; completionUnverified: boolean } {
  if (status === "backlog") return { status: "draft", completionUnverified: false };
  if (status === "todo") return { status: "ready", completionUnverified: false };
  if (status === "in_progress") return { status: "active", completionUnverified: false };
  if (status === "in_review") return { status: "verifying", completionUnverified: false };
  if (status === "blocked") return { status: "blocked", completionUnverified: false };
  if (status === "done") return { status: "awaiting_acceptance", completionUnverified: true };
  if (status === "cancelled") return { status: "canceled", completionUnverified: false };
  throw unprocessable("Unsupported Issue status for Target projection", { status });
}

function riskFromFields(fields: Record<string, unknown> | null | undefined): TargetRiskLevel {
  const value = fields?.riskLevel;
  return typeof value === "string" && RISK_LEVELS.has(value as TargetRiskLevel)
    ? value as TargetRiskLevel
    : "unknown";
}

function ownerFromFields(fields: Record<string, unknown> | null | undefined) {
  const value = fields?.outcomeOwner;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if ((owner.principalType !== "user" && owner.principalType !== "agent") || typeof owner.principalId !== "string") {
    return null;
  }
  return {
    principalType: owner.principalType,
    principalId: owner.principalId,
    displayName: typeof owner.displayName === "string" ? owner.displayName : null,
  } as const;
}

async function assertOutcomeOwnerMembership(
  db: ProjectionDb,
  workspaceId: string,
  owner: NonNullable<TargetReadModelV1["outcomeOwner"]>,
) {
  const exists = owner.principalType === "user"
    ? await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, workspaceId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, owner.principalId),
        eq(companyMemberships.status, "active"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null)
    : await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, workspaceId), eq(agents.id, owner.principalId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  if (!exists) {
    throw unprocessable("Target outcome owner does not belong to the source Workspace");
  }
}

function compatibilitySourceHref(
  workspacePrefix: string,
  sourceType: TargetSourceType,
  identifier: string | null,
  sourceId: string,
) {
  return `/${encodeURIComponent(workspacePrefix)}/${sourceType === "case" ? "cases" : "issues"}/${encodeURIComponent(identifier ?? sourceId)}`;
}

function projectionUnavailable(targetId: string, reason = "snapshot_missing_or_invalid") {
  return new HttpError(503, "Target projection unavailable", {
    code: "TARGET_PROJECTION_UNAVAILABLE",
    retryable: true,
    targetId,
    reason,
  });
}

interface StoredProjectionIdentity {
  workspaceId: string;
  targetId: string;
  targetRevisionId: string;
  schemaVersion: string;
  projectionPolicyVersion: string;
  sourceRevisionKey: string;
  sourceType?: string;
  sourceId?: string;
}

function reportProjectionProblemOnce(
  code: "legacy_projection_upgraded" | "invalid_projection_snapshot",
  identity: StoredProjectionIdentity,
  detail: Record<string, unknown> = {},
) {
  const key = `${code}:${identity.workspaceId}:${identity.targetRevisionId}`;
  if (reportedProjectionProblems.has(key)) return;
  if (reportedProjectionProblems.size >= 1_000) reportedProjectionProblems.clear();
  reportedProjectionProblems.add(key);
  logger.warn({
    code,
    workspaceId: identity.workspaceId,
    targetId: identity.targetId,
    targetRevisionId: identity.targetRevisionId,
    ...detail,
  }, code === "legacy_projection_upgraded"
    ? "legacy Target projection normalized in memory; operator reconciliation is recommended"
    : "invalid Target projection isolated from read results");
}

function parseStoredCompatibilityProjection(
  value: unknown,
  identity: StoredProjectionIdentity,
): TargetReadModelV1 | null {
  let parsed: ReturnType<typeof parseStoredTargetReadModelV1>;
  try {
    parsed = parseStoredTargetReadModelV1(value);
  } catch (error) {
    reportProjectionProblemOnce("invalid_projection_snapshot", identity, {
      reason: "schema_validation_failed",
      validationError: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }

  const { model } = parsed;
  const mismatches: string[] = [];
  if (model.workspaceId !== identity.workspaceId) mismatches.push("workspace_id");
  if (model.targetId !== identity.targetId) mismatches.push("target_id");
  if (model.activeTargetRevisionId !== identity.targetRevisionId) mismatches.push("target_revision_id");
  if (String(model.schemaVersion) !== identity.schemaVersion) mismatches.push("schema_version");
  if (model.projectionPolicyVersion !== identity.projectionPolicyVersion) mismatches.push("projection_policy_version");
  if (model.source.revisionKey !== identity.sourceRevisionKey) mismatches.push("source_revision_key");
  if (model.authority.kind !== "compatibility") mismatches.push("authority");
  if (model.source.type === "native") mismatches.push("source_type");
  if (identity.sourceType && model.source.type !== identity.sourceType) mismatches.push("source_type");
  if (identity.sourceId && model.source.id !== identity.sourceId) mismatches.push("source_id");
  if (mismatches.length > 0) {
    reportProjectionProblemOnce("invalid_projection_snapshot", identity, {
      reason: "relational_identity_mismatch",
      mismatches,
    });
    return null;
  }

  if (parsed.upgradedFrom) {
    reportProjectionProblemOnce("legacy_projection_upgraded", identity, {
      upgradedFrom: parsed.upgradedFrom,
    });
  }
  return model;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function projectionHash(value: Omit<TargetReadModelV1, "activeTargetRevisionId" | "projectedAt">) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function issueIdsForSource(db: ProjectionDb, sourceType: TargetSourceType, sourceId: string) {
  if (sourceType === "issue") return [sourceId];
  return db
    .select({ issueId: caseIssueLinks.issueId })
    .from(caseIssueLinks)
    .where(and(eq(caseIssueLinks.caseId, sourceId), inArray(caseIssueLinks.role, ["origin", "work"])))
    .then((rows) => rows.map((row) => row.issueId));
}

async function assertCaseIssueMemberships(
  db: ProjectionDb,
  workspaceId: string,
  caseId: string,
  issueIds: string[],
) {
  if (issueIds.length === 0) return;
  const sourceIssues = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, workspaceId), inArray(issues.id, issueIds)));
  if (sourceIssues.length !== new Set(issueIds).size) {
    throw unprocessable("Case contains a cross-Workspace or missing Issue");
  }
  const memberships = await db
    .select({ issueId: caseIssueLinks.issueId, caseId: caseIssueLinks.caseId })
    .from(caseIssueLinks)
    .where(and(
      inArray(caseIssueLinks.issueId, issueIds),
      inArray(caseIssueLinks.role, ["origin", "work"]),
    ));
  if (memberships.some((membership) => membership.caseId !== caseId)) {
    throw conflict("Case contains an Issue with ambiguous Target membership");
  }
}

async function runSummary(db: ProjectionDb, workspaceId: string, issueIds: string[]) {
  if (issueIds.length === 0) {
    return { active: 0, failed: 0, latestRunId: null, latestRunAt: null };
  }
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, workspaceId),
      inArray(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, issueIds),
    ))
    .orderBy(desc(heartbeatRuns.createdAt));
  return {
    active: rows.filter((row) => ACTIVE_RUN_STATUSES.has(row.status)).length,
    failed: rows.filter((row) => FAILED_RUN_STATUSES.has(row.status)).length,
    latestRunId: rows[0]?.id ?? null,
    latestRunAt: rows[0]?.createdAt.toISOString() ?? null,
  };
}

async function blockedAttention(db: ProjectionDb, workspaceId: string, issueIds: string[]) {
  if (issueIds.length === 0) return { total: 0, highestSeverity: null };
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, workspaceId),
      inArray(issues.id, issueIds),
      eq(issues.status, "blocked"),
    ));
  return { total: rows.length, highestSeverity: rows.length > 0 ? "high" : null };
}

async function loadCaseProjectionSource(db: ProjectionDb, workspaceId: string, sourceId: string) {
  return db
    .select({
      id: cases.id,
      workspaceId: cases.companyId,
      projectId: cases.projectId,
      projectName: projects.name,
      workspacePrefix: companies.issuePrefix,
      identifier: cases.identifier,
      title: cases.title,
      summary: cases.summary,
      status: cases.status,
      fields: cases.fields,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .innerJoin(companies, eq(companies.id, cases.companyId))
    .leftJoin(projects, and(eq(projects.id, cases.projectId), eq(projects.companyId, cases.companyId)))
    .where(and(eq(cases.companyId, workspaceId), eq(cases.id, sourceId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function loadIssueProjectionSource(db: ProjectionDb, workspaceId: string, sourceId: string) {
  return db
    .select({
      id: issues.id,
      workspaceId: issues.companyId,
      projectId: issues.projectId,
      projectName: projects.name,
      workspacePrefix: companies.issuePrefix,
      identifier: issues.identifier,
      title: issues.title,
      summary: issues.description,
      status: issues.status,
      parentId: issues.parentId,
      originKind: issues.originKind,
      responsibleUserId: issues.responsibleUserId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(companies, eq(companies.id, issues.companyId))
    .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
    .where(and(eq(issues.companyId, workspaceId), eq(issues.id, sourceId), isNull(issues.hiddenAt)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function assertIndependentIssueEligibility(db: ProjectionDb, issue: {
  id: string;
  parentId: string | null;
  originKind: string;
  projectId: string | null;
  responsibleUserId: string | null;
}) {
  if (issue.parentId) throw unprocessable("A child Issue cannot be mapped as an independent Target");
  if (SYSTEM_ISSUE_ORIGINS.has(issue.originKind)) {
    throw unprocessable("A system-derived Issue cannot be mapped as a Target", { originKind: issue.originKind });
  }
  if (isPluginOperationIssueOriginKind(issue.originKind)) {
    throw unprocessable("A plugin operation Issue cannot be mapped as a Target", { originKind: issue.originKind });
  }
  const membership = await db
    .select({ id: caseIssueLinks.id })
    .from(caseIssueLinks)
    .where(and(eq(caseIssueLinks.issueId, issue.id), inArray(caseIssueLinks.role, ["origin", "work"])))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (membership) throw conflict("Issue already belongs to a Case Target");
  if (!issue.projectId) {
    throw unprocessable("An independent Issue Target requires an explicit Project");
  }
  if (!issue.responsibleUserId) {
    throw unprocessable("An independent Issue Target requires an explicit outcome owner");
  }
}

async function buildProjection(
  db: ProjectionDb,
  workspaceId: string,
  sourceType: TargetSourceType,
  sourceId: string,
) {
  const now = new Date();
  const targetId = sourceTargetId(workspaceId, sourceType, sourceId);
  const missingFields = [
    "acceptanceCriteria",
    "artifactSummary.latestRevisionId",
    "evidenceSummary",
  ];

  if (sourceType === "case") {
    const source = await loadCaseProjectionSource(db, workspaceId, sourceId);
    if (!source) throw notFound("Case source not found");
    if (source.projectId && !source.projectName) {
      throw unprocessable("Case Project does not belong to the source Workspace");
    }
    const mapped = mapCaseStatus(source.status);
    const owner = ownerFromFields(source.fields);
    const risk = riskFromFields(source.fields);
    if (!owner) missingFields.push("outcomeOwner");
    else await assertOutcomeOwnerMembership(db, workspaceId, owner);
    if (risk === "unknown") missingFields.push("risk");
    const issueIds = await issueIdsForSource(db, sourceType, sourceId);
    await assertCaseIssueMemberships(db, workspaceId, sourceId, issueIds);
    const [attentionSummary, runs] = await Promise.all([
      blockedAttention(db, workspaceId, issueIds),
      runSummary(db, workspaceId, issueIds),
    ]);
    const sourceRevisionKey = source.updatedAt.toISOString();
    const base = {
      schemaVersion: TARGET_READ_MODEL_SCHEMA_VERSION,
      projectionPolicyVersion: TARGET_PROJECTION_POLICY_VERSION,
      targetId,
      workspaceId,
      authority: { kind: "compatibility" as const, writer: "typescript-compatibility" as const },
      project: source.projectId && source.projectName ? { id: source.projectId, name: source.projectName } : null,
      source: {
        type: sourceType,
        id: source.id,
        identifier: source.identifier,
        href: compatibilitySourceHref(source.workspacePrefix, sourceType, source.identifier, source.id),
        updatedAt: source.updatedAt.toISOString(),
        revisionKey: sourceRevisionKey,
      },
      title: source.title,
      summary: source.summary,
      status: mapped.status,
      outcomeOwner: owner,
      currentStage: stageForStatus(mapped.status),
      risk: { level: risk },
      attentionSummary,
      artifactSummary: { count: 0, latestRevisionId: null },
      evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" as const },
      runSummary: runs,
      definition: null,
      compatibility: {
        readOnly: true as const,
        completionUnverified: mapped.completionUnverified,
        missingFields,
        warnings: [],
      },
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    };
    const sourceSnapshotHash = projectionHash(base);
    const activeTargetRevisionId = targetRevisionId(targetId, sourceRevisionKey, sourceSnapshotHash);
    return {
      sourceRevisionKey,
      sourceSnapshotHash,
      model: { ...base, activeTargetRevisionId, projectedAt: now.toISOString() } satisfies TargetReadModelV1,
      projectedAt: now,
    };
  }

  const source = await loadIssueProjectionSource(db, workspaceId, sourceId);
  if (!source) throw notFound("Issue source not found");
  if (source.projectId && !source.projectName) {
    throw unprocessable("Issue Project does not belong to the source Workspace");
  }
  await assertIndependentIssueEligibility(db, source);
  const mapped = mapIssueStatus(source.status);
  const owner = {
    principalType: "user" as const,
    principalId: source.responsibleUserId!,
    displayName: null,
  };
  await assertOutcomeOwnerMembership(db, workspaceId, owner);
  missingFields.push("risk");
  const issueIds = [sourceId];
  const [attentionSummary, runs] = await Promise.all([
    blockedAttention(db, workspaceId, issueIds),
    runSummary(db, workspaceId, issueIds),
  ]);
  const sourceRevisionKey = source.updatedAt.toISOString();
  const base = {
    schemaVersion: TARGET_READ_MODEL_SCHEMA_VERSION,
    projectionPolicyVersion: TARGET_PROJECTION_POLICY_VERSION,
    targetId,
    workspaceId,
    authority: { kind: "compatibility" as const, writer: "typescript-compatibility" as const },
    project: source.projectId && source.projectName ? { id: source.projectId, name: source.projectName } : null,
    source: {
      type: sourceType,
      id: source.id,
      identifier: source.identifier,
      href: compatibilitySourceHref(source.workspacePrefix, sourceType, source.identifier, source.id),
      updatedAt: source.updatedAt.toISOString(),
      revisionKey: sourceRevisionKey,
    },
    title: source.title,
    summary: source.summary,
    status: mapped.status,
    outcomeOwner: owner,
    currentStage: stageForStatus(mapped.status),
    risk: { level: "unknown" as const },
    attentionSummary,
    artifactSummary: { count: 0, latestRevisionId: null },
    evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" as const },
    runSummary: runs,
    definition: null,
    compatibility: {
      readOnly: true as const,
      completionUnverified: mapped.completionUnverified,
      missingFields,
      warnings: [],
    },
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
  const sourceSnapshotHash = projectionHash(base);
  const activeTargetRevisionId = targetRevisionId(targetId, sourceRevisionKey, sourceSnapshotHash);
  return {
    sourceRevisionKey,
    sourceSnapshotHash,
    model: { ...base, activeTargetRevisionId, projectedAt: now.toISOString() } satisfies TargetReadModelV1,
    projectedAt: now,
  };
}

export function targetReadModelService(db: Db) {
  async function listNative(workspaceId: string): Promise<TargetReadModelV1[]> {
    const rows = await db
      .select({
        targetId: verrailTargets.id,
        activeTargetRevisionId: verrailTargets.activeTargetRevisionId,
        workspaceId: verrailTargets.workspaceId,
        projectId: verrailTargets.projectId,
        projectName: projects.name,
        status: verrailTargets.status,
        targetCreatedAt: verrailTargets.createdAt,
        targetUpdatedAt: verrailTargets.updatedAt,
        revisionId: verrailTargetRevisions.id,
        title: verrailTargetRevisions.title,
        summary: verrailTargetRevisions.summary,
        ownerType: verrailTargetRevisions.outcomeOwnerPrincipalType,
        ownerId: verrailTargetRevisions.outcomeOwnerPrincipalId,
        ownerDisplayName: verrailTargetRevisions.outcomeOwnerDisplayName,
        goal: verrailTargetRevisions.goal,
        constraints: verrailTargetRevisions.constraints,
        acceptanceCriteria: verrailTargetRevisions.acceptanceCriteria,
        riskLevel: verrailTargetRevisions.riskLevel,
        deadline: verrailTargetRevisions.deadline,
        policySummary: verrailTargetRevisions.policySummary,
        revisionCreatedAt: verrailTargetRevisions.createdAt,
      })
      .from(verrailTargets)
      .innerJoin(projects, and(
        eq(projects.id, verrailTargets.projectId),
        eq(projects.companyId, verrailTargets.workspaceId),
        isNull(projects.archivedAt),
      ))
      .innerJoin(verrailTargetRevisions, and(
        eq(verrailTargetRevisions.workspaceId, verrailTargets.workspaceId),
        eq(verrailTargetRevisions.targetId, verrailTargets.id),
        eq(verrailTargetRevisions.id, verrailTargets.activeTargetRevisionId),
      ))
      .where(eq(verrailTargets.workspaceId, workspaceId));
    return rows.map(nativeRowToReadModel);
  }

  function nativeRowToReadModel(row: Awaited<ReturnType<typeof listNative>> extends never ? never : {
    targetId: string;
    activeTargetRevisionId: string;
    workspaceId: string;
    projectId: string;
    projectName: string;
    status: string;
    targetCreatedAt: Date;
    targetUpdatedAt: Date;
    revisionId: string;
    title: string;
    summary: string | null;
    ownerType: string;
    ownerId: string;
    ownerDisplayName: string | null;
    goal: string;
    constraints: string[];
    acceptanceCriteria: Array<{ id: string; title: string; description: string | null }>;
    riskLevel: string;
    deadline: string | null;
    policySummary: string | null;
    revisionCreatedAt: Date;
  }): TargetReadModelV1 {
    const status = (TARGET_STATUSES as readonly string[]).includes(row.status)
      ? row.status as TargetStatus
      : "draft";
    const riskLevel = RISK_LEVELS.has(row.riskLevel as TargetRiskLevel)
      ? row.riskLevel as TargetRiskLevel
      : "unknown";
    return {
      schemaVersion: TARGET_READ_MODEL_SCHEMA_VERSION,
      projectionPolicyVersion: "native.v1",
      targetId: row.targetId,
      activeTargetRevisionId: row.activeTargetRevisionId,
      workspaceId: row.workspaceId,
      authority: { kind: "native", writer: "go-domain-api" },
      project: { id: row.projectId, name: row.projectName },
      source: {
        type: "native",
        id: row.targetId,
        identifier: null,
        href: `/targets/${row.targetId}/overview`,
        updatedAt: row.targetUpdatedAt.toISOString(),
        revisionKey: row.revisionId,
      },
      title: row.title,
      summary: row.summary,
      status,
      outcomeOwner: row.ownerType === "user" || row.ownerType === "agent"
        ? { principalType: row.ownerType, principalId: row.ownerId, displayName: row.ownerDisplayName }
        : null,
      currentStage: stageForStatus(status),
      risk: { level: riskLevel },
      attentionSummary: { total: 0, highestSeverity: null },
      artifactSummary: { count: 0, latestRevisionId: null },
      evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" },
      runSummary: { active: 0, failed: 0, latestRunId: null, latestRunAt: null },
      definition: {
        goal: row.goal,
        constraints: row.constraints,
        acceptanceCriteria: row.acceptanceCriteria,
        deadline: row.deadline,
        policySummary: row.policySummary,
      },
      compatibility: null,
      createdAt: row.targetCreatedAt.toISOString(),
      updatedAt: row.targetUpdatedAt.toISOString(),
      projectedAt: row.revisionCreatedAt.toISOString(),
    };
  }

  async function getNativeByTargetId(workspaceId: string, targetId: string) {
    return (await listNative(workspaceId)).find((item) => item.targetId === targetId) ?? null;
  }

  async function getNativeByRevisionId(workspaceId: string, targetId: string, revisionId: string) {
    const rows = await db
      .select({
        targetId: verrailTargets.id,
        activeTargetRevisionId: verrailTargets.activeTargetRevisionId,
        workspaceId: verrailTargets.workspaceId,
        projectId: verrailTargets.projectId,
        projectName: projects.name,
        status: verrailTargets.status,
        targetCreatedAt: verrailTargets.createdAt,
        targetUpdatedAt: verrailTargets.updatedAt,
        revisionId: verrailTargetRevisions.id,
        title: verrailTargetRevisions.title,
        summary: verrailTargetRevisions.summary,
        ownerType: verrailTargetRevisions.outcomeOwnerPrincipalType,
        ownerId: verrailTargetRevisions.outcomeOwnerPrincipalId,
        ownerDisplayName: verrailTargetRevisions.outcomeOwnerDisplayName,
        goal: verrailTargetRevisions.goal,
        constraints: verrailTargetRevisions.constraints,
        acceptanceCriteria: verrailTargetRevisions.acceptanceCriteria,
        riskLevel: verrailTargetRevisions.riskLevel,
        deadline: verrailTargetRevisions.deadline,
        policySummary: verrailTargetRevisions.policySummary,
        revisionCreatedAt: verrailTargetRevisions.createdAt,
      })
      .from(verrailTargets)
      .innerJoin(projects, and(eq(projects.id, verrailTargets.projectId), eq(projects.companyId, verrailTargets.workspaceId)))
      .innerJoin(verrailTargetRevisions, and(
        eq(verrailTargetRevisions.workspaceId, verrailTargets.workspaceId),
        eq(verrailTargetRevisions.targetId, verrailTargets.id),
        eq(verrailTargetRevisions.id, revisionId),
      ))
      .where(and(eq(verrailTargets.workspaceId, workspaceId), eq(verrailTargets.id, targetId)))
      .limit(1);
    return rows[0] ? nativeRowToReadModel(rows[0]) : null;
  }

  async function persistProjection(
    workspaceId: string,
    input: RegisterTargetProjectionInput,
    existingTargetId?: string,
  ) {
    return db.transaction(async (tx) => {
      const built = await buildProjection(tx, workspaceId, input.sourceType, input.sourceId);
      if (existingTargetId && existingTargetId !== built.model.targetId) {
        throw conflict("Projection identity changed unexpectedly");
      }
      await tx.insert(targetProjectionRevisions).values({
        workspaceId,
        targetId: built.model.targetId,
        targetRevisionId: built.model.activeTargetRevisionId,
        projectionPolicyVersion: built.model.projectionPolicyVersion,
        sourceRevisionKey: built.sourceRevisionKey,
        sourceSnapshotHash: built.sourceSnapshotHash,
        schemaVersion: String(built.model.schemaVersion),
        projection: built.model,
        createdAt: built.projectedAt,
      }).onConflictDoNothing({ target: targetProjectionRevisions.targetRevisionId });

      const persistedRow = await tx
        .select({
          projection: targetProjectionRevisions.projection,
          schemaVersion: targetProjectionRevisions.schemaVersion,
          projectionPolicyVersion: targetProjectionRevisions.projectionPolicyVersion,
          sourceRevisionKey: targetProjectionRevisions.sourceRevisionKey,
        })
        .from(targetProjectionRevisions)
        .where(and(
          eq(targetProjectionRevisions.workspaceId, workspaceId),
          eq(targetProjectionRevisions.targetId, built.model.targetId),
          eq(targetProjectionRevisions.targetRevisionId, built.model.activeTargetRevisionId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!persistedRow) throw projectionUnavailable(built.model.targetId);
      const persistedModel = parseStoredCompatibilityProjection(persistedRow.projection, {
        workspaceId,
        targetId: built.model.targetId,
        targetRevisionId: built.model.activeTargetRevisionId,
        schemaVersion: persistedRow.schemaVersion,
        projectionPolicyVersion: persistedRow.projectionPolicyVersion,
        sourceRevisionKey: persistedRow.sourceRevisionKey,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      });
      if (!persistedModel) {
        throw projectionUnavailable(built.model.targetId, "snapshot_schema_or_identity_invalid");
      }

      await tx.insert(targetProjectionSources).values({
        workspaceId,
        targetId: built.model.targetId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        projectionPolicyVersion: built.model.projectionPolicyVersion,
        eligibilityReason: input.eligibilityReason,
        activeTargetRevisionId: built.model.activeTargetRevisionId,
        sourceRevisionKey: built.sourceRevisionKey,
        sourceSnapshotHash: built.sourceSnapshotHash,
        lastProjectedAt: built.projectedAt,
        disabledAt: null,
        errorCode: null,
        updatedAt: built.projectedAt,
      }).onConflictDoUpdate({
        target: [
          targetProjectionSources.workspaceId,
          targetProjectionSources.sourceType,
          targetProjectionSources.sourceId,
        ],
        set: {
          activeTargetRevisionId: built.model.activeTargetRevisionId,
          sourceRevisionKey: built.sourceRevisionKey,
          sourceSnapshotHash: built.sourceSnapshotHash,
          projectionPolicyVersion: built.model.projectionPolicyVersion,
          eligibilityReason: input.eligibilityReason,
          lastProjectedAt: built.projectedAt,
          disabledAt: null,
          errorCode: null,
          updatedAt: built.projectedAt,
        },
      });
      return persistedModel;
    }, { isolationLevel: "repeatable read" });
  }

  async function register(workspaceId: string, input: RegisterTargetProjectionInput) {
    return persistProjection(workspaceId, input);
  }

  async function reconcile(workspaceId: string, targetId: string) {
    const source = await db
      .select()
      .from(targetProjectionSources)
      .where(and(
        eq(targetProjectionSources.workspaceId, workspaceId),
        eq(targetProjectionSources.targetId, targetId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!source) throw notFound("Target projection not found");
    try {
      return await persistProjection(workspaceId, {
        sourceType: source.sourceType as TargetSourceType,
        sourceId: source.sourceId,
        eligibilityReason: source.eligibilityReason as RegisterTargetProjectionInput["eligibilityReason"],
      }, source.targetId);
    } catch (error) {
      await db.update(targetProjectionSources).set({
        disabledAt: new Date(),
        errorCode: error instanceof Error ? error.message.slice(0, 200) : "projection_failed",
        updatedAt: new Date(),
      }).where(eq(targetProjectionSources.id, source.id));
      throw error;
    }
  }

  async function listCompatibility(workspaceId: string) {
    const sources = await db
      .select({
        targetId: targetProjectionSources.targetId,
        activeTargetRevisionId: targetProjectionSources.activeTargetRevisionId,
        sourceType: targetProjectionSources.sourceType,
        sourceId: targetProjectionSources.sourceId,
        sourceRevisionKey: targetProjectionSources.sourceRevisionKey,
        projectionPolicyVersion: targetProjectionSources.projectionPolicyVersion,
      })
      .from(targetProjectionSources)
      .where(and(eq(targetProjectionSources.workspaceId, workspaceId), isNull(targetProjectionSources.disabledAt)));
    if (sources.length === 0) return [];
    const revisions = await db
      .select({
        targetRevisionId: targetProjectionRevisions.targetRevisionId,
        targetId: targetProjectionRevisions.targetId,
        schemaVersion: targetProjectionRevisions.schemaVersion,
        projectionPolicyVersion: targetProjectionRevisions.projectionPolicyVersion,
        sourceRevisionKey: targetProjectionRevisions.sourceRevisionKey,
        projection: targetProjectionRevisions.projection,
      })
      .from(targetProjectionRevisions)
      .where(and(
        eq(targetProjectionRevisions.workspaceId, workspaceId),
        inArray(
          targetProjectionRevisions.targetRevisionId,
          sources.map((source) => source.activeTargetRevisionId),
        ),
      ));
    const revisionsById = new Map(revisions.map((revision) => [revision.targetRevisionId, revision]));
    const rows = sources.flatMap((source) => {
      const revision = revisionsById.get(source.activeTargetRevisionId);
      if (!revision) {
        reportProjectionProblemOnce("invalid_projection_snapshot", {
          workspaceId,
          targetId: source.targetId,
          targetRevisionId: source.activeTargetRevisionId,
          schemaVersion: "unknown",
          projectionPolicyVersion: source.projectionPolicyVersion,
          sourceRevisionKey: source.sourceRevisionKey,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
        }, { reason: "active_snapshot_missing" });
        return [];
      }
      if (
        revision.targetId !== source.targetId
        || revision.projectionPolicyVersion !== source.projectionPolicyVersion
        || revision.sourceRevisionKey !== source.sourceRevisionKey
      ) {
        reportProjectionProblemOnce("invalid_projection_snapshot", {
          workspaceId,
          targetId: source.targetId,
          targetRevisionId: source.activeTargetRevisionId,
          schemaVersion: revision.schemaVersion,
          projectionPolicyVersion: source.projectionPolicyVersion,
          sourceRevisionKey: source.sourceRevisionKey,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
        }, {
          reason: "active_revision_metadata_mismatch",
        });
        return [];
      }
      const projection = parseStoredCompatibilityProjection(revision.projection, {
        workspaceId,
        targetId: source.targetId,
        targetRevisionId: source.activeTargetRevisionId,
        schemaVersion: revision.schemaVersion,
        projectionPolicyVersion: revision.projectionPolicyVersion,
        sourceRevisionKey: revision.sourceRevisionKey,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
      });
      return projection ? [{ ...source, projection }] : [];
    });
    const checked = await Promise.all(rows.map(async (row) => {
      const source = row.sourceType === "case"
        ? await loadCaseProjectionSource(db, workspaceId, row.sourceId)
        : await loadIssueProjectionSource(db, workspaceId, row.sourceId);
      if (!source || (source.projectId && !source.projectName)) return null;
      if (row.sourceType === "case") {
        try {
          const issueIds = await issueIdsForSource(db, "case", row.sourceId);
          await assertCaseIssueMemberships(db, workspaceId, row.sourceId, issueIds);
        } catch {
          return null;
        }
      } else {
        try {
          await assertIndependentIssueEligibility(db, source as Awaited<ReturnType<typeof loadIssueProjectionSource>> & {});
        } catch {
          return null;
        }
      }
      if (source.updatedAt.toISOString() !== row.sourceRevisionKey) {
        return withCompatibilityWarning(row.projection, "projection_stale");
      }
      return row.projection;
    }));
    return checked.filter((item): item is TargetReadModelV1 => item !== null);
  }

  async function list(workspaceId: string) {
    const [native, compatibility] = await Promise.all([
      listNative(workspaceId),
      listCompatibility(workspaceId),
    ]);
    const nativeIds = new Set(native.map((item) => item.targetId));
    return [...native, ...compatibility.filter((item) => !nativeIds.has(item.targetId))];
  }

  async function getByTargetId(workspaceId: string, targetId: string) {
    const native = await getNativeByTargetId(workspaceId, targetId);
    if (native) return native;
    const sourceRow = await db
      .select({
        sourceType: targetProjectionSources.sourceType,
        sourceId: targetProjectionSources.sourceId,
        sourceRevisionKey: targetProjectionSources.sourceRevisionKey,
        activeTargetRevisionId: targetProjectionSources.activeTargetRevisionId,
        projectionPolicyVersion: targetProjectionSources.projectionPolicyVersion,
      })
      .from(targetProjectionSources)
      .where(and(
        eq(targetProjectionSources.workspaceId, workspaceId),
        eq(targetProjectionSources.targetId, targetId),
        isNull(targetProjectionSources.disabledAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!sourceRow) return null;
    const revision = await db
      .select({
        projection: targetProjectionRevisions.projection,
        schemaVersion: targetProjectionRevisions.schemaVersion,
        projectionPolicyVersion: targetProjectionRevisions.projectionPolicyVersion,
        sourceRevisionKey: targetProjectionRevisions.sourceRevisionKey,
      })
      .from(targetProjectionRevisions)
      .where(and(
        eq(targetProjectionRevisions.workspaceId, workspaceId),
        eq(targetProjectionRevisions.targetId, targetId),
        eq(targetProjectionRevisions.targetRevisionId, sourceRow.activeTargetRevisionId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!revision) throw projectionUnavailable(targetId);
    if (
      revision.projectionPolicyVersion !== sourceRow.projectionPolicyVersion
      || revision.sourceRevisionKey !== sourceRow.sourceRevisionKey
    ) {
      reportProjectionProblemOnce("invalid_projection_snapshot", {
        workspaceId,
        targetId,
        targetRevisionId: sourceRow.activeTargetRevisionId,
        schemaVersion: revision.schemaVersion,
        projectionPolicyVersion: sourceRow.projectionPolicyVersion,
        sourceRevisionKey: sourceRow.sourceRevisionKey,
        sourceType: sourceRow.sourceType,
        sourceId: sourceRow.sourceId,
      }, { reason: "active_revision_metadata_mismatch" });
      throw projectionUnavailable(targetId, "active_revision_metadata_mismatch");
    }
    const projection = parseStoredCompatibilityProjection(revision.projection, {
      workspaceId,
      targetId,
      targetRevisionId: sourceRow.activeTargetRevisionId,
      schemaVersion: revision.schemaVersion,
      projectionPolicyVersion: revision.projectionPolicyVersion,
      sourceRevisionKey: revision.sourceRevisionKey,
      sourceType: sourceRow.sourceType,
      sourceId: sourceRow.sourceId,
    });
    if (!projection) throw projectionUnavailable(targetId, "snapshot_schema_or_identity_invalid");
    const row = { ...sourceRow, projection };
    const source = row.sourceType === "case"
      ? await loadCaseProjectionSource(db, workspaceId, row.sourceId)
      : await loadIssueProjectionSource(db, workspaceId, row.sourceId);
    if (!source || (source.projectId && !source.projectName)) return null;
    if (row.sourceType === "case") {
      try {
        const issueIds = await issueIdsForSource(db, "case", row.sourceId);
        await assertCaseIssueMemberships(db, workspaceId, row.sourceId, issueIds);
      } catch {
        return null;
      }
    } else {
      try {
        await assertIndependentIssueEligibility(db, source as Awaited<ReturnType<typeof loadIssueProjectionSource>> & {});
      } catch {
        return null;
      }
    }
    if (source.updatedAt.toISOString() !== row.sourceRevisionKey) {
      return withCompatibilityWarning(row.projection, "projection_stale");
    }
    return row.projection;
  }

  async function getByRevisionId(workspaceId: string, targetId: string, targetRevisionIdValue: string) {
    const native = await getNativeByRevisionId(workspaceId, targetId, targetRevisionIdValue);
    if (native) return native;
    const [revision, sourceRow] = await Promise.all([
      db
      .select({
        projection: targetProjectionRevisions.projection,
        schemaVersion: targetProjectionRevisions.schemaVersion,
        projectionPolicyVersion: targetProjectionRevisions.projectionPolicyVersion,
        sourceRevisionKey: targetProjectionRevisions.sourceRevisionKey,
      })
      .from(targetProjectionRevisions)
      .where(and(
        eq(targetProjectionRevisions.workspaceId, workspaceId),
        eq(targetProjectionRevisions.targetId, targetId),
        eq(targetProjectionRevisions.targetRevisionId, targetRevisionIdValue),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
      db
        .select({
          sourceType: targetProjectionSources.sourceType,
          sourceId: targetProjectionSources.sourceId,
        })
        .from(targetProjectionSources)
        .where(and(
          eq(targetProjectionSources.workspaceId, workspaceId),
          eq(targetProjectionSources.targetId, targetId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    if (!revision) return null;
    const projection = parseStoredCompatibilityProjection(revision.projection, {
      workspaceId,
      targetId,
      targetRevisionId: targetRevisionIdValue,
      schemaVersion: revision.schemaVersion,
      projectionPolicyVersion: revision.projectionPolicyVersion,
      sourceRevisionKey: revision.sourceRevisionKey,
      sourceType: sourceRow?.sourceType,
      sourceId: sourceRow?.sourceId,
    });
    if (!projection) throw projectionUnavailable(targetId, "snapshot_schema_or_identity_invalid");
    const source = projection.source.type === "case"
      ? await loadCaseProjectionSource(db, workspaceId, projection.source.id)
      : await loadIssueProjectionSource(db, workspaceId, projection.source.id);
    if (source) return projection;
    return withCompatibilityWarning(projection, "source_missing");
  }

  return { register, reconcile, list, getByTargetId, getByRevisionId };
}
