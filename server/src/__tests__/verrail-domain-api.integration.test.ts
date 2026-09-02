import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, count, eq, sql } from "drizzle-orm";
import detectPort from "detect-port";
import {
  companies,
  companyMemberships,
  createDb,
  verrailAuditEvents,
  verrailCollections,
  verrailCommandReceipts,
  verrailDeploymentRevisions,
  verrailExecutionLeases,
  verrailGraphRevisions,
  verrailOutboxEvents,
  verrailTargetRevisions,
  verrailTargets,
  verrailRuns,
  verrailRunAttempts,
  verrailRunEvents,
  verrailWorkNodes,
  verrailWorkGraphs,
} from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
const serviceRoot = fileURLToPath(new URL("../../../services/domain-api", import.meta.url));

async function waitForHealth(baseUrl: string, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Domain API exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The Go compiler or listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Domain API health timeout");
}

async function stopChild(child: ChildProcess | null) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  const exited = child.exitCode === null
    ? new Promise<void>((resolve) => child.once("exit", () => resolve()))
    : Promise.resolve();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

describeEmbeddedPostgres("Go Verrail Domain API Target command", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let child: ChildProcess | null = null;
  let db: ReturnType<typeof createDb>;
  let baseUrl: string;
  let workspaceId: string;
  let collectionId: string;
  const userId = `user-${randomUUID()}`;
  const token = `test-${randomUUID()}`;

  async function startChild() {
    const port = await detectPort(39_500);
    baseUrl = `http://127.0.0.1:${port}`;
    child = spawn("go", ["run", "./cmd/domain-api"], {
      cwd: serviceRoot,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        DATABASE_URL: tempDb!.connectionString,
        VERRAIL_DOMAIN_API_TOKEN: token,
        VERRAIL_DOMAIN_API_LISTEN: `127.0.0.1:${port}`,
      },
      stdio: "ignore",
    });
    await waitForHealth(baseUrl, child);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-go-target-");
    db = createDb(tempDb.connectionString);
    const [workspace] = await db.insert(companies).values({
      name: "Go Target Integration",
      issuePrefix: `G${Date.now().toString(36).slice(-5).toUpperCase()}`,
    }).returning();
    workspaceId = workspace.id;
    const [collection] = await db.insert(verrailCollections).values({
      workspaceId,
      name: "Native Target",
    }).returning();
    collectionId = collection.id;
    await db.insert(companyMemberships).values({
      companyId: workspaceId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });

    await startChild();
  }, 60_000);

  afterAll(async () => {
    await stopChild(child);
    await tempDb?.cleanup();
  }, 30_000);

  function create(
    payload: Record<string, unknown>,
    key: string,
    options: { authToken?: string; principalType?: string; principalId?: string } = {},
  ) {
    return fetch(`${baseUrl}/v1/workspaces/${workspaceId}/targets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.authToken ?? token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-Verrail-Principal-Type": options.principalType ?? "user",
        "X-Verrail-Principal-Id": options.principalId ?? userId,
      },
      body: JSON.stringify(payload),
    });
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      collectionId,
      title: "Create governed native Target",
      summary: "One Go-owned vertical slice",
      outcomeOwner: { principalType: "user", principalId: userId },
      goal: "Persist a reviewable Target and immutable revision.",
      constraints: ["One authoritative writer", "No Temporal in this slice"],
      acceptanceCriteria: [
        { title: "Atomic facts", description: "Target, revision, audit, outbox, and receipt commit together." },
      ],
      riskLevel: "high",
      policySummary: "Human-created, Workspace-scoped",
      ...overrides,
    };
  }

  function command(path: string, payload: Record<string, unknown> | null, key: string) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-Verrail-Principal-Type": "user",
        "X-Verrail-Principal-Id": userId,
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  }

  function executorCommand(path: string, payload: Record<string, unknown>, key: string, executorId = "host-trusted-integration") {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-Verrail-Principal-Type": "service",
        "X-Verrail-Principal-Id": executorId,
      },
      body: JSON.stringify(payload),
    });
  }

  it("creates all governed facts atomically and replays the original result", async () => {
    const key = "target:create:go-integration";
    const first = await create(validPayload(), key);
    expect(first.status).toBe(201);
    const created = await first.json() as { targetId: string; targetRevisionId: string; replayed: boolean };
    expect(created).toMatchObject({ replayed: false });
    expect(created.targetId).toMatch(/^[0-9a-f-]{36}$/);

    await stopChild(child);
    child = null;
    await startChild();

    const replay = await create(validPayload(), key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      targetId: created.targetId,
      targetRevisionId: created.targetRevisionId,
      replayed: true,
    });

    const conflict = await create(validPayload({ title: "Different content" }), key);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "TARGET_IDEMPOTENCY_CONFLICT" });

    const facts = await Promise.all([
      db.select({ value: count() }).from(verrailTargets).where(eq(verrailTargets.id, created.targetId)),
      db.select({ value: count() }).from(verrailTargetRevisions).where(eq(verrailTargetRevisions.targetId, created.targetId)),
      db.select({ value: count() }).from(verrailWorkGraphs).where(eq(verrailWorkGraphs.targetId, created.targetId)),
      db.select({ value: count() }).from(verrailGraphRevisions).where(eq(verrailGraphRevisions.targetId, created.targetId)),
      db.select({ value: count() }).from(verrailAuditEvents).where(eq(verrailAuditEvents.aggregateId, created.targetId)),
      db.select({ value: count() }).from(verrailOutboxEvents).where(eq(verrailOutboxEvents.aggregateId, created.targetId)),
      db.select({ value: count() }).from(verrailCommandReceipts).where(eq(verrailCommandReceipts.targetId, created.targetId)),
    ]);
    expect(facts.map((rows) => rows[0]?.value)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("activates a native WorkGraph and creates an idempotent Run", async () => {
    const targetResponse = await create(validPayload({ title: "Graph-owned Target" }), "target:create:graph-integration");
    expect(targetResponse.status).toBe(201);
    const target = await targetResponse.json() as {
      targetId: string;
      targetRevisionId: string;
      graphRevisionId: string;
    };
    const completionDefinition = "A reviewer-visible execution result is attached.";

    const definitionResponse = await command(
      `/v1/workspaces/${workspaceId}/agent-definitions`,
      { name: "Integration executor", description: "Version-bound graph fixture" },
      "agent-definition:create:graph-integration",
    );
    expect(definitionResponse.status).toBe(201);
    const definition = await definitionResponse.json() as { resourceId: string };
    const versionResponse = await command(
      `/v1/workspaces/${workspaceId}/agent-definitions/${definition.resourceId}/versions`,
      {
        runtime: "test-runtime",
        model: "test-model",
        prompt: "Execute only the assigned governed WorkNode.",
        skills: [],
        tools: [],
        outputSchema: {},
        capabilityCeiling: [],
        supplyChain: { fixture: true },
      },
      "agent-version:publish:graph-integration",
    );
    expect(versionResponse.status).toBe(201);
    const version = await versionResponse.json() as { resourceId: string };
    const evaluationResponse = await command(
      `/v1/workspaces/${workspaceId}/evaluation-runs`,
      {
        candidateAgentVersionId: version.resourceId,
        status: "passed",
        qualityScore: 100,
        costCents: 1,
        latencyMs: 1,
        safetyStatus: "passed",
        summary: "Integration fixture passed",
      },
      "evaluation:record:graph-integration",
    );
    expect(evaluationResponse.status).toBe(201);
    const evaluation = await evaluationResponse.json() as { resourceId: string };
    const deploymentResponse = await command(
      `/v1/workspaces/${workspaceId}/deployments`,
      {
        agentDefinitionId: definition.resourceId,
        agentVersionId: version.resourceId,
        evaluationRunId: evaluation.resourceId,
        name: "Integration deployment",
        isDefault: true,
        runtimeConfig: {},
      },
      "deployment:create:graph-integration",
    );
    expect(deploymentResponse.status).toBe(201);
    const deployment = await deploymentResponse.json() as { resourceId: string };
    const [deploymentRevision] = await db.select().from(verrailDeploymentRevisions).where(
      eq(verrailDeploymentRevisions.deploymentId, deployment.resourceId),
    );
    expect(deploymentRevision).toBeDefined();

    const graphResponse = await command(
      `/v1/workspaces/${workspaceId}/targets/${target.targetId}/graph-revisions`,
      {
        expectedTargetRevisionId: target.targetRevisionId,
        nodes: [{
          nodeKey: "execute",
          kind: "agent_task",
          stage: "execute",
          title: "Execute governed work",
          responsiblePrincipal: { principalType: "agent", principalId: deploymentRevision!.id },
          dependencyNodeKeys: [],
          completionDefinition,
        }],
      },
      "graph:create:integration",
    );
    expect(graphResponse.status).toBe(201);
    const graph = await graphResponse.json() as { graphRevisionId: string; revisionNumber: number };
    expect(graph.revisionNumber).toBe(2);

    const activation = await command(
      `/v1/workspaces/${workspaceId}/targets/${target.targetId}/graph-revisions/${graph.graphRevisionId}/activate`,
      null,
      "graph:activate:integration",
    );
    expect(activation.status).toBe(200);
    const activationReplay = await command(
      `/v1/workspaces/${workspaceId}/targets/${target.targetId}/graph-revisions/${graph.graphRevisionId}/activate`,
      null,
      "graph:activate:integration",
    );
    expect(activationReplay.status).toBe(200);
    expect(await activationReplay.json()).toMatchObject({ graphRevisionId: graph.graphRevisionId, replayed: true });
    const activationConflict = await command(
      `/v1/workspaces/${workspaceId}/targets/${target.targetId}/graph-revisions/${target.graphRevisionId}/activate`,
      null,
      "graph:activate:integration",
    );
    expect(activationConflict.status).toBe(409);
    expect(await activationConflict.json()).toMatchObject({ code: "TARGET_IDEMPOTENCY_CONFLICT" });
    const [node] = await db.select().from(verrailWorkNodes).where(eq(
      verrailWorkNodes.graphRevisionId,
      graph.graphRevisionId,
    ));
    expect(node).toMatchObject({ status: "ready", completionDefinition });

    const runPath = `/v1/workspaces/${workspaceId}/targets/${target.targetId}/graph-revisions/${graph.graphRevisionId}/nodes/${node!.id}/runs`;
    const runInput = { kind: "agent_run", actor: { principalType: "agent", principalId: deploymentRevision!.id } };
    const run = await command(runPath, runInput, "run:create:integration");
    expect(run.status).toBe(201);
    const createdRun = await run.json() as { runId: string };
    expect(await db.select().from(verrailRuns).where(eq(verrailRuns.id, createdRun.runId))).toEqual([
      expect.objectContaining({
        status: "queued",
        kind: "agent",
        workNodeId: node!.id,
        deploymentRevisionId: deploymentRevision!.id,
        agentVersionId: version.resourceId,
      }),
    ]);

    const replay = await command(runPath, runInput, "run:create:integration");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ runId: createdRun.runId, replayed: true });
    const conflict = await command(
      runPath,
      { kind: "agent_run", actor: { principalType: "agent", principalId: "agent-runtime-2" } },
      "run:create:integration",
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "TARGET_IDEMPOTENCY_CONFLICT" });

    const attemptPath = `/v1/workspaces/${workspaceId}/runs/${createdRun.runId}/attempts`;
    const attemptInput = {
      runtimeProfile: "host_trusted",
      executor: { principalType: "service", principalId: "host-trusted-integration" },
      leaseDurationSeconds: 120,
      graceDurationSeconds: 30,
    };
    const firstAttemptResponse = await command(attemptPath, attemptInput, "attempt:create:first");
    expect(firstAttemptResponse.status).toBe(201);
    const firstAttempt = await firstAttemptResponse.json() as { runAttemptId: string; leaseId: string; fencingToken: number };
    const firstEventPath = `${attemptPath}/${firstAttempt.runAttemptId}/events`;
    const report = (path: string, key: string, attempt: typeof firstAttempt, cursor: number, eventType: string, payload: Record<string, unknown> = {}) => executorCommand(path, {
      leaseId: attempt.leaseId,
      fencingToken: attempt.fencingToken,
      cursor,
      eventType,
      emittedAt: new Date().toISOString(),
      payload,
    }, key);
    expect((await report(firstEventPath, "event:first:claim", firstAttempt, 1, "claimed")).status).toBe(201);
    expect((await report(firstEventPath, "event:first:start", firstAttempt, 2, "started")).status).toBe(201);
    expect((await report(firstEventPath, "event:first:failed", firstAttempt, 3, "failed", { errorCode: "TEST_FAILURE", errorMessage: "retry me" })).status).toBe(201);

    const secondAttemptResponse = await command(attemptPath, attemptInput, "attempt:create:second");
    expect(secondAttemptResponse.status).toBe(201);
    const secondAttempt = await secondAttemptResponse.json() as typeof firstAttempt;
    expect(secondAttempt.fencingToken).toBeGreaterThan(firstAttempt.fencingToken);
    const stale = await report(firstEventPath, "event:first:stale", firstAttempt, 4, "heartbeat");
    expect(stale.status).toBe(202);
    expect(await stale.json()).toMatchObject({ authoritative: false, rejectionCode: "STALE_FENCING_TOKEN" });

    const secondEventPath = `${attemptPath}/${secondAttempt.runAttemptId}/events`;
    expect((await report(secondEventPath, "event:second:claim", secondAttempt, 1, "claimed")).status).toBe(201);
    expect((await report(secondEventPath, "event:second:start", secondAttempt, 2, "started")).status).toBe(201);
    const cancel = await command(`/v1/workspaces/${workspaceId}/runs/${createdRun.runId}/cancel`, null, "run:cancel:second");
    expect(cancel.status).toBe(200);
    const lateProgress = await report(secondEventPath, "event:second:late-progress", secondAttempt, 3, "progress");
    expect(lateProgress.status).toBe(202);
    expect(await lateProgress.json()).toMatchObject({ authoritative: false, rejectionCode: "CANCELLATION_IN_PROGRESS" });
    expect((await report(secondEventPath, "event:second:cancel-ack", secondAttempt, 3, "cancel_acknowledged")).status).toBe(201);
    expect((await report(secondEventPath, "event:second:terminated", secondAttempt, 4, "terminated")).status).toBe(201);

    const [attemptRows, leaseRows, eventRows, finalRun] = await Promise.all([
      db.select().from(verrailRunAttempts).where(eq(verrailRunAttempts.runId, createdRun.runId)),
      db.select().from(verrailExecutionLeases).where(eq(verrailExecutionLeases.runId, createdRun.runId)),
      db.select().from(verrailRunEvents).where(eq(verrailRunEvents.runId, createdRun.runId)),
      db.select().from(verrailRuns).where(eq(verrailRuns.id, createdRun.runId)).then((rows) => rows[0]),
    ]);
    expect(attemptRows.map((attempt) => attempt.status)).toEqual(["failed", "canceled"]);
    expect(leaseRows.map((lease) => lease.status)).toEqual(["released", "released"]);
    expect(eventRows).toHaveLength(7);
    expect(finalRun).toMatchObject({ status: "canceled", attemptCount: 2 });
  });

  it("rolls back every fact when a later transaction write fails", async () => {
    const before = await Promise.all([
      db.select({ value: count() }).from(verrailTargets),
      db.select({ value: count() }).from(verrailTargetRevisions),
      db.select({ value: count() }).from(verrailWorkGraphs),
      db.select({ value: count() }).from(verrailGraphRevisions),
      db.select({ value: count() }).from(verrailAuditEvents),
      db.select({ value: count() }).from(verrailOutboxEvents),
      db.select({ value: count() }).from(verrailCommandReceipts),
    ]);
    await db.execute(sql.raw(`
      create function verrail_test_fail_audit() returns trigger language plpgsql as $$
      begin raise exception 'forced audit failure'; end $$;
      create trigger verrail_test_fail_audit_trigger before insert on verrail_audit_events
      for each row execute function verrail_test_fail_audit();
    `));
    try {
      const response = await create(validPayload({ title: "Must roll back" }), "target:create:rollback-test");
      expect(response.status).toBe(500);
    } finally {
      await db.execute(sql.raw(`
        drop trigger if exists verrail_test_fail_audit_trigger on verrail_audit_events;
        drop function if exists verrail_test_fail_audit();
      `));
    }
    const after = await Promise.all([
      db.select({ value: count() }).from(verrailTargets),
      db.select({ value: count() }).from(verrailTargetRevisions),
      db.select({ value: count() }).from(verrailWorkGraphs),
      db.select({ value: count() }).from(verrailGraphRevisions),
      db.select({ value: count() }).from(verrailAuditEvents),
      db.select({ value: count() }).from(verrailOutboxEvents),
      db.select({ value: count() }).from(verrailCommandReceipts),
    ]);
    expect(after.map((rows) => rows[0]?.value)).toEqual(before.map((rows) => rows[0]?.value));
  });

  it("fails closed for invalid transport, Principal, Collection, and owner boundaries", async () => {
    const unauthorized = await create(validPayload(), "target:create:bad-token", { authToken: "wrong-token" });
    expect(unauthorized.status).toBe(401);

    const agentPrincipal = await create(validPayload(), "target:create:agent-principal", {
      principalType: "agent",
      principalId: randomUUID(),
    });
    expect(agentPrincipal.status).toBe(403);

    const nonMember = await create(validPayload(), "target:create:non-member", {
      principalId: `outside-${randomUUID()}`,
    });
    expect(nonMember.status).toBe(403);

    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
      eq(companyMemberships.companyId, workspaceId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
    ));
    try {
      const viewer = await create(validPayload(), "target:create:viewer");
      expect(viewer.status).toBe(403);
    } finally {
      await db.update(companyMemberships).set({ membershipRole: "owner" }).where(and(
        eq(companyMemberships.companyId, workspaceId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ));
    }

    const [otherWorkspace] = await db.insert(companies).values({
      name: "Other Workspace",
      issuePrefix: `X${Date.now().toString(36).slice(-5).toUpperCase()}`,
    }).returning();
    const [otherCollection] = await db.insert(verrailCollections).values({
      workspaceId: otherWorkspace.id,
      name: "Cross-workspace Collection",
    }).returning();
    const crossWorkspaceCollection = await create(
      validPayload({ collectionId: otherCollection.id }),
      "target:create:cross-workspace-collection",
    );
    expect(crossWorkspaceCollection.status).toBe(404);

    const invalidOwner = await create(
      validPayload({ outcomeOwner: { principalType: "user", principalId: "outside-user" } }),
      "target:create:outside-owner",
    );
    expect(invalidOwner.status).toBe(422);
    expect(await invalidOwner.json()).toMatchObject({ code: "TARGET_OWNER_INVALID" });
  });
});
