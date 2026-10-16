import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb, companies, verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions, verrailWorkNodes,
  verrailClaims, verrailArtifacts, verrailArtifactRevisions, verrailRuns, verrailRunAttempts, verrailRunEvents, verrailAuditEvents,
  verrailAgentDefinitions, verrailAgentVersions, verrailEvaluationRuns, verrailDeployments, verrailDeploymentRevisions,
  verrailExecutionLeases, verrailRepositoryDispatches, verrailRunSources,
  verrailExecutionCommandReceipts,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { captureNativeSource } from "./verrail-native-source.js";
import { captureNativeOutput, finalizeNativeOutputReceipt } from "./verrail-native-output.js";
import { loadGitHubCiSourceContext, loadCodexDeliverySourceContext } from "./github-ci-source-context.js";
import { loadRepositoryCiSourceContext } from "./github-ci-repository-source-context.js";
import { DELIVERY_PROOF_ASSERTIONS, repositoryExecutionIdentitySchema } from "@paperclipai/shared";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { finalizeRepositoryOutputReceipt, repositoryRequestSha256, repositorySourceObservation } from "../execution/repository-output-receipt.js";
import { repositoryObservationFixture } from "../__tests__/helpers/repository-execution-observation.js";
import { persistRepositoryExecutionObservation } from "../execution/repository-execution-observation.js";
import { collectRepositoryRecoveryCheckpoint, collectRepositoryRecoveryCompletion } from "./repository-recovery-proof-context.js";
import { collectRepositoryStaleFenceContext, collectRepositoryStaleFenceProbeCheckpoint,
  repositoryStaleFenceRequestHash, type RepositoryStaleFenceProbe } from "./repository-stale-fence-proof-context.js";

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
    const objects = new Map<string, Buffer>();
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
        const sha256 = createHash("sha256").update(input.body).digest("hex"); objects.set(sha256, Buffer.from(input.body));
        return { sha256, byteSize: input.body.length, objectKey: `${workspaceId}/verrail/run-artifacts/sha256/${sha256}` };
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
    return { input, receipt, payload, auditPayload, auditId, eventId, artifactId, attemptId, runId, graphId, sourceNodeId,
      deploymentId, deploymentRevisionId, agentVersionId, objects, acceptanceCriteria, load: () => loadGitHubCiSourceContext(db, input) };
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

  async function seedRepository() {
    const s = await seed();
    const { workspaceId, targetId, targetRevisionId, graphRevisionId } = s.input;
    const repositoryAuthor = { createdByPrincipalType: "service", createdByPrincipalId: "verrail-repository-runner" };
    const mapping = s.receipt.artifacts[0]!;
    if (!("sourceSnapshot" in mapping)) throw new Error("Fixture requires native snapshot");
    const sourceArtifactId = randomUUID(), sourceRevisionId = randomUUID(), provenanceId = randomUUID(), provenanceRevisionId = randomUUID();
    const origin = { repository: "fixture/repository", connectionId: randomUUID(), bindingId: randomUUID() };
    const source = { artifactId: sourceArtifactId, artifactRevisionId: sourceRevisionId, contentHash: mapping.contentHash };
    const provenance = { schemaVersion: 1, workspaceId, targetId, targetRevisionId, graphRevisionId, ...origin,
      ref: "refs/heads/candidate", baseCommit: mapping.sourceSnapshot.snapshotCommit, authorizationContextHash: hash, source };
    const body = Buffer.from(JSON.stringify(provenance));
    const provenanceHash = createHash("sha256").update(body).digest("hex"); s.objects.set(provenanceHash, body);
    await db.insert(verrailArtifacts).values([
      { id: sourceArtifactId, workspaceId, targetId, title: "Input source", kind: "code_change", ...author },
      { id: provenanceId, workspaceId, targetId, title: "Input provenance", kind: "report", ...author },
    ]);
    await db.insert(verrailArtifactRevisions).values([
      { id: sourceRevisionId, workspaceId, artifactId: sourceArtifactId, revisionNumber: 1, contentHash: mapping.contentHash, contentRef: mapping.contentRef, ...author },
      { id: provenanceRevisionId, workspaceId, artifactId: provenanceId, revisionNumber: 1, contentHash: provenanceHash,
        contentRef: `storage:${workspaceId}/verrail/run-artifacts/sha256/${provenanceHash}`, ...author },
    ]);
    await db.insert(verrailRunSources).values({ workspaceId, runId: s.runId, repositorySourceRevisionId: provenanceRevisionId });
    const now = new Date(); const at = now.toISOString(); const leaseId = randomUUID();
    const request: RepositoryExecutionRequest = { schemaVersion: 1, kind: "target_repository_execution", workspaceId, targetId, targetRevisionId, graphRevisionId,
      workNodeId: s.sourceNodeId, runId: s.runId, runAttemptId: s.attemptId, leaseId, fencingToken: 1, agentVersionId: s.agentVersionId,
      deploymentRevisionId: s.deploymentRevisionId, source: { artifactId: sourceArtifactId, contentHash: mapping.contentHash, baseCommit: provenance.baseCommit, format: "git_bundle" },
      runtime: "opencode", model: "fixture/model", instructions: "Synthetic contract fixture", timeoutSeconds: 30,
      output: { maxFiles: 2, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 } };
    const identity = { workspaceId, targetId, targetRevisionId, graphRevisionId, workNodeId: s.sourceNodeId, runId: s.runId, runAttemptId: s.attemptId,
      leaseId, fencingToken: 1, agentVersionId: s.agentVersionId, deploymentRevisionId: s.deploymentRevisionId };
    const observation = { ...s.receipt.sourceAfter, observedAt: at };
    const requestSha256 = repositoryRequestSha256(request);
    const receipt = finalizeRepositoryOutputReceipt({ schemaVersion: 1, kind: "verrail.repository-output-receipt", phase: "after_runtime_cleanup", identity,
      requestSha256, inputSource: request.source, sourceBinding: { repositorySourceRevisionId: provenanceRevisionId, provenanceContentHash: provenanceHash },
      executionFacts: { runtime: "opencode", runtimeVersion: "1.17.13", model: request.model, requestSha256, startedAt: at, finishedAt: at,
        exitCode: 0, cleanup: { runtime: true, commands: true, home: true, checkout: true } },
      sourceBefore: repositorySourceObservation(observation, "before_collection"), sourceAfter: repositorySourceObservation(observation, "after_collection"),
      sourceStatus: "stable", collectionStatus: "collected", artifacts: [{ ...mapping, type: "source_snapshot" }], finalizedAt: at }, request);
    const output = { runId: s.runId, runAttemptId: s.attemptId, leaseId, fencingToken: 1, source: request.source, artifacts: receipt.artifacts, outputReceipt: receipt };
    const payload = { repositoryOutput: output, artifacts: receipt.artifacts.map(({ title, kind, contentHash, contentRef }) => ({ title, kind, contentHash, contentRef })) };
    await db.update(verrailAgentVersions).set({ runtime: "opencode", model: request.model }).where(eq(verrailAgentVersions.id, s.agentVersionId));
    await db.update(verrailRunAttempts).set({ runtimeProfile: "repository_sandbox", executorPrincipalId: "verrail-repository-runner" }).where(eq(verrailRunAttempts.id, s.attemptId));
    await db.update(verrailArtifacts).set(repositoryAuthor).where(eq(verrailArtifacts.id, s.artifactId));
    await db.update(verrailArtifactRevisions).set(repositoryAuthor).where(eq(verrailArtifactRevisions.id, s.input.artifactRevisionId));
    await db.update(verrailRunEvents).set({ payload, emittedAt: now }).where(eq(verrailRunEvents.id, s.eventId));
    await db.update(verrailAuditEvents).set({ principalId: "verrail-repository-runner" }).where(eq(verrailAuditEvents.id, s.auditId));
    await db.insert(verrailExecutionLeases).values({ id: leaseId, workspaceId, runId: s.runId, runAttemptId: s.attemptId, executorPrincipalId: "verrail-repository-runner",
      runtimeProfile: "repository_sandbox", fencingToken: 1, status: "released", expiresAt: now, graceExpiresAt: now, releasedAt: now });
    await db.insert(verrailRepositoryDispatches).values({ workspaceId, runId: s.runId, runAttemptId: s.attemptId, leaseId, fencingToken: 1,
      controllerId: randomUUID(), requestHash: requestSha256, input: request, status: "succeeded", result: output, controllerExpiresAt: now, finishedAt: now });
    const options = { repository: origin, storage: { getObject: async (_workspace: string, key: string) => {
      const bytes = s.objects.get(key.split("/").at(-1)!)!;
      if (!bytes) throw new Error("Missing object");
      return { stream: Readable.from([bytes]), contentLength: bytes.length, contentType: "application/octet-stream" };
    } } };
    return { ...s, receipt, request, payload, output, options, leaseId, provenanceRevisionId, provenanceHash, provenance,
      loadRepository: () => loadGitHubCiSourceContext(db, s.input, options) };
  }
  it("admits a separately typed repository receipt only through its persisted dispatch, source binding and actual stored bytes", async () => {
    const s = await seedRepository();
    expect(await s.loadRepository()).toMatchObject({ source: { runId: s.runId, outputReceiptSha256: s.receipt.sha256 } });
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
    await expect(loadCodexDeliverySourceContext(db, s.input)).rejects.toMatchObject({ status: 409 });
    const before = await s.loadRepository();
    await db.update(verrailRuns).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(verrailRuns.id, s.runId));
    expect((await s.loadRepository()).contextSha256).not.toBe(before.contextSha256);
  });
  it("hashes only the fixed source selection across recovery and execution callers", async () => {
    const s = await seedRepository();
    const selected = await loadRepositoryCiSourceContext(db, s.input, s.options);
    const executionInput = { ...s.input, runId: s.runId, runAttemptId: s.attemptId };
    expect(await loadRepositoryCiSourceContext(db, executionInput, s.options)).toEqual(selected);
    expect((await loadRepositoryCiSourceContext(db, { ...s.input, requirementId: randomUUID() }, s.options)).contextSha256)
      .not.toBe(selected.contextSha256);
    await expect(loadRepositoryCiSourceContext(db, { ...s.input, artifactRevisionId: randomUUID() }, s.options))
      .rejects.toMatchObject({ status: 409 });
  });
  it.each(["stale_attempt", "lease", "dispatch", "request", "binding", "provenance_bytes", "snapshot_bytes", "origin", "event", "fence", "audit", "receipt", "foreign_workspace"])("rejects repository %s without native fallback", async change => {
    const s = await seedRepository();
    if (change === "stale_attempt") await db.update(verrailRuns).set({ attemptCount: 2 }).where(eq(verrailRuns.id, s.runId));
    if (change === "lease") await db.update(verrailExecutionLeases).set({ status: "revoked" }).where(eq(verrailExecutionLeases.id, s.leaseId));
    if (change === "dispatch") await db.update(verrailRepositoryDispatches).set({ status: "failed" }).where(eq(verrailRepositoryDispatches.runAttemptId, s.attemptId));
    if (change === "request") await db.update(verrailRepositoryDispatches).set({ requestHash: "b".repeat(64) }).where(eq(verrailRepositoryDispatches.runAttemptId, s.attemptId));
    if (change === "binding") await db.delete(verrailRunSources).where(eq(verrailRunSources.runId, s.runId));
    if (change === "provenance_bytes") s.objects.set(s.provenanceHash, Buffer.from("tampered"));
    if (change === "snapshot_bytes") s.objects.set(s.receipt.artifacts[0]!.contentHash, Buffer.from("tampered"));
    if (change === "origin") s.options.repository.connectionId = randomUUID();
    if (change === "event") await db.update(verrailRunEvents).set({ eventType: "failed" }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "fence") await db.update(verrailRunEvents).set({ fencingToken: 2 }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "audit") await db.delete(verrailAuditEvents).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "receipt") await db.update(verrailRunEvents).set({ payload: { ...s.payload, repositoryOutput: { ...s.output, outputReceipt: undefined } } }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "foreign_workspace") s.input.workspaceId = randomUUID();
    await expect(s.loadRepository()).rejects.toMatchObject({ status: 409 });
  });

  async function seedRecovery(withOlderAttempt = false, duplicateOutputs = false) {
    const s = await seedRepository();
    const request = { ...s.request, model: "fixture/test", fencingToken: withOlderAttempt ? 2 : 1,
      output: { ...s.request.output, maxFiles: duplicateOutputs ? 3 : 2 } };
    const f = repositoryObservationFixture(request);
    const identity = repositoryExecutionIdentitySchema.strip().parse(request);
    Object.assign(f.execution.facts, { candidateRuntime: { kind: "verrail.opencode-session-bound", nativePid: 101, observerPid: 100,
      sessionId: randomUUID(), manifestSha256: hash, executionIdentitySha256: createHash("sha256").update(canonicalJson(identity)).digest("hex"),
      httpSession: { sessionId: f.execution.facts.sessionId, runtimeVersion: "1.17.13", createdAt: f.execution.facts.sessionCreatedAt,
        homeSha256: f.execution.facts.runtimeWitness.before.environment.homeSha256 } } });
    const observation = await persistRepositoryExecutionObservation(f);
    for (const [key, bytes] of f.objects) s.objects.set(key.split("/").at(-1)!, bytes);
    const { sha256: _, ...previous } = s.receipt;
    const duplicateBytes = Buffer.from("identical output bytes");
    const duplicateHash = createHash("sha256").update(duplicateBytes).digest("hex");
    if (duplicateOutputs) s.objects.set(duplicateHash, duplicateBytes);
    const artifacts = [...previous.artifacts, ...(duplicateOutputs ? [1, 2].map(ordinal => ({ ordinal, type: "file" as const,
      path: `report-${ordinal}.txt`, title: "Identical report", kind: "report" as const, bytes: duplicateBytes.length,
      contentHash: duplicateHash, contentRef: `storage:${request.workspaceId}/verrail/run-artifacts/sha256/${duplicateHash}` })) : [])];
    const receipt = finalizeRepositoryOutputReceipt({ ...previous, identity, requestSha256: repositoryRequestSha256(request),
      executionFacts: { ...f.expected, requestSha256: repositoryRequestSha256(request), exitCode: 0,
        cleanup: { ...f.expected.cleanup, checkout: true } }, artifacts, executionObservation: observation, finalizedAt: new Date().toISOString() }, request);
    const output = { ...s.output, fencingToken: request.fencingToken, artifacts, outputReceipt: receipt };
    const payload = { ...s.payload, repositoryOutput: output,
      artifacts: artifacts.map(({ title, kind, contentHash, contentRef }) => ({ title, kind, contentHash, contentRef })) };
    const [revision] = await db.select().from(verrailArtifactRevisions).where(eq(verrailArtifactRevisions.id, s.input.artifactRevisionId));
    const [audit] = await db.select().from(verrailAuditEvents).where(eq(verrailAuditEvents.id, s.auditId));
    await db.delete(verrailAuditEvents).where(eq(verrailAuditEvents.id, s.auditId));
    await db.delete(verrailArtifactRevisions).where(eq(verrailArtifactRevisions.id, s.input.artifactRevisionId));
    await db.delete(verrailRunEvents).where(eq(verrailRunEvents.id, s.eventId));
    await db.update(verrailDeployments).set({ status: "active" }).where(eq(verrailDeployments.id, s.deploymentId));
    await db.update(verrailAgentVersions).set({ model: request.model }).where(eq(verrailAgentVersions.id, s.agentVersionId));
    await db.update(verrailRuns).set({ status: "running", attemptCount: request.fencingToken, startedAt: new Date(f.expected.startedAt), finishedAt: null }).where(eq(verrailRuns.id, s.runId));
    await db.update(verrailWorkNodes).set({ status: "running" }).where(eq(verrailWorkNodes.id, s.sourceNodeId));
    await db.update(verrailRunAttempts).set({ status: "running", attemptNumber: request.fencingToken, fencingToken: request.fencingToken,
      result: null, lastEventCursor: 2, startedAt: new Date(f.expected.startedAt), finishedAt: null }).where(eq(verrailRunAttempts.id, s.attemptId));
    await db.update(verrailExecutionLeases).set({ status: "active", expiresAt: new Date(Date.now() + 60_000),
      graceExpiresAt: new Date(Date.now() + 120_000), releasedAt: null, fencingToken: request.fencingToken }).where(eq(verrailExecutionLeases.id, s.leaseId));
    await db.update(verrailRepositoryDispatches).set({ input: request, requestHash: repositoryRequestSha256(request), result: output,
      finishedAt: new Date(), fencingToken: request.fencingToken }).where(eq(verrailRepositoryDispatches.runAttemptId, s.attemptId));
    await db.insert(verrailRunEvents).values(["claimed", "started"].map((eventType, index) => ({ id: randomUUID(),
      workspaceId: request.workspaceId, runId: s.runId, runAttemptId: s.attemptId, cursor: index + 1, fencingToken: request.fencingToken,
      eventType, payload: {}, contentHash: hash, emittedAt: new Date(f.expected.startedAt) })));
    const selection = { workspaceId: s.input.workspaceId, targetId: s.input.targetId, targetRevisionId: s.input.targetRevisionId,
      graphRevisionId: s.input.graphRevisionId, runId: s.runId, runAttemptId: s.attemptId };
    // Synthetic database transitions exercise reader boundaries only. They are not a recovery drill.
    const registerFixture = async (cursor = 3) => {
      const now = new Date();
      await db.update(verrailRuns).set({ status: "succeeded", finishedAt: now }).where(eq(verrailRuns.id, s.runId));
      await db.update(verrailRunAttempts).set({ status: "succeeded", result: payload, lastEventCursor: cursor, finishedAt: now }).where(eq(verrailRunAttempts.id, s.attemptId));
      await db.update(verrailWorkNodes).set({ status: "completed" }).where(eq(verrailWorkNodes.id, s.sourceNodeId));
      await db.update(verrailExecutionLeases).set({ status: "released", releasedAt: now }).where(eq(verrailExecutionLeases.id, s.leaseId));
      await db.insert(verrailRunEvents).values({ id: s.eventId, workspaceId: request.workspaceId, runId: s.runId, runAttemptId: s.attemptId,
        cursor, fencingToken: request.fencingToken, eventType: "succeeded", payload, contentHash: hash, emittedAt: now });
      await db.insert(verrailArtifactRevisions).values({ ...revision!, createdAt: now });
      await db.insert(verrailAuditEvents).values({ ...audit!, occurredAt: now,
        payload: { ...audit!.payload, fencingToken: request.fencingToken } });
      for (const artifact of artifacts.slice(1)) {
        const artifactId = randomUUID(), revisionId = randomUUID();
        await db.insert(verrailArtifacts).values({ id: artifactId, workspaceId: request.workspaceId, targetId: request.targetId,
          title: artifact.title, kind: artifact.kind, createdByPrincipalType: "service", createdByPrincipalId: "verrail-repository-runner" });
        await db.insert(verrailArtifactRevisions).values({ ...revision!, id: revisionId, artifactId,
          contentHash: artifact.contentHash, contentRef: artifact.contentRef, createdAt: now });
        await db.insert(verrailAuditEvents).values({ ...audit!, id: randomUUID(), aggregateId: revisionId, occurredAt: now,
          payload: { ...audit!.payload, resourceId: revisionId, contentHash: artifact.contentHash, fencingToken: request.fencingToken } });
      }
    };
    return { ...s, request, receipt, output, payload, selection, registerFixture,
      checkpoint: () => collectRepositoryRecoveryCheckpoint(db, selection, s.options) };
  }
  it("collects before/after database facts without promoting them to an admitted recovery proof", async () => {
    const s = await seedRecovery(), checkpoint = await s.checkpoint();
    expect(checkpoint).toMatchObject({ phase: "before_registration", durable: { identity: { runAttemptId: s.attemptId }, artifactCount: 1 } });
    expect(JSON.stringify(checkpoint)).not.toContain("Fixture result");
    expect(JSON.stringify(checkpoint)).not.toContain("Synthetic contract fixture");
    await s.registerFixture();
    const completed = await collectRepositoryRecoveryCompletion(db, checkpoint, s.input, s.options);
    expect(completed).toMatchObject({ kind: "verrail.repository-recovery-completion", checkpointSha256: checkpoint.contextSha256 });
    expect(await collectRepositoryRecoveryCompletion(db, checkpoint, s.input, s.options)).toEqual(completed);
    await expect(s.checkpoint()).rejects.toMatchObject({ status: 409 });
  });
  it("keeps a heartbeat committed during storage reads outside the earlier database snapshot", async () => {
    const s = await seedRecovery();
    const getObject = s.options.storage.getObject;
    let injected = false;
    s.options.storage.getObject = async (workspaceId, key) => {
      if (!injected) {
        injected = true;
        await db.insert(verrailRunEvents).values({ id: randomUUID(), workspaceId: s.request.workspaceId,
          runId: s.runId, runAttemptId: s.attemptId, cursor: 3, fencingToken: s.request.fencingToken,
          eventType: "heartbeat", payload: {}, contentHash: hash, emittedAt: new Date() });
        await db.update(verrailRunAttempts).set({ lastEventCursor: 3 }).where(eq(verrailRunAttempts.id, s.attemptId));
      }
      return getObject(workspaceId, key);
    };
    const checkpoint = await s.checkpoint();
    expect(injected).toBe(true);
    expect(checkpoint.events.map(event => event.cursor)).toEqual([1, 2]);
    await s.registerFixture(4);
    await expect(collectRepositoryRecoveryCompletion(db, checkpoint, s.input, s.options)).resolves.toMatchObject({
      kind: "verrail.repository-recovery-completion" });
  });
  it("matches distinct output artifacts one-to-one when their title and content are identical", async () => {
    const s = await seedRecovery(false, true), checkpoint = await s.checkpoint();
    await s.registerFixture();
    await expect(collectRepositoryRecoveryCompletion(db, checkpoint, s.input, s.options)).resolves.toMatchObject({
      durable: { artifactCount: 3 } });
  });
  it("preserves the database foreign key against moving a registered output to a foreign workspace", async () => {
    const s = await seedRecovery(false, true), checkpoint = await s.checkpoint();
    await s.registerFixture();
    const revisions = await db.select().from(verrailArtifactRevisions).where(eq(verrailArtifactRevisions.sourceRunId, s.runId));
    const extra = revisions.find(revision => revision.id !== s.input.artifactRevisionId)!;
    const foreign = await seed();
    await expect(db.update(verrailArtifacts).set({ workspaceId: foreign.input.workspaceId })
      .where(eq(verrailArtifacts.id, extra.artifactId))).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(collectRepositoryRecoveryCompletion(db, checkpoint, s.input, s.options)).resolves.toMatchObject({
      durable: { artifactCount: 3 } });
  });
  it.each(["target", "kind", "title", "author"])("rejects a non-selected output with changed parent %s", async change => {
    const s = await seedRecovery(false, true), checkpoint = await s.checkpoint();
    await s.registerFixture();
    const revisions = await db.select().from(verrailArtifactRevisions).where(eq(verrailArtifactRevisions.sourceRunId, s.runId));
    const extra = revisions.find(revision => revision.id !== s.input.artifactRevisionId)!;
    const otherTargetId = randomUUID();
    if (change === "target") {
      const otherRevisionId = randomUUID();
      await db.insert(verrailTargets).values({ id: otherTargetId, workspaceId: s.input.workspaceId, activeTargetRevisionId: otherRevisionId, ...author });
      const [revision] = await db.select().from(verrailTargetRevisions).where(eq(verrailTargetRevisions.id, s.input.targetRevisionId));
      await db.insert(verrailTargetRevisions).values({ ...revision!, id: otherRevisionId, targetId: otherTargetId });
    }
    const updates = change === "target" ? { targetId: otherTargetId }
      : change === "kind" ? { kind: "document" } : change === "title" ? { title: "Wrong title" }
      : { createdByPrincipalId: "different-executor" };
    await db.update(verrailArtifacts).set(updates).where(eq(verrailArtifacts.id, extra.artifactId));
    await expect(collectRepositoryRecoveryCompletion(db, checkpoint, s.input, s.options)).rejects.toMatchObject({ status: 409 });
  });
  it.each(["expired", "inactive_graph", "request", "observation", "log", "source", "controller_result", "premature_artifact"])("rejects recovery checkpoint %s", async change => {
    const s = await seedRecovery();
    if (change === "expired") await db.update(verrailExecutionLeases).set({ expiresAt: new Date(0) }).where(eq(verrailExecutionLeases.id, s.leaseId));
    if (change === "inactive_graph") await db.update(verrailWorkGraphs).set({ activeGraphRevisionId: null }).where(eq(verrailWorkGraphs.id, s.graphId));
    if (change === "request") await db.update(verrailRepositoryDispatches).set({ requestHash: "f".repeat(64) }).where(eq(verrailRepositoryDispatches.runAttemptId, s.attemptId));
    if (change === "observation") s.objects.set(s.receipt.executionObservation!.contentHash, Buffer.from("{}"));
    if (change === "log") {
      const observation = JSON.parse(s.objects.get(s.receipt.executionObservation!.contentHash)!.toString());
      s.objects.set(observation.log.contentHash, Buffer.from("[]"));
    }
    if (change === "source") s.objects.set(s.request.source.contentHash, Buffer.from("changed"));
    if (change === "controller_result") await db.update(verrailRepositoryDispatches).set({ result: {} }).where(eq(verrailRepositoryDispatches.runAttemptId, s.attemptId));
    if (change === "premature_artifact") await s.registerFixture();
    await expect(s.checkpoint()).rejects.toMatchObject({ status: 409 });
  });
  it.each(["checkpoint_hash", "controller", "new_attempt", "event_prefix", "missing_audit", "extra_artifact", "result", "foreign_target", "released_before_checkpoint", "inactive_graph"])("rejects recovery completion %s", async change => {
    const s = await seedRecovery(), checkpoint = await s.checkpoint();
    await s.registerFixture();
    if (change === "checkpoint_hash") checkpoint.contextSha256 = "f".repeat(64);
    if (change === "controller") await db.update(verrailRepositoryDispatches).set({ controllerId: randomUUID() }).where(eq(verrailRepositoryDispatches.runAttemptId, s.attemptId));
    if (change === "new_attempt") await db.update(verrailRuns).set({ attemptCount: 2 }).where(eq(verrailRuns.id, s.runId));
    if (change === "event_prefix") await db.update(verrailRunEvents).set({ payload: { changed: true } }).where(eq(verrailRunEvents.id, checkpoint.events[0]!.id));
    if (change === "missing_audit") await db.delete(verrailAuditEvents).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "extra_artifact") {
      const [revision] = await db.select().from(verrailArtifactRevisions).where(eq(verrailArtifactRevisions.id, s.input.artifactRevisionId));
      await db.insert(verrailArtifactRevisions).values({ ...revision!, id: randomUUID(), revisionNumber: 2, contentHash: "f".repeat(64) });
    }
    if (change === "result") await db.update(verrailRunAttempts).set({ result: {} }).where(eq(verrailRunAttempts.id, s.attemptId));
    if (change === "foreign_target") s.input.targetId = randomUUID();
    if (change === "released_before_checkpoint") await db.update(verrailExecutionLeases).set({ releasedAt: new Date(0) }).where(eq(verrailExecutionLeases.id, s.leaseId));
    if (change === "inactive_graph") await db.update(verrailWorkGraphs).set({ activeGraphRevisionId: null }).where(eq(verrailWorkGraphs.id, s.graphId));
    await expect(collectRepositoryRecoveryCompletion(db, checkpoint, s.input, s.options)).rejects.toMatchObject({ status: 409 });
  });

  async function seedStaleFence() {
    const s = await seedRecovery(true);
    await s.registerFixture();
    const oldAttemptId = randomUUID(), oldLeaseId = randomUUID(), receiptId = randomUUID(), auditId = randomUUID();
    const finishedAt = new Date("2026-01-01T00:00:00Z"), startedAt = new Date(finishedAt.getTime() - 1000);
    await db.insert(verrailRunAttempts).values({ id: oldAttemptId, workspaceId: s.request.workspaceId, runId: s.runId,
      attemptNumber: 1, fencingToken: 1, agentVersionId: s.agentVersionId, deploymentRevisionId: s.deploymentRevisionId,
      executorPrincipalType: "service", executorPrincipalId: "verrail-repository-runner", runtimeProfile: "repository_sandbox",
      status: "superseded", lastEventCursor: 2, startedAt, finishedAt, idempotencyKey: randomUUID() });
    await db.insert(verrailExecutionLeases).values({ id: oldLeaseId, workspaceId: s.request.workspaceId, runId: s.runId,
      runAttemptId: oldAttemptId, executorPrincipalId: "verrail-repository-runner", runtimeProfile: "repository_sandbox", fencingToken: 1,
      status: "expired", expiresAt: finishedAt, graceExpiresAt: finishedAt, releasedAt: finishedAt });
    await db.insert(verrailRunEvents).values(["claimed", "started"].map((eventType, index) => ({
      id: randomUUID(), workspaceId: s.request.workspaceId, runId: s.runId, runAttemptId: oldAttemptId,
      cursor: index + 1, fencingToken: 1, eventType, payload: {}, contentHash: hash, emittedAt: startedAt, receivedAt: startedAt,
    })));
    const identity = repositoryExecutionIdentitySchema.strip().parse(s.request);
    const probeCheckpoint = await collectRepositoryStaleFenceProbeCheckpoint(db, identity, oldAttemptId);
    const probe: RepositoryStaleFenceProbe = { workspaceId: s.request.workspaceId, runId: s.runId, runAttemptId: oldAttemptId,
      idempotencyKey: randomUUID(), input: { leaseId: oldLeaseId, fencingToken: 1, cursor: 3,
        eventType: "heartbeat", emittedAt: "2026-01-01T00:00:00Z" } };
    const response = { schemaVersion: 1, runId: s.runId, runAttemptId: oldAttemptId, cursor: 3, eventType: "heartbeat", authoritative: false,
      rejectionCode: "STALE_FENCING_TOKEN", runStatus: "succeeded", attemptStatus: "superseded", leaseStatus: "expired", replayed: false };
    await db.insert(verrailExecutionCommandReceipts).values({ id: receiptId, workspaceId: s.request.workspaceId,
      principalType: "service", principalId: "verrail-repository-runner", commandType: "run_event.report.v1",
      idempotencyKey: probe.idempotencyKey, requestHash: repositoryStaleFenceRequestHash(probe), response });
    const auditPayload = { schemaVersion: 1, targetId: s.input.targetId, runId: s.runId, runAttemptId: oldAttemptId, eventType: "run.event_rejected_stale_fence" };
    await db.insert(verrailAuditEvents).values({ id: auditId, workspaceId: s.request.workspaceId, principalType: "service",
      principalId: "verrail-repository-runner", eventType: "run.event_rejected_stale_fence", aggregateType: "target",
      aggregateId: s.input.targetId, idempotencyKey: probe.idempotencyKey, payload: auditPayload });
    return { ...s, probe, receiptId, auditId, oldAttemptId, oldLeaseId, response, auditPayload, probeCheckpoint,
      readStale: () => collectRepositoryStaleFenceContext(db, probe, receiptId) };
  }
  it("reads a synthetic older-attempt rejection without issuing events or declaring recovery passed", async () => {
    const s = await seedStaleFence();
    const context = await s.readStale();
    expect(context).toMatchObject({ kind: "verrail.repository-stale-fence-context", oldAttemptId: s.oldAttemptId,
      currentAttemptId: s.attemptId, oldFencingToken: 1, currentFencingToken: 2, response: { authoritative: false } });
    expect(context.probeCheckpoint).toEqual(s.probeCheckpoint);
    expect(context.probeCheckpoint.oldAttemptNumber).toBe(1);
    expect(await collectRepositoryStaleFenceContext(db, s.probe)).toEqual(context);
    await expect(collectRepositoryStaleFenceContext(db, s.probe, randomUUID())).rejects.toMatchObject({ status: 409 });
    expect(await s.readStale()).toEqual(context);
    await db.update(verrailRunAttempts).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(verrailRunAttempts.id, s.attemptId));
    expect((await s.readStale()).currentAttemptSha256).not.toBe(context.currentAttemptSha256);
  });
  it.each(["current_attempt", "wrong_lease", "wrong_fence", "request_hash", "authoritative", "rejection", "missing_audit", "audit_payload", "accepted_event", "current_result_status", "workspace", "missing_history", "history_fence", "old_finished_after_current"])("rejects stale-fence %s", async change => {
    const s = await seedStaleFence();
    if (change === "current_attempt") s.probe.runAttemptId = s.attemptId;
    if (change === "wrong_lease") s.probe.input.leaseId = s.leaseId;
    if (change === "wrong_fence") s.probe.input.fencingToken = 99;
    if (["wrong_lease", "wrong_fence"].includes(change)) await db.update(verrailExecutionCommandReceipts).set({ requestHash: repositoryStaleFenceRequestHash(s.probe) }).where(eq(verrailExecutionCommandReceipts.id, s.receiptId));
    if (change === "request_hash") await db.update(verrailExecutionCommandReceipts).set({ requestHash: "f".repeat(64) }).where(eq(verrailExecutionCommandReceipts.id, s.receiptId));
    if (change === "authoritative") await db.update(verrailExecutionCommandReceipts).set({ response: { ...s.response, authoritative: true } }).where(eq(verrailExecutionCommandReceipts.id, s.receiptId));
    if (change === "rejection") await db.update(verrailExecutionCommandReceipts).set({ response: { ...s.response, rejectionCode: "LEASE_NOT_ACTIVE" } }).where(eq(verrailExecutionCommandReceipts.id, s.receiptId));
    if (change === "missing_audit") await db.delete(verrailAuditEvents).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "audit_payload") await db.update(verrailAuditEvents).set({ payload: { ...s.auditPayload, runAttemptId: s.attemptId } }).where(eq(verrailAuditEvents.id, s.auditId));
    if (change === "accepted_event") await db.insert(verrailRunEvents).values({ id: randomUUID(), workspaceId: s.probe.workspaceId,
      runId: s.runId, runAttemptId: s.oldAttemptId, cursor: 3, fencingToken: 1, eventType: "heartbeat", payload: {}, contentHash: hash, emittedAt: new Date() });
    if (change === "current_result_status") await db.update(verrailRunAttempts).set({ status: "failed" }).where(eq(verrailRunAttempts.id, s.attemptId));
    if (change === "workspace") s.probe.workspaceId = randomUUID();
    if (change === "missing_history") await db.delete(verrailRunEvents).where(eq(verrailRunEvents.runAttemptId, s.oldAttemptId));
    if (change === "history_fence") await db.update(verrailRunEvents).set({ fencingToken: 2 }).where(eq(verrailRunEvents.runAttemptId, s.oldAttemptId));
    if (change === "old_finished_after_current") await db.update(verrailRunAttempts).set({ finishedAt: new Date() }).where(eq(verrailRunAttempts.id, s.oldAttemptId));
    await expect(s.readStale()).rejects.toMatchObject({ status: 409 });
  });
});
