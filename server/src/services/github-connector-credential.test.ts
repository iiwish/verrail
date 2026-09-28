import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  createDb,
  secretAccessEvents,
  toolApplications,
  toolConnections,
  verrailGithubRepoBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { resolveGithubConnectorCredential, secretService } from "./secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("GitHub connector credential boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("verrail-github-credential-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(verrailGithubRepoBindings);
    await db.delete(companySecretBindings);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves only the bound active connection and persists no credential value", async () => {
    const sentinel = `github-ephemeral-${randomUUID()}`;
    const [company] = await db.insert(companies).values({
      name: `GitHub credential ${randomUUID()}`,
      issuePrefix: `GH${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const secret = await secretService(db).create(company!.id, {
      provider: "local_encrypted",
      name: `GitHub token ${randomUUID()}`,
      key: `github.token.${randomUUID()}`,
      value: sentinel,
    });
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      name: `GitHub ${randomUUID()}`,
      type: "a2a",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id,
      applicationId: application!.id,
      name: `GitHub ${randomUUID()}`,
      uid: `github/${randomUUID()}`,
      transport: "rest_api",
      authKind: "api_key",
      status: "active",
      enabled: true,
      credentialRefs: [{
        name: "token",
        secretId: secret.id,
        version: "latest",
        placement: "header",
        key: "Authorization",
        prefix: "Bearer ",
      }],
    }).returning();
    await db.insert(companySecretBindings).values({
      companyId: company!.id,
      secretId: secret.id,
      targetType: "tool_connection",
      targetId: connection!.id,
      configPath: "credentials.token",
    });
    await db.insert(verrailGithubRepoBindings).values({
      id: randomUUID(),
      workspaceId: company!.id,
      connectionId: connection!.id,
      repoOwner: "owner",
      repoName: "repo",
      createdByPrincipalType: "user",
      createdByPrincipalId: "owner-user",
    });

    await expect(resolveGithubConnectorCredential(db, company!.id, {
      actorType: "user",
      actorId: "owner-user",
      actorSource: "session",
    })).resolves.toEqual({
      connectionId: connection!.id,
      authorization: `Bearer ${sentinel}`,
    });

    const durableRows = await Promise.all([
      db.select().from(toolConnections),
      db.select().from(verrailGithubRepoBindings),
      db.select().from(companySecrets),
      db.select().from(companySecretVersions),
      db.select().from(secretAccessEvents),
    ]);
    expect(JSON.stringify(durableRows)).not.toContain(sentinel);
    expect(durableRows[4]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        consumerType: "tool_connection",
        consumerId: connection!.id,
        actorType: "user",
        actorId: "owner-user",
        outcome: "success",
      }),
    ]));
  });

  it("fails closed when the workspace has no active bound credential", async () => {
    const [company] = await db.insert(companies).values({
      name: `GitHub unbound ${randomUUID()}`,
      issuePrefix: `GU${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    await expect(resolveGithubConnectorCredential(db, company!.id, {
      actorType: "user",
      actorId: "owner-user",
      actorSource: "session",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "CONNECTOR_CREDENTIALS_NOT_CONFIGURED" },
    });
  });
});
