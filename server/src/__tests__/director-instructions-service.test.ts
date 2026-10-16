import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { resolveDirectorRole } from "../services/director-instructions.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("Director instruction persistence", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("verrail-director-instructions-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const id = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instructions fixture", issuePrefix: `T${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id, companyId, name: "Director", role: "ceo", adapterType: "codex_local",
      adapterConfig: { model: "fixture-model" }, metadata: { paperclipBuiltInAgent: { key: "director", featureKeys: [] } } });
    return { companyId, id, expectedConfigHash: resolveDirectorRole({}).configHash };
  }

  it("applies once with atomic revision and audit and keeps unrelated configuration", async () => {
    const f = await seed();
    const svc = agentService(db);
    const input = { rolePrompt: "Be concrete and use Chinese.", expectedConfigHash: f.expectedConfigHash };
    const updated = await svc.applyDirectorInstructions(f.companyId, f.id, "operator", input);
    expect(resolveDirectorRole(updated.adapterConfig)).toMatchObject({ rolePrompt: input.rolePrompt, revision: 1 });
    expect(updated.adapterConfig.model).toBe("fixture-model");
    const replay = await svc.applyDirectorInstructions(f.companyId, f.id, "operator", input);
    expect(resolveDirectorRole(replay.adapterConfig).revision).toBe(1);
    const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, f.id));
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.id), eq(activityLog.action, "agent.director_instructions_applied")));
    expect(revisions).toHaveLength(1);
    expect(revisions[0].source).toBe("director_chat_instructions_apply");
    expect(revisions[0].createdByUserId).toBe("operator");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].details)).not.toContain(input.rolePrompt);
    expect(JSON.stringify(revisions[0].afterConfig)).toContain(input.rolePrompt);
  });

  it("rejects stale and cross-workspace application without changing the active snapshot", async () => {
    const f = await seed();
    const svc = agentService(db);
    await svc.applyDirectorInstructions(f.companyId, f.id, "operator", { rolePrompt: "First", expectedConfigHash: f.expectedConfigHash });
    await expect(svc.applyDirectorInstructions(f.companyId, f.id, "operator", { rolePrompt: "Stale", expectedConfigHash: f.expectedConfigHash })).rejects.toThrow(/changed/);
    await expect(svc.applyDirectorInstructions(randomUUID(), f.id, "operator", { rolePrompt: "Foreign", expectedConfigHash: f.expectedConfigHash })).rejects.toThrow(/not found/);
    expect(resolveDirectorRole((await svc.getById(f.id))!.adapterConfig).rolePrompt).toBe("First");
  });

  it("serializes competing applies so exactly one wins", async () => {
    const f = await seed();
    const svc = agentService(db);
    const results = await Promise.allSettled(["Candidate A", "Candidate B"].map((rolePrompt) =>
      svc.applyDirectorInstructions(f.companyId, f.id, "operator", { rolePrompt, expectedConfigHash: f.expectedConfigHash })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(resolveDirectorRole((await svc.getById(f.id))!.adapterConfig).revision).toBe(1);
  });

  it("preserves chat snapshots during adapter edits and rejects a direct replacement", async () => {
    const f = await seed();
    const svc = agentService(db);
    const applied = await svc.applyDirectorInstructions(f.companyId, f.id, "operator", { rolePrompt: "Retain this", expectedConfigHash: f.expectedConfigHash });
    const updated = await svc.update(f.id, { adapterConfig: { model: "another-model" } });
    expect(updated!.adapterConfig.model).toBe("another-model");
    expect(resolveDirectorRole(updated!.adapterConfig).rolePrompt).toBe("Retain this");
    await expect(svc.update(f.id, { adapterConfig: { ...applied.adapterConfig, directorChatInstructions: null } })).rejects.toThrow(/explicit/);
  });

  it("allows ordinary adapter updates when there is no chat snapshot", async () => {
    const f = await seed();
    const updated = await agentService(db).update(f.id, { adapterConfig: { model: "updated-model" } });
    expect(updated!.adapterConfig.model).toBe("updated-model");
  });
});
