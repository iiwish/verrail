import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb, companies, verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions, verrailWorkNodes,
  verrailClaims, verrailArtifacts, verrailArtifactRevisions, verrailRuns, verrailRunAttempts, verrailRunEvents, verrailAuditEvents,
  verrailAgentDefinitions, verrailAgentVersions, verrailEvaluationRuns, verrailDeployments, verrailDeploymentRevisions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { captureNativeSource } from "./verrail-native-source.js";
import { captureNativeOutput, finalizeNativeOutputReceipt } from "./verrail-native-output.js";
import { loadGitHubCiSourceContext, loadCodexDeliverySourceContext } from "./github-ci-source-context.js";
import { DELIVERY_PROOF_ASSERTIONS } from "@paperclipai/shared";

const exec = promisify(execFile);
const hash = "a".repeat(64);
const author = { createdByPrincipalType: "service", createdByPrincipalId: "verrail-host-runner" };
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("fixed CI native source database association", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("verrail-source-context-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed(snapshot = true) {
    const [workspace] = await db.insert(companies).values({ name: "Synthetic source context", issuePrefix: `SRC${randomUUID().slice(0, 6)}` }).returning();
    const workspaceId = workspace!.id;
    const targetId = randomUUID(), targetRevisionId = randomUUID(), graphId = randomUUID(), graphRevisionId = randomUUID(), workNodeId = randomUUID(), sourceNodeId = randomUUID(), claimId = randomUUID();
    const acceptanceCriteria = [{ id: "fixed-ci", title: "Fixed CI", description: null, proofContract: { schemaVersion: 1 as const, allOf: [{ id: "ci", kind: "independent_verification" as const, phase: "pre_acceptance" as const, assertions: ["ts_tests", "ts_typecheck", "ts_build", "go_tests"] }] } }];
    await db.insert(verrailTargets).values({ id: targetId, workspaceId, activeTargetRevisionId: targetRevisionId, ...author });
    await db.insert(verrailTargetRevisions).values({ id: targetRevisionId, workspaceId, targetId, revisionNumber: 1, title: "Synthetic", goal: "Test", constraints: [], acceptanceCriteria, outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "test", riskLevel: "low", contentHash: hash, ...author });
    await db.insert(verrailWorkGraphs).values({ id: graphId, workspaceId, targetId, activeGraphRevisionId: graphRevisionId, status: "active" });
    await db.insert(verrailGraphRevisions).values({ id: graphRevisionId, workspaceId, targetId, targetRevisionId, workGraphId: graphId, revisionNumber: 1, status: "active", contentHash: hash, ...author });
    await db.insert(verrailWorkNodes).values([
      { id: workNodeId, workspaceId, targetId, graphRevisionId, nodeKey: "verify", kind: "integration_task", title: "CI", stageKey: "verify", status: "ready", completionDefinition: "fixed CI" },
      { id: sourceNodeId, workspaceId, targetId, graphRevisionId, nodeKey: "source", kind: "agent_task", title: "Source", stageKey: "execute", status: "completed", completionDefinition: "source" },
    ]);
    await db.insert(verrailClaims).values({ id: claimId, workspaceId, targetId, targetRevisionId, criterionKey: "fixed-ci", title: "CI", ...author });
    const agentDefinitionId = randomUUID(), agentVersionId = randomUUID(), evaluationRunId = randomUUID(), deploymentId = randomUUID(), deploymentRevisionId = randomUUID(), runId = randomUUID(), attemptId = randomUUID();
    await db.insert(verrailAgentDefinitions).values({ id: agentDefinitionId, workspaceId, name: "Test", ...author });
    await db.insert(verrailAgentVersions).values({ id: agentVersionId, workspaceId, agentDefinitionId, versionNumber: 1, runtime: "codex_local", model: "test", prompt: "test", contentHash: hash, ...author });
    await db.insert(verrailEvaluationRuns).values({ id: evaluationRunId, workspaceId, candidateAgentVersionId: agentVersionId, status: "passed", safetyStatus: "passed", ...author });
    await db.insert(verrailDeployments).values({ id: deploymentId, workspaceId, agentDefinitionId, name: "Test", ...author });
    await db.insert(verrailDeploymentRevisions).values({ id: deploymentRevisionId, workspaceId, deploymentId, revisionNumber: 1, agentVersionId, evaluationRunId, state: "active", contentHash: hash, ...author });
    await db.insert(verrailRuns).values({ id: runId, workspaceId, targetId, targetRevisionId, graphRevisionId, workNodeId: sourceNodeId, kind: "agent", status: "succeeded", actorPrincipalType: "service", actorPrincipalId: "test", deploymentRevisionId, agentVersionId, attemptCount: 1, idempotencyKey: randomUUID() });
    await db.insert(verrailRunAttempts).values({ id: attemptId, workspaceId, runId, attemptNumber: 1, deploymentRevisionId, agentVersionId, runtimeProfile: "host_trusted", executorPrincipalType: "service", executorPrincipalId: "verrail-host-runner", fencingToken: 1, status: "succeeded", lastEventCursor: 3, idempotencyKey: randomUUID() });
    const identity = { workspaceId, runId, attemptId, deploymentRevisionId, agentVersionId, heartbeatRunId: randomUUID(), agentId: randomUUID() };
    const cwd = await mkdtemp(path.join(os.tmpdir(), "verrail-source-context-fixture-"));
    let receipt;
    try {
      await exec("git", ["init", "-q", "--template="], { cwd }); await writeFile(path.join(cwd, "source"), "actual product bytes");
      await exec("git", ["add", "."], { cwd }); await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd });
      const beforeSource = await captureNativeSource({ cwd, identity, scopeVersion: snapshot ? 2 : 1 });
      const output = path.join(cwd, ".verrail", "run-artifacts", attemptId); await mkdir(output, { recursive: true });
      await writeFile(path.join(output, "manifest.json"), JSON.stringify(snapshot
        ? { schemaVersion: 2, artifacts: [{ type: "source_snapshot", title: "Source", format: "git_bundle", scopeVersion: 2 }] }
        : { schemaVersion: 1, artifacts: [{ title: "Source", kind: "code_change", path: "file.txt" }] }));
      if (!snapshot) await writeFile(path.join(output, "file.txt"), "ordinary bytes");
      const captured = await captureNativeOutput({ cwd, identity, beforeSource, revalidate: async () => {}, storage: { putFile: async (input: { body: Buffer }) => {
        const sha256 = createHash("sha256").update(input.body).digest("hex"); return { sha256, byteSize: input.body.length, objectKey: `${workspaceId}/verrail/run-artifacts/sha256/${sha256}` };
      } } as never });
      receipt = finalizeNativeOutputReceipt(captured, { heartbeatRunId: identity.heartbeatRunId, heartbeatStatus: "succeeded", agentId: identity.agentId, logStore: null, logRef: null, logSha256: null, logBytes: null, usage: null, exitCode: 0, errorCode: null, environmentManifest: null });
    } finally { await rm(cwd, { recursive: true, force: true }); }
    const eventId = randomUUID(), artifactId = randomUUID(), artifactRevisionId = randomUUID(), auditId = randomUUID();
    const artifact = receipt.artifacts[0]!;
    const payload = { ...receipt.executionFacts, sourceObservation: receipt.beforeSource, outputReceipt: receipt, artifacts: [{ title: artifact.title, kind: artifact.kind, contentHash: artifact.contentHash, contentRef: artifact.contentRef }] };
    await db.insert(verrailRunEvents).values({ id: eventId, workspaceId, runId, runAttemptId: attemptId, cursor: 3, fencingToken: 1, eventType: "succeeded", payload, contentHash: hash, emittedAt: new Date() });
    await db.insert(verrailArtifacts).values({ id: artifactId, workspaceId, targetId, kind: artifact.kind, title: artifact.title, ...author });
    await db.insert(verrailArtifactRevisions).values({ id: artifactRevisionId, workspaceId, artifactId, revisionNumber: 1, contentHash: artifact.contentHash, contentRef: artifact.contentRef, sourceRunId: runId, sourceWorkNodeId: sourceNodeId, ...author });
    const auditPayload = { schemaVersion: 1, resourceType: "artifact_revision", resourceId: artifactRevisionId, runId, runAttemptId: attemptId, workNodeId: sourceNodeId, fencingToken: 1, contentHash: artifact.contentHash };
    await db.insert(verrailAuditEvents).values({ id: auditId, workspaceId, principalType: "service", principalId: "verrail-host-runner", eventType: "assurance.artifact_revision_added.v1", aggregateType: "artifact_revision", aggregateId: artifactRevisionId, idempotencyKey: "native-event", payload: auditPayload });
    const input = { workspaceId, targetId, targetRevisionId, graphRevisionId, claimId, workNodeId, artifactRevisionId, requirementId: "ci" };
    return { input, receipt, payload, auditPayload, auditId, eventId, artifactId, attemptId, runId, graphId, acceptanceCriteria, load: () => loadGitHubCiSourceContext(db, input) };
  }
  it("loads the exact native snapshot from real PostgreSQL without workspace files or secrets", async () => {
    const s = await seed();
    expect(await s.load()).toMatchObject({ criterionKey: "fixed-ci", source: { runId: s.runId, runAttemptId: s.attemptId, runEventId: s.eventId, runEventContentHash: hash, outputReceiptSha256: s.receipt.sha256, artifactOrdinal: 0 } });
    const context = await s.load(); expect(context.contextSha256).toMatch(/^[a-f0-9]{64}$/); expect(await s.load()).toEqual(context);
    await expect(loadGitHubCiSourceContext(db, { ...s.input, workspaceId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  });
  it("rejects genuine historical v1 ordinary artifacts rather than relabeling them", async () => { await expect((await seed(false)).load()).rejects.toMatchObject({ status: 409 }); });
  it("loads a complete Codex composite source without a previously admitted CI proof", async () => {
    const s = await seed();
    s.acceptanceCriteria[0]!.proofContract.allOf[0]!.assertions = [...DELIVERY_PROOF_ASSERTIONS.codex_execution];
    await db.update(verrailTargetRevisions).set({ acceptanceCriteria: s.acceptanceCriteria }).where(eq(verrailTargetRevisions.id, s.input.targetRevisionId));
    expect(await loadCodexDeliverySourceContext(db, s.input)).toMatchObject({ source: { runId: s.runId } });
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });
  it.each(["ci_only", "partial", "extended", "feishu"])("rejects %s at the dedicated Codex source entry", async change => {
    const s = await seed();
    const requirement = s.acceptanceCriteria[0]!.proofContract.allOf[0]!;
    if (change !== "ci_only") requirement.assertions = [...DELIVERY_PROOF_ASSERTIONS.codex_execution];
    if (change === "partial") requirement.assertions.pop();
    if (change === "extended") requirement.assertions.push("ts_tests");
    if (change === "feishu") requirement.assertions = [...DELIVERY_PROOF_ASSERTIONS.feishu_target];
    await db.update(verrailTargetRevisions).set({ acceptanceCriteria: s.acceptanceCriteria }).where(eq(verrailTargetRevisions.id, s.input.targetRevisionId));
    await expect(loadCodexDeliverySourceContext(db, s.input)).rejects.toMatchObject({ status: 409 });
  });
  it.each(["audit", "audit_fence", "executor", "fence", "attempt", "event", "hash", "ref", "title", "receipt", "ordinal", "unfinalized", "stale", "node", "claim", "compound"])("rejects %s association failure", async change => {
    const s = await seed();
    if (change === "audit") await db.delete(verrailAuditEvents).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "audit_fence") await db.update(verrailAuditEvents).set({ payload: { ...s.auditPayload, fencingToken: 2 } }).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "executor") await db.update(verrailRunAttempts).set({ executorPrincipalId: "other-service" }).where(eq(verrailRunAttempts.id, s.attemptId));
    if (change === "fence") await db.update(verrailRunEvents).set({ fencingToken: 2 }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "attempt") await db.update(verrailRuns).set({ attemptCount: 2 }).where(eq(verrailRuns.id, s.runId));
    if (change === "event") await db.update(verrailRunEvents).set({ eventType: "failed" }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "hash") await db.update(verrailArtifactRevisions).set({ contentHash: "b".repeat(64) }).where(eq(verrailArtifactRevisions.id, s.input.artifactRevisionId));
    if (change === "ref") await db.update(verrailArtifactRevisions).set({ contentRef: "storage:foreign" }).where(eq(verrailArtifactRevisions.id, s.input.artifactRevisionId));
    if (change === "title") await db.update(verrailArtifacts).set({ title: "Copied" }).where(eq(verrailArtifacts.id, s.artifactId));
    if (change === "receipt") await db.update(verrailRunEvents).set({ payload: { ...s.payload, outputReceipt: { ...s.receipt, sha256: "b".repeat(64) } } }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "ordinal") await db.update(verrailRunEvents).set({ payload: { ...s.payload, artifacts: [] } }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "unfinalized") { const { executionFacts: _, finalizedAt: __, ...receipt } = s.receipt; await db.update(verrailRunEvents).set({ payload: { ...s.payload, outputReceipt: receipt } }).where(eq(verrailRunEvents.id, s.eventId)); }
    if (change === "stale") await db.update(verrailWorkGraphs).set({ activeGraphRevisionId: null }).where(eq(verrailWorkGraphs.id, s.graphId));
    if (change === "node") await db.update(verrailWorkNodes).set({ status: "pending" }).where(eq(verrailWorkNodes.id, s.input.workNodeId));
    if (change === "claim") await db.update(verrailClaims).set({ criterionKey: "other" }).where(eq(verrailClaims.id, s.input.claimId));
    if (change === "compound") { s.acceptanceCriteria[0]!.proofContract.allOf[0]!.assertions.push("live_codex"); await db.update(verrailTargetRevisions).set({ acceptanceCriteria: s.acceptanceCriteria }).where(eq(verrailTargetRevisions.id, s.input.targetRevisionId)); }
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });
  it("fingerprints relevant metadata for post-read revalidation", async () => {
    const s = await seed(), before = await s.load();
    await db.update(verrailTargetRevisions).set({ contentHash: "b".repeat(64) }).where(eq(verrailTargetRevisions.id, s.input.targetRevisionId));
    expect((await s.load()).contextSha256).not.toBe(before.contextSha256);
  });
});
