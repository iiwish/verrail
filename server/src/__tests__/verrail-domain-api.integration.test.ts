import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, count, eq, sql } from "drizzle-orm";
import detectPort from "detect-port";
import {
  companies,
  companyMemberships,
  createDb,
  projects,
  verrailAuditEvents,
  verrailCommandReceipts,
  verrailOutboxEvents,
  verrailTargetRevisions,
  verrailTargets,
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
  let projectId: string;
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
    const [project] = await db.insert(projects).values({
      companyId: workspaceId,
      name: "Native Target",
    }).returning();
    projectId = project.id;
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
      projectId,
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
      db.select({ value: count() }).from(verrailAuditEvents).where(eq(verrailAuditEvents.aggregateId, created.targetId)),
      db.select({ value: count() }).from(verrailOutboxEvents).where(eq(verrailOutboxEvents.aggregateId, created.targetId)),
      db.select({ value: count() }).from(verrailCommandReceipts).where(eq(verrailCommandReceipts.targetId, created.targetId)),
    ]);
    expect(facts.map((rows) => rows[0]?.value)).toEqual([1, 1, 1, 1, 1]);
  });

  it("rolls back every fact when a later transaction write fails", async () => {
    const before = await Promise.all([
      db.select({ value: count() }).from(verrailTargets),
      db.select({ value: count() }).from(verrailTargetRevisions),
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
      db.select({ value: count() }).from(verrailAuditEvents),
      db.select({ value: count() }).from(verrailOutboxEvents),
      db.select({ value: count() }).from(verrailCommandReceipts),
    ]);
    expect(after.map((rows) => rows[0]?.value)).toEqual(before.map((rows) => rows[0]?.value));
  });

  it("fails closed for invalid transport, Principal, Project, and owner boundaries", async () => {
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
    const [otherProject] = await db.insert(projects).values({
      companyId: otherWorkspace.id,
      name: "Cross-workspace Project",
    }).returning();
    const crossWorkspaceProject = await create(
      validPayload({ projectId: otherProject.id }),
      "target:create:cross-workspace-project",
    );
    expect(crossWorkspaceProject.status).toBe(404);

    const invalidOwner = await create(
      validPayload({ outcomeOwner: { principalType: "user", principalId: "outside-user" } }),
      "target:create:outside-owner",
    );
    expect(invalidOwner.status).toBe(422);
    expect(await invalidOwner.json()).toMatchObject({ code: "TARGET_OWNER_INVALID" });
  });
});
