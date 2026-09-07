import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies, createDb, companySecrets, companySecretVersions, toolApplications, toolConnections,
  verrailTargets, verrailTargetRevisions, verrailWorkGraphs, verrailGraphRevisions, verrailGithubRepoBindings,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { loadGitHubCiCollectionContext } from "./github-ci-proof-context.js";
import { resolveGithubConnectorCredential, secretService } from "./secrets.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("GitHub CI current database context", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("verrail-ci-context-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const [workspace] = await db.insert(companies).values({ name: "CI context test", issuePrefix: `CI${randomUUID().slice(0, 6)}` }).returning();
    const workspaceId = workspace!.id, targetId = randomUUID(), targetRevisionId = randomUUID(), graphRevisionId = randomUUID(), graphId = randomUUID();
    await db.insert(verrailTargets).values({ id: targetId, workspaceId, activeTargetRevisionId: targetRevisionId, createdByPrincipalType: "user", createdByPrincipalId: "test-user" });
    await db.insert(verrailTargetRevisions).values({ id: targetRevisionId, workspaceId, targetId, revisionNumber: 1, title: "CI context", goal: "bounded CI", constraints: [], acceptanceCriteria: [], outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "test-user", riskLevel: "low", contentHash: "a".repeat(64), createdByPrincipalType: "user", createdByPrincipalId: "test-user" });
    await db.insert(verrailWorkGraphs).values({ id: graphId, workspaceId, targetId, activeGraphRevisionId: graphRevisionId, status: "active" });
    await db.insert(verrailGraphRevisions).values({ id: graphRevisionId, workspaceId, targetId, targetRevisionId, workGraphId: graphId, revisionNumber: 1, status: "active", contentHash: "b".repeat(64), createdByPrincipalType: "user", createdByPrincipalId: "test-user" });
    const secret = await secretService(db).create(workspaceId, { provider: "local_encrypted", name: `synthetic-${randomUUID()}`, key: `test.${randomUUID()}`, value: "synthetic-test-token-not-live" });
    const [application] = await db.insert(toolApplications).values({ companyId: workspaceId, name: "Synthetic GitHub", type: "a2a", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: workspaceId, applicationId: application!.id, uid: randomUUID(), name: "Synthetic GitHub", transport: "rest_api", authKind: "api_key", status: "active", enabled: true, credentialRefs: [{ name: "token", placement: "header", key: "Authorization", secretId: secret.id, version: "latest" }] }).returning();
    const bindingId = randomUUID();
    await db.insert(verrailGithubRepoBindings).values({ id: bindingId, workspaceId, connectionId: connection!.id, repoOwner: "owner", repoName: "repo", createdByPrincipalType: "user", createdByPrincipalId: "test-user" });
    const load = () => loadGitHubCiCollectionContext(db, workspaceId, targetId);
    return { workspaceId, targetId, targetRevisionId, graphId, graphRevisionId, connectionId: connection!.id, bindingId, secretId: secret.id, load };
  }
  it("scopes every joined identity and excludes secret values from context", async () => {
    const s = await seed(); const context = await s.load();
    expect(context).toMatchObject({ workspaceId: s.workspaceId, targetId: s.targetId, targetRevisionId: s.targetRevisionId, graphRevisionId: s.graphRevisionId, connectionId: s.connectionId, bindingId: s.bindingId, repository: "owner/repo" });
    expect(JSON.stringify(context)).not.toContain("synthetic-test-token");
    await expect(loadGitHubCiCollectionContext(db, randomUUID(), s.targetId)).rejects.toMatchObject({ status: 409 });
    await expect(loadGitHubCiCollectionContext(db, s.workspaceId, randomUUID())).rejects.toMatchObject({ status: 409 });
  });
  it("allows real resolver read bookkeeping, but detects rotation metadata", async () => {
    const s = await seed(); const initial = await s.load();
    await resolveGithubConnectorCredential(db, s.workspaceId, { actorType: "user", actorId: "test-user", actorSource: "local_implicit" });
    expect(await s.load()).toEqual(initial);
    await db.update(companySecrets).set({ lastRotatedAt: new Date() }).where(eq(companySecrets.id, s.secretId));
    expect((await s.load()).contextSha256).not.toBe(initial.contextSha256);
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, s.secretId));
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
  });
  it("accepts a bound MCP connection credential for the fixed REST reader", async () => {
    const s = await seed();
    await db.update(toolConnections).set({ transport: "mcp_remote" }).where(eq(toolConnections.id, s.connectionId));
    expect(await s.load()).toMatchObject({ connectionId: s.connectionId, repository: "owner/repo" });
  });
  it("detects repository rebind, credential selector and revision content drift", async () => {
    const s = await seed(); const initial = await s.load();
    await db.update(verrailGithubRepoBindings).set({ repoName: "changed" }).where(eq(verrailGithubRepoBindings.id, s.bindingId));
    expect((await s.load()).contextSha256).not.toBe(initial.contextSha256);
    await db.update(toolConnections).set({ credentialRefs: [{ name: "token", placement: "header", key: "Authorization", secretId: s.secretId, version: 1 }] }).where(eq(toolConnections.id, s.connectionId));
    const rebound = await s.load();
    await db.update(verrailTargetRevisions).set({ contentHash: "c".repeat(64) }).where(eq(verrailTargetRevisions.id, s.targetRevisionId));
    expect((await s.load()).contextSha256).not.toBe(rebound.contextSha256);
  });
  it("rejects revoked secrets, disabled connection, inactive graph and stale target revision", async () => {
    const revoked = await seed();
    await db.update(companySecretVersions).set({ revokedAt: new Date() }).where(eq(companySecretVersions.secretId, revoked.secretId));
    await expect(revoked.load()).rejects.toMatchObject({ status: 409 });
    const disabled = await seed();
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, disabled.connectionId));
    await expect(disabled.load()).rejects.toMatchObject({ status: 409 });
    const graph = await seed();
    await db.update(verrailGraphRevisions).set({ status: "superseded" }).where(eq(verrailGraphRevisions.id, graph.graphRevisionId));
    await expect(graph.load()).rejects.toMatchObject({ status: 409 });
    const stale = await seed();
    await db.update(verrailTargets).set({ activeTargetRevisionId: randomUUID() }).where(eq(verrailTargets.id, stale.targetId));
    await expect(stale.load()).rejects.toMatchObject({ status: 409 });
  });
  it("rejects suspended workspace and foreign connection despite single-column binding FK", async () => {
    const s = await seed(), foreign = await seed();
    await db.update(verrailGithubRepoBindings).set({ connectionId: foreign.connectionId }).where(eq(verrailGithubRepoBindings.id, s.bindingId));
    await expect(s.load()).rejects.toMatchObject({ status: 409 });
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, foreign.workspaceId));
    await expect(foreign.load()).rejects.toMatchObject({ status: 409 });
  });
});
