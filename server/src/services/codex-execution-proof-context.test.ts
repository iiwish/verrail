import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb, companies, agents, heartbeatRuns, agentWakeupRequests, verrailTargets, verrailTargetRevisions,
  verrailWorkGraphs, verrailGraphRevisions, verrailWorkNodes, verrailRuns, verrailRunAttempts, verrailRunEvents,
  verrailExecutionLeases, verrailAgentDefinitions, verrailAgentVersions, verrailEvaluationRuns, verrailDeployments, verrailDeploymentRevisions,
  verrailArtifacts, verrailArtifactRevisions, verrailClaims, verrailEvidence, verrailVerificationResults, verrailCriterionProofs,
  verrailIntegrationRuns, verrailIntegrationAttempts, verrailAgentCommandReceipts, verrailAuditEvents,
  toolConnections, toolApplications, verrailGithubRepoBindings,
} from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { captureNativeSource } from "./verrail-native-source.js";
import { captureNativeOutput, finalizeNativeOutputReceipt, NATIVE_OUTPUT_CONTEXT_KEY } from "./verrail-native-output.js";
import { createDurableRunLogStore } from "./run-log-store.js";
import { resolveNativeRunWorkspace } from "./verrail-native-workspace.js";
import { loadCodexExecutionProofContext } from "./codex-execution-proof-context.js";
import { deliveryContextRoutes } from "../routes/delivery-context.js";
import { loadNativeDispatchConfiguration, NATIVE_DISPATCH_CONTEXT_KEY } from "./verrail-native-dispatch.js";
import { provisionDeliveryProofReader, removeDeliveryProofReader, assertDeliveryProofReader } from "./delivery-proof-reader-access.js";
import { recordDeliveryProof } from "./delivery-proof-recorder.js";
import { deliveryRuntimeFixture, githubDeliveryFixture, channelDeliveryFixture } from "../__tests__/helpers/delivery-proof-fixtures.js";
import { DELIVERY_PROOF_ASSERTIONS, type DeliveryProofKind } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { observeNativePermissions, NATIVE_PERMISSION_CONTEXT_KEY } from "./verrail-native-permission-observation.js";

const exec = promisify(execFile);
const hash = "a".repeat(64);
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const author = { createdByPrincipalType: "service", createdByPrincipalId: "verrail-host-runner" };
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("Codex execution context (synthetic, not a real model run)", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sourceDir: string, logDir: string;
  let logs: ReturnType<typeof createDurableRunLogStore>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("verrail-codex-proof-");
    db = createDb(database.connectionString);
    sourceDir = await mkdtemp(path.join(os.tmpdir(), "verrail-codex-proof-source-"));
    logDir = await mkdtemp(path.join(os.tmpdir(), "verrail-codex-proof-logs-"));
    await exec("git", ["init", "-q", "--template="], { cwd: sourceDir });
    await writeFile(path.join(sourceDir, "source.txt"), "synthetic source\n");
    await exec("git", ["add", "."], { cwd: sourceDir });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], { cwd: sourceDir });
    logs = createDurableRunLogStore({ basePath: logDir });
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup();
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
    if (logDir) await rm(logDir, { recursive: true, force: true });
  });

  it.skipIf(process.env.VERRAIL_TEST_CODEX_GO_BRIDGE !== "1")("runs both closed delivery transaction paths against the temporary database", async () => {
    const result = await exec("go", ["test", "./internal/target", "-run", "^TestDeliveryProofTransaction$", "-count=1"], {
      cwd: path.resolve(import.meta.dirname, "../../../services/domain-api"),
      env: { ...process.env, VERRAIL_TEST_DATABASE_URL: database.connectionString }, timeout: 90_000,
    });
    expect(result.stdout).toContain("ok");
  }, 95_000);

  async function seed(options?: { dispatch?: Record<string, unknown>; permissionConfig?: unknown; ci?: boolean; permissionApiOrigin?: string;
    scope?: { workspaceId: string; targetId: string; targetRevisionId: string; graphRevisionId: string };
    executionIdentity?: { agentId: string; heartbeatRunId: string } }) {
    let workspaceId = options?.scope?.workspaceId;
    if (!workspaceId) {
      const [workspace] = await db.insert(companies).values({ name: "Synthetic Codex proof", issuePrefix: `CX${randomUUID().slice(0, 6)}` }).returning();
      workspaceId = workspace!.id;
    }
    const agentId = options?.executionIdentity?.agentId ?? randomUUID(), targetId = options?.scope?.targetId ?? randomUUID(), targetRevisionId = options?.scope?.targetRevisionId ?? randomUUID(),
      graphId = randomUUID(), graphRevisionId = options?.scope?.graphRevisionId ?? randomUUID(), workNodeId = randomUUID();
    const runId = randomUUID(), runAttemptId = randomUUID(), heartbeatRunId = options?.executionIdentity?.heartbeatRunId ?? randomUUID(), wakeId = randomUUID(), eventId = randomUUID(), leaseId = randomUUID();
    const agentDefinitionId = randomUUID(), agentVersionId = randomUUID(), deploymentId = randomUUID(), deploymentRevisionId = randomUUID(), evaluationRunId = randomUUID();
    const identity = { workspaceId, runId, attemptId: runAttemptId, heartbeatRunId, agentId, agentVersionId, deploymentRevisionId };
    await db.insert(agents).values({ id: agentId, companyId: workspaceId, name: "Synthetic", adapterType: "codex_local" });
    await db.insert(verrailTargets).values({ id: targetId, workspaceId, activeTargetRevisionId: targetRevisionId, ...author });
    await db.insert(verrailTargetRevisions).values({ id: targetRevisionId, workspaceId, targetId, revisionNumber: 1, title: "Test", goal: "Test",
      constraints: [], acceptanceCriteria: [], outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "test", riskLevel: "low", contentHash: hash, ...author });
    await db.insert(verrailWorkGraphs).values({ id: graphId, workspaceId, targetId, activeGraphRevisionId: graphRevisionId, status: "active" });
    await db.insert(verrailGraphRevisions).values({ id: graphRevisionId, workspaceId, targetId, targetRevisionId, workGraphId: graphId, revisionNumber: 1, status: "active", contentHash: hash, ...author });
    await db.insert(verrailWorkNodes).values({ id: workNodeId, workspaceId, targetId, graphRevisionId, nodeKey: "execute", kind: "agent_task", title: "Test", stageKey: "execute", status: "completed", completionDefinition: "Test" });
    await db.insert(verrailAgentDefinitions).values({ id: agentDefinitionId, workspaceId, compatibilityAgentId: agentId, name: "Test", ...author });
    await db.insert(verrailAgentVersions).values({ id: agentVersionId, workspaceId, agentDefinitionId, versionNumber: 1, runtime: "codex_local", model: "test-model", prompt: "PRIVATE PROMPT", contentHash: hash, ...author });
    await db.insert(verrailEvaluationRuns).values({ id: evaluationRunId, workspaceId, candidateAgentVersionId: agentVersionId, status: "passed", safetyStatus: "passed", ...author });
    await db.insert(verrailDeployments).values({ id: deploymentId, workspaceId, agentDefinitionId, name: "Test", ...author });
    await db.insert(verrailDeploymentRevisions).values({ id: deploymentRevisionId, workspaceId, deploymentId, revisionNumber: 1, agentVersionId, evaluationRunId, state: "active", runtimeConfig: { cwd: sourceDir, private: "PRIVATE CONFIG",
      ...(options?.permissionConfig === undefined ? {} : { permissionConfig: options.permissionConfig }) }, contentHash: hash, ...author });
    await db.insert(verrailRuns).values({ id: runId, workspaceId, targetId, targetRevisionId, graphRevisionId, workNodeId, kind: "agent", status: "succeeded", actorPrincipalType: "service", actorPrincipalId: "test", deploymentRevisionId, agentVersionId, attemptCount: 1, idempotencyKey: randomUUID() });
    await db.insert(verrailRunAttempts).values({ id: runAttemptId, workspaceId, runId, attemptNumber: 1, deploymentRevisionId, agentVersionId,
      runtimeProfile: "host_trusted", executorPrincipalType: "service", executorPrincipalId: "verrail-host-runner", fencingToken: 1, status: "running", lastEventCursor: 3, idempotencyKey: randomUUID() });
    await db.insert(verrailExecutionLeases).values({ id: leaseId, workspaceId, runId, runAttemptId, executorPrincipalId: "verrail-host-runner", runtimeProfile: "host_trusted", fencingToken: 1,
      status: "active", expiresAt: new Date(Date.now() + 60_000), graceExpiresAt: new Date(Date.now() + 60_000) });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: workspaceId, agentId, source: "on_demand", requestedByActorType: "system", requestedByActorId: "verrail-host-runner", idempotencyKey: `verrail-run-attempt:${runAttemptId}`, runId: heartbeatRunId });
    const handle = await logs.begin({ companyId: workspaceId, agentId, runId: heartbeatRunId });
    await logs.append(handle, { stream: "stdout", chunk: "PRIVATE LOG: 中文 UTF-8\n", ts: new Date().toISOString() });
    const summary = await logs.finalize(handle);
    await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId: workspaceId, agentId, wakeupRequestId: wakeId, status: "running" });
    const environment = await resolveNativeRunWorkspace(db, { heartbeatRunId, workspaceId, agentId,
      context: { verrailRunId: runId, verrailRunAttemptId: runAttemptId } });
    if (!environment) throw new Error("Synthetic native environment was not resolved");
    const beforeSource = await captureNativeSource({ cwd: sourceDir, identity, scopeVersion: 2 });
    const dispatchConfiguration = options?.dispatch ? await loadNativeDispatchConfiguration(db, identity, options.dispatch) : undefined;
    const permissionObservation = options?.permissionApiOrigin && dispatchConfiguration ? await observeNativePermissions({
      identity, dispatchSha256: dispatchConfiguration.sha256, apiOrigin: options.permissionApiOrigin,
      authToken: createLocalAgentJwt(agentId, workspaceId, "codex_local", heartbeatRunId)!,
    }) : undefined;
    if (options?.ci) {
      const output = path.join(sourceDir, ".verrail", "run-artifacts", runAttemptId);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 2,
        artifacts: [{ type: "source_snapshot", title: "Synthetic source", format: "git_bundle", scopeVersion: 2 }] }));
    }
    const baseReceipt = await captureNativeOutput({ cwd: sourceDir, identity, beforeSource, revalidate: async () => {}, storage: {
      putFile: async (input: { body: Buffer }) => {
        const sha256 = createHash("sha256").update(input.body).digest("hex");
        return { sha256, byteSize: input.body.length, objectKey: `${workspaceId}/verrail/run-artifacts/sha256/${sha256}` };
      },
    } as never });
    let facts = { heartbeatRunId, heartbeatStatus: "succeeded", agentId, logStore: handle.store, logRef: handle.logRef,
      logSha256: summary.sha256!, logBytes: summary.bytes, usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10,
        usageSource: "per_run", provider: "openai", model: "test-model", billingType: "subscription_included", costStatus: "unpriced", persistedSessionId: "PRIVATE SESSION" } as Record<string, unknown> | null,
      exitCode: 0, errorCode: null, environmentManifest: environment,
      ...(dispatchConfiguration ? { dispatchConfiguration } : {}), ...(permissionObservation ? { permissionObservation } : {}) };
    let receipt = finalizeNativeOutputReceipt(baseReceipt, facts);
    const context = { verrailRunId: runId, verrailRunAttemptId: runAttemptId, verrailTargetId: targetId, verrailTargetRevisionId: targetRevisionId,
      verrailGraphRevisionId: graphRevisionId, verrailWorkNodeId: workNodeId, verrailAgentVersionId: agentVersionId, verrailDeploymentRevisionId: deploymentRevisionId,
      verrailEnvironmentManifest: environment, [NATIVE_OUTPUT_CONTEXT_KEY]: receipt, verrailTaskMarkdown: "PRIVATE TASK",
      ...(dispatchConfiguration ? { [NATIVE_DISPATCH_CONTEXT_KEY]: dispatchConfiguration } : {}),
      ...(permissionObservation ? { [NATIVE_PERMISSION_CONTEXT_KEY]: permissionObservation } : {}) };
    const payload = () => ({ ...facts, outputReceipt: receipt, sourceObservation: beforeSource,
      artifacts: receipt.artifacts.map(({ title, kind, contentHash, contentRef }) => ({ title, kind, contentHash, contentRef })) });
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(beforeSource.observedAt), finishedAt: new Date(receipt.finalizedAt!),
      exitCode: 0, errorCode: null, usageJson: facts.usage, logStore: handle.store, logRef: handle.logRef, logSha256: summary.sha256, logBytes: summary.bytes, contextSnapshot: context }).where(eq(heartbeatRuns.id, heartbeatRunId));
    const terminalRecordedAt = new Date();
    await db.update(verrailRuns).set({ finishedAt: terminalRecordedAt }).where(eq(verrailRuns.id, runId));
    await db.update(verrailRunAttempts).set({ status: "succeeded", finishedAt: terminalRecordedAt }).where(eq(verrailRunAttempts.id, runAttemptId));
    await db.update(verrailExecutionLeases).set({ status: "released", releasedAt: terminalRecordedAt }).where(eq(verrailExecutionLeases.id, leaseId));
    await db.insert(verrailRunEvents).values({ id: eventId, workspaceId, runId, runAttemptId, cursor: 3, fencingToken: 1, eventType: "succeeded", payload: payload(), contentHash: hash, emittedAt: new Date(receipt.finalizedAt!) });
    const input = { workspaceId, targetId, targetRevisionId, graphRevisionId, runId, runAttemptId, heartbeatRunId };
    return { input, agentId, agentVersionId, deploymentRevisionId, graphId, eventId, wakeId, leaseId, handle, context, summary, dispatchConfiguration, receipt,
      load: () => loadCodexExecutionProofContext(db, input, { logs }),
      async usage(value: Record<string, unknown> | null) {
        facts = { ...facts, usage: value };
        receipt = finalizeNativeOutputReceipt(baseReceipt, facts);
        await db.update(heartbeatRuns).set({ usageJson: value, finishedAt: new Date(receipt.finalizedAt!), contextSnapshot: { ...context, [NATIVE_OUTPUT_CONTEXT_KEY]: receipt } }).where(eq(heartbeatRuns.id, heartbeatRunId));
        await db.update(verrailRunEvents).set({ payload: payload(), emittedAt: new Date(receipt.finalizedAt!) }).where(eq(verrailRunEvents.id, eventId));
        const recordedAt = new Date();
        await db.update(verrailRuns).set({ finishedAt: recordedAt }).where(eq(verrailRuns.id, runId));
        await db.update(verrailRunAttempts).set({ finishedAt: recordedAt }).where(eq(verrailRunAttempts.id, runAttemptId));
        await db.update(verrailExecutionLeases).set({ releasedAt: recordedAt }).where(eq(verrailExecutionLeases.id, leaseId));
      },
      get usageValue() { return { ...facts.usage }; },
    };
  }

  async function attachCi(s: Awaited<ReturnType<typeof seed>>, throughGo = false,
    delivery?: { kind: DeliveryProofKind; trust: Awaited<ReturnType<typeof deliveryRuntimeFixture>>["trust"]["ci"] }) {
    const { workspaceId, targetId, targetRevisionId, graphRevisionId, runId, runAttemptId } = s.input;
    const artifactId = randomUUID(), artifactRevisionId = randomUUID(), claimId = randomUUID(), workNodeId = randomUUID();
    const proofId = randomUUID(), integrationId = randomUUID(), evidenceId = randomUUID(), verificationId = randomUUID(), connectionId = delivery?.trust.connectionId ?? randomUUID();
    const snapshot = s.receipt.artifacts[0]!;
    if (!("sourceSnapshot" in snapshot)) throw new Error("Synthetic snapshot required");
    const sourceNodeId = s.context.verrailWorkNodeId;
    const criteria = [{ id: "fixed-ci", title: "Fixed CI", description: null, proofContract: { schemaVersion: 1 as const,
      allOf: [{ id: "ci", kind: "independent_verification" as const, phase: "pre_acceptance" as const,
        assertions: delivery ? [...DELIVERY_PROOF_ASSERTIONS[delivery.kind]] : ["ts_tests"] }] } }];
    await db.update(verrailTargetRevisions).set({ acceptanceCriteria: criteria }).where(eq(verrailTargetRevisions.id, targetRevisionId));
    await db.insert(verrailArtifacts).values({ id: artifactId, workspaceId, targetId, title: snapshot.title, kind: "code_change", ...author });
    await db.insert(verrailArtifactRevisions).values({ id: artifactRevisionId, workspaceId, artifactId, revisionNumber: 1,
      contentHash: snapshot.contentHash, contentRef: snapshot.contentRef, sourceRunId: runId, sourceWorkNodeId: sourceNodeId, ...author });
    await db.insert(verrailAuditEvents).values({ id: randomUUID(), workspaceId, principalType: "service", principalId: author.createdByPrincipalId,
      eventType: "assurance.artifact_revision_added.v1", aggregateType: "artifact_revision", aggregateId: artifactRevisionId, idempotencyKey: "source",
      payload: { schemaVersion: 1, resourceType: "artifact_revision", resourceId: artifactRevisionId, runId, runAttemptId, workNodeId: sourceNodeId, fencingToken: 1, contentHash: snapshot.contentHash } });
    await db.insert(verrailWorkNodes).values({ id: workNodeId, workspaceId, targetId, graphRevisionId, nodeKey: "verify", kind: "integration_task", title: "CI", stageKey: "verify", status: throughGo ? "ready" : "completed", completionDefinition: "CI" });
    await db.insert(verrailClaims).values({ id: claimId, workspaceId, targetId, targetRevisionId, criterionKey: "fixed-ci", title: "CI", status: "supported", ...author });
    const ciAuthor = { createdByPrincipalType: "service", createdByPrincipalId: "github-fixed-ci-verifier" };
    const [application] = await db.insert(toolApplications).values({ companyId: workspaceId, name: "Synthetic GitHub", type: "a2a" }).returning();
    await db.insert(toolConnections).values({ id: connectionId, companyId: workspaceId, applicationId: application!.id, name: "Synthetic GitHub", uid: connectionId,
      transport: "rest_api", authKind: "api_key", enabled: true, status: "active" });
    const commit = "c".repeat(40), externalRef = "https://github.com/test/repo/actions/runs/123/attempts/1", key = `ci:${integrationId}`;
    const trustProfile = delivery?.trust ?? { schemaVersion: 1, workspaceId, targetId, targetRevisionId, graphRevisionId, connectionId, bindingId: randomUUID(),
      policySha256: hash, repository: "test/repo", repositoryId: 1, workflowId: 2, workflowExecutionSha: commit, workflowSha256: hash, helperSha256: hash, maxAgeMs: 60000 };
    const command = { schemaVersion: 1, targetId, targetRevisionId, graphRevisionId, claimId, workNodeId, artifactRevisionId, criterionKey: "fixed-ci", requirementId: "ci",
      source: { runId, runAttemptId, runEventId: s.eventId, runEventContentHash: hash, outputReceiptSha256: s.receipt.sha256, artifactOrdinal: 0 },
      ci: { providerRunId: "123", providerAttempt: 1, testedCommit: commit, verifiedAt: new Date().toISOString(), artifactId: "456", archiveSha256: hash, reportSha256: hash, observationSha256: hash },
      mapping: { version: 1, commitTreeSha: "d".repeat(40), sourceSnapshotTreeSha: snapshot.sourceSnapshot.snapshotTree, sourceContentSha256: snapshot.sourceSnapshot.sourceContentSha256 } };
    const contractHash = digest(criteria[0]!.proofContract);
    const receipt = { kind: "verrail.fixed-ci-proof", schemaVersion: 1, verifierVersion: "github-fixed-ci-verifier.v1",
      trustProfileSha256: digest(trustProfile), trustProfile, input: command,
      criterionProof: { contractHash, requirementId: "ci", assertions: ["ts_tests"], targetRevisionId, graphRevisionId, commitRef: commit,
        verifiedAt: command.ci.verifiedAt, providerRunId: "123", providerAttempt: 1 } };
    const requestHash = digest({ input: command, trustProfileSha256: receipt.trustProfileSha256 });
    if (throughGo) {
      await db.insert(verrailGithubRepoBindings).values({ id: trustProfile.bindingId, workspaceId, connectionId,
        repoOwner: "test", repoName: "repo", ...author });
      if (delivery) return { artifactRevisionId, fixedCiProofId: proofId, integrationId, verificationId, command, receipt };
      const inputPath = path.join(logDir, `${integrationId}-go-input.json`), outputPath = path.join(logDir, `${integrationId}-go-output.json`);
      await writeFile(inputPath, JSON.stringify({ trustProfile, input: command, idempotencyKey: key }), { mode: 0o600 });
      await exec("go", ["test", "./internal/target", "-run", "^TestFixedCIProofBridgeRecord$", "-count=1"], {
        cwd: path.resolve(import.meta.dirname, "../../../services/domain-api"), timeout: 120_000,
        env: { ...process.env, VERRAIL_TEST_DATABASE_URL: database.connectionString, VERRAIL_TEST_FIXED_CI_RECORD_INPUT: inputPath,
          VERRAIL_TEST_FIXED_CI_RECORD_OUTPUT: outputPath },
      });
      const result = JSON.parse(await readFile(outputPath, "utf8")) as { integrationId: string; verificationId: string; fixedCiProofId: string };
      return { ...result, artifactRevisionId, command, receipt };
    }
    await db.insert(verrailEvidence).values({ id: evidenceId, workspaceId, targetId, claimId, kind: "ci_result", producerPrincipalType: "service", producerPrincipalId: ciAuthor.createdByPrincipalId,
      objectHash: snapshot.contentHash, reference: externalRef, trustLevel: "high", ...ciAuthor });
    await db.insert(verrailVerificationResults).values({ id: verificationId, workspaceId, targetId, claimId, verdict: "passed", verifierVersion: receipt.verifierVersion, evidenceIds: [evidenceId], resultHash: hash, ...ciAuthor });
    await db.insert(verrailIntegrationRuns).values({ id: integrationId, workspaceId, targetId, targetRevisionId, graphRevisionId, claimId, workNodeId, connectorVersion: receipt.verifierVersion,
      connectionId, provider: "github", externalRef, commitRef: commit, criterionKey: "fixed-ci", environmentRef: `github:test/repo:${commit}`, conclusion: "success",
      evidenceId, verificationResultId: verificationId, providerReceipt: receipt, idempotencyKey: key, ...ciAuthor });
    await db.insert(verrailIntegrationAttempts).values({ id: randomUUID(), workspaceId, integrationRunId: integrationId, attemptNumber: 1, connectorVersion: receipt.verifierVersion,
      connectionId, providerRef: externalRef, idempotencyKey: key, providerReceipt: receipt, status: "succeeded" });
    await db.insert(verrailCriterionProofs).values({ id: proofId, workspaceId, targetId, targetRevisionId, graphRevisionId, criterionKey: "fixed-ci", requirementId: "ci",
      phase: "pre_acceptance", contractHash, verificationResultId: verificationId, integrationRunId: integrationId, contextHash: hash, sourceIdentityHash: digest(proofId), sourcePayloadHash: requestHash });
    await db.insert(verrailAgentCommandReceipts).values({ id: randomUUID(), workspaceId, principalType: "service", principalId: ciAuthor.createdByPrincipalId,
      commandType: "github.fixed_ci_proof.record.v1", idempotencyKey: key, requestHash, response: { schemaVersion: 1, resourceType: "integration_run", resourceId: integrationId, replayed: false } });
    await db.insert(verrailAuditEvents).values({ id: randomUUID(), workspaceId, principalType: "service", principalId: ciAuthor.createdByPrincipalId, eventType: "connector.integration_run_recorded.v1",
      aggregateType: "integration_run", aggregateId: integrationId, idempotencyKey: key, payload: { schemaVersion: 1, resourceType: "integration_run", resourceId: integrationId } });
    return { artifactRevisionId, fixedCiProofId: proofId, integrationId, verificationId, command, receipt };
  }

  it.skipIf(process.env.VERRAIL_TEST_CODEX_GO_BRIDGE !== "1").each(["feishu_target", "codex_execution"] as const)(
    "collects %s through scoped reads, actual runtime witnesses and Go HTTP admission", async kind => {
      const [workspace] = await db.insert(companies).values({ name: "Synthetic closed proof", issuePrefix: `DP${randomUUID().slice(0, 6)}` }).returning();
      const scope = { workspaceId: workspace!.id, targetId: randomUUID(), targetRevisionId: randomUUID(), graphRevisionId: randomUUID() };
      const executionIdentity = { agentId: randomUUID(), heartbeatRunId: randomUUID() };
      const runtime = await deliveryRuntimeFixture(database.connectionString, scope, executionIdentity);
      const access = await provisionDeliveryProofReader(db, { workspaceId: scope.workspaceId, schemaVersion: 2,
        roleName: `verrail_proof_ro_${randomUUID().replaceAll("-", "").slice(0, 12)}`, databaseUrl: database.connectionString });
      const reader = createDb(access.databaseUrl, { maxConnections: 1 });
      const nativeFetch = globalThis.fetch;
      try {
        const authority = await assertDeliveryProofReader(reader, access);
        await runtime.start(authority.policySha256);
        vi.stubEnv("VERRAIL_RUNTIME_SESSION_ID", runtime.sessionId);
        vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "synthetic-native-permission-secret");
        const permissions = { engine: "cli", dangerouslyBypassApprovalsAndSandbox: false };
        const s = await seed({ scope, executionIdentity, ci: true, dispatch: { model: "test-model", ...permissions }, permissionConfig: permissions,
          permissionApiOrigin: runtime.apiOrigin });
        const ci = await attachCi(s, true, { kind, trust: runtime.trust.ci });
        const github = await githubDeliveryFixture(runtime, sourceDir);
        const channel = kind === "feishu_target" ? await channelDeliveryFixture(db, scope.workspaceId, runtime) : null;
        await runtime.finishHarness();
        if (channel) runtime.config = { ...runtime.config, channelProvider: channel.config };
        let submitted: string | undefined;
        vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url).startsWith(runtime.domainOrigin)) { submitted = String(init?.body); return nativeFetch(url, init); }
          if (String(url).startsWith("https://open.feishu.cn/")) return channel!.fetch(url);
          return github(url);
        });
        const request = { kind, idempotencyKey: `delivery:${randomUUID()}`, ci: { runId: "123", runAttempt: 1,
          claimId: ci.command.claimId, workNodeId: ci.command.workNodeId, artifactRevisionId: ci.artifactRevisionId, requirementId: "ci" },
          ...(channel ? { channel: channel.input } : { execution: { ...s.input, workspaceId: undefined } }) };
        if ("execution" in request) delete (request.execution as Partial<typeof s.input>).workspaceId;
        const wrong = structuredClone(request); wrong.ci.artifactRevisionId = randomUUID();
        await expect(recordDeliveryProof(reader, access, wrong, runtime.config, logs)).rejects.toThrow();
        expect(await db.select().from(verrailCriterionProofs).where(eq(verrailCriterionProofs.workspaceId, scope.workspaceId))).toHaveLength(0);
        const result = await recordDeliveryProof(reader, access, request, runtime.config, logs).catch(error => {
          throw new Error(`${error.message}; ${String(error.cause ?? "")}`);
        });
        expect(result.replayed).toBe(false);
        expect(await recordDeliveryProof(reader, access, request, runtime.config, logs)).toMatchObject({ resourceId: result.resourceId, replayed: true });
        const [integration] = await db.select().from(verrailIntegrationRuns).where(eq(verrailIntegrationRuns.id, result.resourceId));
        expect(integration).toMatchObject({ provider: "verrail", conclusion: "success" });
        const [verification] = await db.select().from(verrailVerificationResults).where(eq(verrailVerificationResults.id, integration!.verificationResultId!));
        expect(verification?.verdict).toBe("passed");
        expect(verification?.evidenceIds).toHaveLength(2);
        const evidence = await db.select().from(verrailEvidence).where(eq(verrailEvidence.workspaceId, scope.workspaceId));
        expect(evidence.map(item => item.kind).sort()).toEqual(["ci_result", "scan_result"]);
        expect(await db.select().from(verrailCriterionProofs).where(eq(verrailCriterionProofs.workspaceId, scope.workspaceId))).toHaveLength(1);
        const replay = await nativeFetch(`${runtime.domainOrigin}/v1/workspaces/${scope.workspaceId}/delivery-proofs`, {
          method: "POST", headers: { "content-type": "application/json", "idempotency-key": request.idempotencyKey }, body: submitted });
        expect(await replay.json()).toMatchObject({ resourceId: result.resourceId, replayed: true });
        const input = integration!.providerReceipt!.input as { observationJson: string };
        const observation = JSON.parse(input.observationJson);
        expect(observation.runtime.witnesses).toHaveLength(4);
        expect(observation.ci.unsupportedObligations).toContain("live_codex");
        if (kind === "codex_execution") expect(observation.execution.permissionObservation.probes.map((probe: { status: number }) => probe.status)).toEqual([200, 403, 401, 422]);
      } finally {
        vi.unstubAllGlobals(); vi.unstubAllEnvs();
        await runtime.close(); await reader.$client.end(); await removeDeliveryProofReader(db, access);
      }
    }, 120_000);

  it("loads native execution and fixed CI through a dedicated scoped database login", async () => {
    const s = await seed({ ci: true, dispatch: { model: "test-model", engine: "cli" } });
    const ci = await attachCi(s);
    const input = { ...s.input, artifactRevisionId: ci.artifactRevisionId, fixedCiProofId: ci.fixedCiProofId };
    const expected = await loadCodexExecutionProofContext(db, input, { logs });
    const access = await provisionDeliveryProofReader(db, { workspaceId: s.input.workspaceId,
      roleName: `verrail_proof_ro_${randomUUID().replaceAll("-", "").slice(0, 12)}`, databaseUrl: database.connectionString });
    const reader = createDb(access.databaseUrl, { maxConnections: 1 });
    try {
      await assertDeliveryProofReader(reader, access);
      expect(await loadCodexExecutionProofContext(reader, input, { logs })).toEqual(expected);
    } finally { await reader.$client.end(); await removeDeliveryProofReader(db, access); }
  });

  it("links a native source artifact and an already-admitted fixed CI proof to the exact Codex execution", async () => {
    const s = await seed({ ci: true }), ci = await attachCi(s);
    const result = await loadCodexExecutionProofContext(db, { ...s.input, artifactRevisionId: ci.artifactRevisionId, fixedCiProofId: ci.fixedCiProofId } as never, { logs });
    expect(result).toHaveProperty("artifactAndFixedCi.artifactRevisionId", ci.artifactRevisionId);
    expect(result).toHaveProperty("artifactAndFixedCi.fixedCiProofId", ci.fixedCiProofId);
    expect(result.unverified).not.toContain("artifact_and_fixed_ci_binding");
    expect(result.unverified).toContain("candidate_runtime_binding");
    const app = express();
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", companyIds: [s.input.workspaceId] } as never; next(); });
    app.use(deliveryContextRoutes(db, { logs }));
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: "request_failed" }));
    const { workspaceId, ...query } = s.input;
    const url = `/workspaces/${workspaceId}/delivery-context/codex`;
    const response = await request(app).get(url).query({ ...query, artifactRevisionId: ci.artifactRevisionId, fixedCiProofId: ci.fixedCiProofId });
    expect(response.status).toBe(200);
    expect(response.body.artifactAndFixedCi).toEqual(result.artifactAndFixedCi);
    expect((await request(app).get(url).query({ ...query, artifactRevisionId: ci.artifactRevisionId })).status).toBe(400);
    expect((await request(app).get(url).query({ ...query, fixedCiProofId: ci.fixedCiProofId })).status).toBe(400);
  });

  it.skipIf(process.env.VERRAIL_TEST_CODEX_GO_BRIDGE !== "1")("reads back an actual Go-admitted fixed CI proof without pre-seeding its authority records", async () => {
    const permissions = { engine: "cli", dangerouslyBypassApprovalsAndSandbox: false };
    const s = await seed({ ci: true, dispatch: { model: "test-model", ...permissions }, permissionConfig: permissions });
    const ci = await attachCi(s, true);
    const result = await loadCodexExecutionProofContext(db, { ...s.input, artifactRevisionId: ci.artifactRevisionId, fixedCiProofId: ci.fixedCiProofId }, { logs });
    expect(result.artifactAndFixedCi).toMatchObject({ binding: "linked_existing_proof", integrationRunId: ci.integrationId, verificationResultId: ci.verificationId });
    expect(result.dispatchConfiguration?.binding).toBe("version_bound");
    expect(result.unverified).not.toContain("artifact_and_fixed_ci_binding");
    expect(result.assurance).toBe("execution_context_only");
  }, 150_000);

  it.each(["foreign-proof", "foreign-artifact", "failed-verification", "missing-command", "missing-audit", "changed-source", "changed-mapping", "changed-contract", "changed-evidence", "changed-attempt"])("rejects broken artifact and CI association: %s", async mutation => {
    const s = await seed({ ci: true }), ci = await attachCi(s);
    const input = { ...s.input, artifactRevisionId: ci.artifactRevisionId, fixedCiProofId: ci.fixedCiProofId };
    if (mutation === "foreign-proof") input.fixedCiProofId = randomUUID();
    if (mutation === "foreign-artifact") input.artifactRevisionId = randomUUID();
    if (mutation === "failed-verification") await db.update(verrailVerificationResults).set({ verdict: "failed" }).where(eq(verrailVerificationResults.id, ci.verificationId));
    if (mutation === "missing-command") await db.delete(verrailAgentCommandReceipts).where(eq(verrailAgentCommandReceipts.workspaceId, s.input.workspaceId));
    if (mutation === "missing-audit") await db.delete(verrailAuditEvents).where(eq(verrailAuditEvents.aggregateId, ci.integrationId));
    if (mutation === "changed-source") ci.receipt.input.source.runAttemptId = randomUUID();
    if (mutation === "changed-mapping") ci.receipt.input.mapping.sourceSnapshotTreeSha = "e".repeat(40);
    if (mutation === "changed-source" || mutation === "changed-mapping") {
      await db.update(verrailIntegrationRuns).set({ providerReceipt: ci.receipt }).where(eq(verrailIntegrationRuns.id, ci.integrationId));
      await db.update(verrailIntegrationAttempts).set({ providerReceipt: ci.receipt }).where(eq(verrailIntegrationAttempts.integrationRunId, ci.integrationId));
    }
    if (mutation === "changed-contract") await db.update(verrailTargetRevisions).set({ acceptanceCriteria: [] }).where(eq(verrailTargetRevisions.id, s.input.targetRevisionId));
    if (mutation === "changed-evidence") await db.update(verrailEvidence).set({ objectHash: "e".repeat(64) }).where(eq(verrailEvidence.workspaceId, s.input.workspaceId));
    if (mutation === "changed-attempt") await db.update(verrailIntegrationAttempts).set({ status: "failed" }).where(eq(verrailIntegrationAttempts.integrationRunId, ci.integrationId));
    await expect(loadCodexExecutionProofContext(db, input, { logs })).rejects.toMatchObject({ status: 409 });
  });

  it("carries the real database-bound dispatch configuration through native finalization and readback", async () => {
    const permissions = { engine: "cli", dangerouslyBypassApprovalsAndSandbox: false };
    const s = await seed({ dispatch: { model: "test-model", ...permissions, env: { SECRET: "private" } }, permissionConfig: permissions });
    const result = await s.load();
    expect(result.dispatchConfiguration).toEqual(s.dispatchConfiguration);
    expect(result.dispatchConfiguration?.binding).toBe("version_bound");
    expect(result.unverified).toContain("effective_permission_enforcement");
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...s.context, [NATIVE_DISPATCH_CONTEXT_KEY]: null } }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });
  it.each([{ model: "foreign" }, { engine: "acp" }, { dangerouslyBypassApprovalsAndSandbox: true }, { extraArgs: ["--dangerously-bypass-approvals-and-sandbox"] }])("denies changed final dispatch fields using the real native binding: %j", async patch => {
    const permissions = { engine: "cli", dangerouslyBypassApprovalsAndSandbox: false };
    await expect(seed({ dispatch: { model: "test-model", ...permissions, ...patch }, permissionConfig: permissions }))
      .rejects.toThrow("NATIVE_DISPATCH_CONFIGURATION_INVALID");
  });

  it("reads real temporary database and log bytes through the authenticated HTTP route", async () => {
    const s = await seed();
    const app = express();
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", companyIds: [s.input.workspaceId] } as never; next(); });
    app.use(deliveryContextRoutes(db, { logs }));
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: "request_failed" }));
    const { workspaceId, ...query } = s.input;
    const url = `/workspaces/${workspaceId}/delivery-context/codex`;
    const response = await request(app).get(url).query(query);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual(JSON.parse(JSON.stringify(await s.load())));
    expect(response.body.assurance).toBe("execution_context_only");
    expect(response.body.unverified).toContain("effective_permission_enforcement");
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|sourceDir|logDir/);
    expect((await request(app).get(url).query({ ...query, passed: true })).status).toBe(400);
    await db.update(heartbeatRuns).set({ logSha256: "b".repeat(64) }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    expect((await request(app).get(url).query(query)).status).toBe(409);
  });

  it("validates exact bytes, versions and unpriced usage without publishing private data", async () => {
    const s = await seed(), context = await s.load();
    expect(context).toMatchObject({ schemaVersion: 1, assurance: "execution_context_only", runId: s.input.runId,
      runAttemptId: s.input.runAttemptId, heartbeatRunId: s.input.heartbeatRunId, agentVersionId: s.agentVersionId,
      log: { sha256: s.summary.sha256, bytes: s.summary.bytes, integrity: "verified" },
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, usageSource: "per_run", billingType: "subscription_included", costStatus: "unpriced", costUsd: null } });
    expect(context.contextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await s.load()).toEqual(context);
    for (const privateValue of ["PRIVATE", sourceDir, logDir, s.handle.logRef]) expect(JSON.stringify(context)).not.toContain(privateValue);
    expect(context).not.toHaveProperty("passed");
    expect(context.unverified).toContain("effective_permission_enforcement");
  });
  it("preserves explicitly reported zero and cache-adjusted cost, without subscription inference", async () => {
    const s = await seed();
    await s.usage({ ...s.usageValue, costStatus: "reported", billingType: "metered_api", costUsd: 0 });
    expect((await s.load()).usage.costUsd).toBe(0);
    await s.usage({ ...s.usageValue, costUsd: 1.5, cacheAdjustedCostUsd: 0.75, usageSource: "session_delta" });
    expect((await s.load()).usage).toMatchObject({ costUsd: 0.75, usageSource: "session_delta" });
  });
  it.each(["workspaceId", "targetId", "targetRevisionId", "graphRevisionId", "runId", "runAttemptId", "heartbeatRunId"] as const)("rejects foreign %s before log access", async key => {
    const s = await seed(), read = vi.fn();
    await expect(loadCodexExecutionProofContext(db, { ...s.input, [key]: randomUUID() }, { logs: { read } })).rejects.toMatchObject({ status: 409 });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["stale_graph", "run_failed", "new_attempt", "executor", "lease_fence", "lease_state", "wake_actor", "wake_key", "version_runtime", "deployment_cwd",
    "heartbeat_failed", "heartbeat_exit", "heartbeat_usage", "native_context", "native_finish_missing", "attempt_finish_missing", "event_time",
    "event_fence", "event_cursor", "event_missing", "receipt_hash", "log_missing", "log_path", "log_size", "log_compressed"])("rejects %s before reading logs", async change => {
    const s = await seed(), read = vi.fn();
    if (change === "stale_graph") await db.update(verrailWorkGraphs).set({ activeGraphRevisionId: null }).where(eq(verrailWorkGraphs.id, s.graphId));
    if (change === "run_failed") await db.update(verrailRuns).set({ status: "failed" }).where(eq(verrailRuns.id, s.input.runId));
    if (change === "new_attempt") await db.update(verrailRuns).set({ attemptCount: 2 }).where(eq(verrailRuns.id, s.input.runId));
    if (change === "executor") await db.update(verrailRunAttempts).set({ executorPrincipalId: "other" }).where(eq(verrailRunAttempts.id, s.input.runAttemptId));
    if (change === "lease_fence") await db.update(verrailExecutionLeases).set({ fencingToken: 2 }).where(eq(verrailExecutionLeases.id, s.leaseId));
    if (change === "lease_state") await db.update(verrailExecutionLeases).set({ status: "expired" }).where(eq(verrailExecutionLeases.id, s.leaseId));
    if (change === "wake_actor") await db.update(agentWakeupRequests).set({ requestedByActorType: "agent" }).where(eq(agentWakeupRequests.id, s.wakeId));
    if (change === "wake_key") await db.update(agentWakeupRequests).set({ idempotencyKey: "other" }).where(eq(agentWakeupRequests.id, s.wakeId));
    if (change === "version_runtime") await db.update(verrailAgentVersions).set({ runtime: "claude_local" }).where(eq(verrailAgentVersions.id, s.agentVersionId));
    if (change === "deployment_cwd") await db.update(verrailDeploymentRevisions).set({ runtimeConfig: { cwd: "/other" } }).where(eq(verrailDeploymentRevisions.id, s.deploymentRevisionId));
    if (change === "heartbeat_failed") await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    if (change === "heartbeat_exit") await db.update(heartbeatRuns).set({ exitCode: 1 }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    if (change === "heartbeat_usage") await db.update(heartbeatRuns).set({ usageJson: { ...s.usageValue, inputTokens: 999 } }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    if (change === "native_context") await db.update(heartbeatRuns).set({ contextSnapshot: { ...s.context, verrailTargetRevisionId: randomUUID() } }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    if (change === "native_finish_missing") await db.update(verrailRuns).set({ finishedAt: null }).where(eq(verrailRuns.id, s.input.runId));
    if (change === "attempt_finish_missing") await db.update(verrailRunAttempts).set({ finishedAt: null }).where(eq(verrailRunAttempts.id, s.input.runAttemptId));
    if (change === "event_time") await db.update(verrailRunEvents).set({ emittedAt: new Date(0) }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "event_fence") await db.update(verrailRunEvents).set({ fencingToken: 2 }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "event_cursor") await db.update(verrailRunEvents).set({ cursor: 4 }).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "event_missing") await db.delete(verrailRunEvents).where(eq(verrailRunEvents.id, s.eventId));
    if (change === "receipt_hash") await db.update(heartbeatRuns).set({ contextSnapshot: { ...s.context, [NATIVE_OUTPUT_CONTEXT_KEY]: { ...s.context[NATIVE_OUTPUT_CONTEXT_KEY], sha256: "b".repeat(64) } } }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    if (change === "log_missing") await db.update(heartbeatRuns).set({ logSha256: null }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    if (change === "log_path") await db.update(heartbeatRuns).set({ logRef: "../../private.ndjson" }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    if (change === "log_size") await db.update(heartbeatRuns).set({ logBytes: 16 * 1024 * 1024 + 1 }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    if (change === "log_compressed") await db.update(heartbeatRuns).set({ logCompressed: true }).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
    await expect(loadCodexExecutionProofContext(db, s.input, { logs: { read } })).rejects.toMatchObject({ status: 409 });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["missing", "source", "tokens", "fraction", "model", "unknown_provider", "unpriced_amount", "reported_missing", "negative_cost", "empty"])("rejects %s usage even with matching digest-validated receipts", async change => {
    const s = await seed();
    const usage = s.usageValue;
    if (change === "source") delete usage.usageSource;
    if (change === "tokens") delete usage.inputTokens;
    if (change === "fraction") usage.outputTokens = 0.5;
    if (change === "model") usage.model = "other-model";
    if (change === "unknown_provider") usage.provider = "unknown";
    if (change === "unpriced_amount") usage.costUsd = 0;
    if (change === "reported_missing") usage.costStatus = "reported";
    if (change === "negative_cost") { usage.costStatus = "reported"; usage.costUsd = -1; }
    if (change === "empty") { usage.inputTokens = 0; usage.cachedInputTokens = 0; usage.outputTokens = 0; }
    await s.usage(change === "missing" ? null : usage);
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });
  it.each(["changed", "truncated", "oversized", "error", "missing_object", "context_changed", "context_fingerprint"])("rejects %s log results", async change => {
    const s = await seed();
    const read = vi.fn(async () => {
      if (change === "error") throw new Error("PRIVATE STORAGE ERROR");
      if (change === "missing_object") await rm(path.join(logDir, s.handle.logRef));
      const result = await logs.read(s.handle, { offset: 0, limitBytes: s.summary.bytes + 1 });
      if (change === "changed") return { content: result.content.replace("PRIVATE", "CHANGED") };
      if (change === "truncated") return { ...result, nextOffset: s.summary.bytes };
      if (change === "oversized") return { content: result.content + "x" };
      if (change === "context_fingerprint") await db.update(verrailGraphRevisions).set({ contentHash: "b".repeat(64) }).where(eq(verrailGraphRevisions.id, s.input.graphRevisionId));
      else await db.update(verrailWorkGraphs).set({ activeGraphRevisionId: null }).where(eq(verrailWorkGraphs.id, s.graphId));
      return result;
    });
    await expect(loadCodexExecutionProofContext(db, s.input, { logs: { read } })).rejects.toMatchObject({ status: ["error", "missing_object"].includes(change) ? 502 : 409 });
    expect(read).toHaveBeenCalledWith(s.handle, { offset: 0, limitBytes: s.summary.bytes + 1 });
  });
  it.each(["heartbeat", "terminal_event"])("rejects ambiguous %s associations", async kind => {
    const s = await seed();
    if (kind === "terminal_event") {
      const [event] = await db.select().from(verrailRunEvents).where(eq(verrailRunEvents.id, s.eventId));
      await db.insert(verrailRunEvents).values({ ...event!, id: randomUUID(), cursor: 4 });
    } else {
      const [heartbeat] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.input.heartbeatRunId));
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, s.wakeId));
      const heartbeatId = randomUUID(), wakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({ ...wake!, id: wakeId, runId: heartbeatId });
      await db.insert(heartbeatRuns).values({ ...heartbeat!, id: heartbeatId, wakeupRequestId: wakeId });
    }
    const read = vi.fn();
    await expect(loadCodexExecutionProofContext(db, s.input, { logs: { read } })).rejects.toMatchObject({ status: 409 });
    expect(read).not.toHaveBeenCalled();
  });
  it("bounds the caller's wait for a log read and returns only a closed diagnostic", async () => {
    const s = await seed();
    const read = vi.fn(() => {
      vi.useFakeTimers();
      queueMicrotask(() => vi.advanceTimersByTime(10_001));
      return new Promise<never>(() => {});
    });
    try {
      await expect(loadCodexExecutionProofContext(db, s.input, { logs: { read } })).rejects.toMatchObject({ status: 502, message: "Codex execution log could not be verified" });
    } finally { vi.useRealTimers(); }
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("uses read-only repeatable snapshots on both sides of log access", async () => {
    const s = await seed(), spy = vi.spyOn(db, "transaction");
    try {
      await s.load();
      expect(spy).toHaveBeenCalledTimes(2);
      for (const call of spy.mock.calls) expect(call[1]).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
    } finally { spy.mockRestore(); }
  });
});

describe("Codex proof context boundaries", () => {
  const input = { workspaceId: randomUUID(), targetId: randomUUID(), targetRevisionId: randomUUID(), graphRevisionId: randomUUID(), runId: randomUUID(), runAttemptId: randomUUID(), heartbeatRunId: randomUUID() };
  it("rejects caller-supplied facts before I/O", async () => {
    const transaction = vi.fn(), read = vi.fn();
    await expect(loadCodexExecutionProofContext({ transaction } as never, { ...input, passed: true } as never, { logs: { read } })).rejects.toMatchObject({ status: 409 });
    expect(transaction).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it("redacts database errors", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("postgres://private:secret@host"));
    await expect(loadCodexExecutionProofContext({ transaction } as never, input, { logs: { read: vi.fn() } })).rejects.toMatchObject({ status: 503, message: "Codex execution proof context unavailable" });
  });
});
