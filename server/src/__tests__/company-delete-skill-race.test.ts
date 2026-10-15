import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, companySkills, createDb, goals, verrailConversationMessages, verrailConversations, type Db } from "@paperclipai/db";
import { companyService } from "../services/companies.js";
import { companySkillService } from "../services/company-skills.js";
import { conversationService } from "../services/conversations.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

describe("company deletion versus skill inventory", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let fixtureClosed = false;
  const connections: Db[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-delete-skill-race-");
    if (fixtureClosed) {
      await started.cleanup();
      throw new Error("PostgreSQL fixture completed after test teardown");
    }
    database = started;
    db = createDb(database.connectionString, { maxConnections: 1 });
  }, 60_000);

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.$client.end({ timeout: 1 })));
    await db.delete(companySkills);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    fixtureClosed = true;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  async function connection() {
    const connected = createDb(database.connectionString, { maxConnections: 1 });
    connections.push(connected);
    await connected.execute(sql`set statement_timeout = '10s'`);
    const [row] = await connected.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    return { db: connected, pid: row!.pid };
  }

  async function workspace() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Deletion race fixture", issuePrefix: `R${id.replaceAll("-", "")}` });
    return id;
  }

  function skill(companyId: string) {
    return { companyId, key: `fixture/${randomUUID()}`, slug: "fixture", name: "Fixture", markdown: "# Fixture" };
  }

  async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
    const deadline = Date.now() + 5_000;
    do {
      const value = await read();
      if (value !== null) return value;
      await nextTurn();
    } while (Date.now() < deadline);
    throw new Error(`PostgreSQL barrier not reached: ${label}`);
  }

  async function waitingQuery(pid: number) {
    const [row] = await db.execute<{ query: string }>(sql`
      select query from pg_stat_activity
      where pid = ${pid} and state = 'active' and wait_event_type = 'Lock'
    `);
    return row?.query ?? null;
  }

  it.each(["canonical", "uppercase", "compact"] as const)("deletion wins with %s UUID identity without crossing workspace boundaries", async (identity) => {
    const companyId = await workspace();
    const deletionId = identity === "uppercase" ? companyId.toUpperCase()
      : identity === "compact" ? companyId.replaceAll("-", "") : companyId;
    const independentId = await workspace();
    const survivorId = await workspace();
    const [survivorSkill] = await db.insert(companySkills).values(skill(survivorId)).returning();
    const [goal] = await db.insert(goals).values({ companyId, title: "Deletion barrier" }).returning();
    const controller = await connection();
    const remover = await connection();
    const refresher = await connection();
    const independent = await connection();
    const locked = barrier();
    const release = barrier();
    const holding = settle(controller.db.transaction(async (tx) => {
      await tx.select().from(goals).where(eq(goals.id, goal!.id)).for("update");
      locked.release();
      await release.promise;
    }));
    await locked.promise;
    const removal = settle(companyService(remover.db).remove(deletionId));
    let refresh: ReturnType<typeof settle> | undefined;
    try {
      const query = await waitFor(() => waitingQuery(remover.pid), "delete after skill cleanup");
      expect(query).toMatch(/delete from "goals"/i);
      let refreshSettled = false;
      refresh = settle(companySkillService(refresher.db).list(companyId)).then((result) => {
        refreshSettled = true;
        return result;
      });
      await waitFor(async () => refreshSettled ? "settled" : await waitingQuery(refresher.pid), "late inventory outcome or lifecycle wait");
      await expect(companySkillService(independent.db).list(independentId)).resolves.toBeInstanceOf(Array);
      await expect(companyService(independent.db).remove(independentId)).resolves.toMatchObject({ id: independentId });
      expect(await db.select().from(companySkills).where(eq(companySkills.id, survivorSkill!.id))).toEqual([survivorSkill]);
      release.release();
      await holding;
      const removed = await removal;
      expect(removed.status, JSON.stringify(removed)).toBe("fulfilled");
      expect(removed).toMatchObject({ value: { id: companyId } });
      expect(await refresh).toMatchObject({ status: "rejected", reason: { status: 404, message: "Company not found" } });
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toEqual([]);
      expect(await db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).toEqual([]);
      await expect(companySkillService(refresher.db).list(companyId)).rejects.toMatchObject({ status: 404 });
    } finally {
      release.release();
      await holding;
      await removal;
      await refresh;
    }
  }, 20_000);

  it("an earlier inventory insertion wins the lifecycle lock and deletion waits before child cleanup", async () => {
    const companyId = await workspace();
    const controller = await connection();
    const writer = await connection();
    const remover = await connection();
    const locked = barrier();
    const release = barrier();
    const fixtureLock = `fixture:skill-insert:${companyId}`;
    await db.execute(sql.raw(`create function hold_fixture_skill_insert() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(hashtextextended('${fixtureLock}', 0)); return new; end $$`));
    await db.execute(sql.raw(`create trigger hold_fixture_skill_insert after insert on company_skills
      for each row when (new.company_id = '${companyId}'::uuid) execute function hold_fixture_skill_insert()`));
    const holding = settle(controller.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${fixtureLock}, 0))`);
      locked.release();
      await release.promise;
    }));
    await locked.promise;
    const writing = settle(companySkillService(writer.db).list(companyId));
    let removal: ReturnType<typeof settle> | undefined;
    try {
      expect(await waitFor(() => waitingQuery(writer.pid), "inventory insert trigger")).toMatch(/insert into "company_skills"/i);
      removal = settle(companyService(remover.db).remove(companyId));
      const query = await waitFor(() => waitingQuery(remover.pid), "skill inventory lifecycle lock");
      expect(query).toMatch(/pg_advisory_xact_lock/i);
      release.release();
      await holding;
      expect(await removal).toMatchObject({ status: "fulfilled", value: { id: companyId } });
      const written = await writing;
      if (written.status === "rejected") expect(written.reason).toMatchObject({ status: 404 });
      expect(await db.select().from(companySkills).where(eq(companySkills.companyId, companyId))).toEqual([]);
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toEqual([]);
      await expect(companyService(remover.db).remove(companyId)).resolves.toBeNull();
    } finally {
      release.release();
      await holding;
      await writing;
      await removal;
      await db.execute(sql`drop trigger hold_fixture_skill_insert on company_skills`);
      await db.execute(sql`drop function hold_fixture_skill_insert()`);
    }
  }, 15_000);

  it("a failed parent delete rolls back child cleanup and releases the lifecycle lock", async () => {
    const companyId = await workspace();
    const [before] = await db.insert(companySkills).values(skill(companyId)).returning();
    await db.execute(sql.raw(`create function reject_fixture_company_delete() returns trigger language plpgsql as $$
      begin raise exception 'fixture parent delete failure'; end $$`));
    await db.execute(sql.raw(`create trigger reject_fixture_company_delete before delete on companies
      for each row when (old.id = '${companyId}'::uuid) execute function reject_fixture_company_delete()`));
    try {
      await expect(companyService(db).remove(companyId)).rejects.toThrow();
      expect(await db.select().from(companySkills).where(eq(companySkills.id, before!.id))).toEqual([before]);
      expect(await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId))).toEqual([{ id: companyId }]);
    } finally {
      await db.execute(sql`drop trigger reject_fixture_company_delete on companies`);
      await db.execute(sql`drop function reject_fixture_company_delete()`);
    }
    await expect(companyService(db).remove(companyId)).resolves.toMatchObject({ id: companyId });
  });

  it("does not invert the existing conversation-row then parent-FK lock order", async () => {
    const companyId = await workspace();
    const [conversation] = await db.insert(verrailConversations).values({
      workspaceId: companyId, createdByPrincipalType: "user", createdByPrincipalId: "fixture",
    }).returning();
    const controller = await connection();
    const writer = await connection();
    const remover = await connection();
    const locked = barrier();
    const release = barrier();
    const fixtureLock = `fixture:conversation-insert:${companyId}`;
    await db.execute(sql.raw(`create function hold_fixture_message_insert() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(hashtextextended('${fixtureLock}', 0)); return new; end $$`));
    await db.execute(sql.raw(`create trigger hold_fixture_message_insert before insert on verrail_conversation_messages
      for each row when (new.workspace_id = '${companyId}'::uuid) execute function hold_fixture_message_insert()`));
    const holding = settle(controller.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${fixtureLock}, 0))`);
      locked.release();
      await release.promise;
    }));
    await locked.promise;
    const writing = settle(conversationService(writer.db).appendMessage(companyId, conversation!.id, {
      role: "user", body: "Fixture message",
    }));
    let removal: ReturnType<typeof settle> | undefined;
    try {
      expect(await waitFor(() => waitingQuery(writer.pid), "message insert trigger")).toMatch(/insert into "verrail_conversation_messages"/i);
      removal = settle(companyService(remover.db).remove(companyId));
      const deleteQuery = await waitFor(() => waitingQuery(remover.pid), "delete waiting for conversation row");
      expect(deleteQuery).toMatch(/delete from "verrail_conversations"/i);
      release.release();
      await holding;
      expect(await writing).toMatchObject({ status: "fulfilled", value: { body: "Fixture message" } });
      expect(await removal).toMatchObject({ status: "fulfilled", value: { id: companyId } });
      expect(await db.select().from(verrailConversations).where(eq(verrailConversations.workspaceId, companyId))).toEqual([]);
      expect(await db.select().from(verrailConversationMessages).where(eq(verrailConversationMessages.workspaceId, companyId))).toEqual([]);
    } finally {
      release.release();
      await holding;
      await writing;
      await removal;
      await db.execute(sql`drop trigger hold_fixture_message_insert on verrail_conversation_messages`);
      await db.execute(sql`drop function hold_fixture_message_insert()`);
    }
  }, 15_000);
});

function inventoryFailureDatabase(companyId: string, error: unknown, afterFirstCheck: boolean | Error = false) {
  let checks = 0;
  const release = barrier();
  const database = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          then: async (resolve: (rows: Array<{ id: string }>) => unknown) => {
            if (table === companies) {
              checks += 1;
              if (checks > 1 && afterFirstCheck instanceof Error) throw afterFirstCheck;
              return resolve(checks === 1 || afterFirstCheck === true ? [{ id: companyId }] : []);
            }
            expect(table).toBe(companySkills);
            await release.promise;
            throw error;
          },
        }),
      }),
    }),
  } as unknown as Db;
  return { database, release: release.release, checks: () => checks };
}

describe("inventory deletion error boundary", () => {
  for (const constraint of [
    "company_skills_company_id_companies_id_fk",
    "company_skill_versions_company_id_companies_id_fk",
    "folders_company_id_companies_id_fk",
  ]) {
    it(`maps deleted-parent ${constraint} for all shared-refresh waiters`, async () => {
      const companyId = randomUUID();
      const failure = new Error("wrapped fixture", { cause: { code: "23503", constraint_name: constraint } });
      const fixture = inventoryFailureDatabase(companyId, failure);
      const service = companySkillService(fixture.database);
      const first = settle(service.list(companyId));
      const second = settle(service.list(companyId));
      fixture.release();
      expect(await first).toMatchObject({ status: "rejected", reason: { status: 404, message: "Company not found" } });
      expect(await second).toMatchObject({ status: "rejected", reason: { status: 404, message: "Company not found" } });
      expect(fixture.checks()).toBe(2);
      await expect(service.list(companyId)).rejects.toMatchObject({ status: 404 });
      expect(fixture.checks()).toBe(3);
    });
  }

  for (const [label, failure, afterFirstCheck, expectedChecks] of [
    ["surviving company", { code: "23503", constraint: "company_skills_company_id_companies_id_fk" }, true, 2],
    ["unrelated FK", { code: "23503", constraint: "company_skills_folder_id_folders_id_fk" }, false, 1],
    ["non-database error", new Error("fixture filesystem failure"), false, 1],
    ["split cause metadata", { code: "23503", cause: { constraint: "company_skills_company_id_companies_id_fk" } }, false, 1],
    ["failed existence recheck", { code: "23503", constraint: "company_skills_company_id_companies_id_fk" }, new Error("fixture lookup failure"), 2],
  ] as const) {
    it(`preserves the original error for ${label}`, async () => {
      const companyId = randomUUID();
      const fixture = inventoryFailureDatabase(companyId, failure, afterFirstCheck);
      const result = settle(companySkillService(fixture.database).list(companyId));
      fixture.release();
      expect(await result).toEqual({ status: "rejected", reason: failure });
      expect(fixture.checks()).toBe(expectedChecks);
    });
  }

  it("terminates cause traversal on a cycle without hiding the error", async () => {
    const failure: { cause?: unknown } = {};
    failure.cause = failure;
    const companyId = randomUUID();
    const fixture = inventoryFailureDatabase(companyId, failure);
    const result = settle(companySkillService(fixture.database).list(companyId));
    fixture.release();
    const outcome = await result;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe(failure);
    expect(fixture.checks()).toBe(1);
  });
});
