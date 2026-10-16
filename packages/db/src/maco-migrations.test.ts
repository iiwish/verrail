import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMacoTestMigrations } from "./maco-migrations.js";
import { inspectMigrations } from "./client.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

describe("maco project migration role boundary", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let admin: ReturnType<typeof postgres>;
  let runtime: ReturnType<typeof postgres>;
  let migrator: ReturnType<typeof postgres>;
  let migrationUrl: string;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("verrail-maco-migrations-");
    admin = postgres(fixture.connectionString, { max: 1, onnotice: () => {} });
    await admin`CREATE ROLE verrail_test_migrator LOGIN PASSWORD 'fixture-only-migration'`;
    await admin`CREATE ROLE verrail_test_app LOGIN PASSWORD 'fixture-only-runtime'`;
    await admin`CREATE DATABASE verrail_test OWNER verrail_test_migrator`;
    await admin`REVOKE ALL ON DATABASE verrail_test FROM PUBLIC`;
    await admin`GRANT CONNECT ON DATABASE verrail_test TO verrail_test_app`;
    const url = new URL(fixture.connectionString);
    url.pathname = "/verrail_test";
    url.username = "verrail_test_migrator";
    url.password = "fixture-only-migration";
    migrationUrl = url.href;
    migrator = postgres(migrationUrl, { max: 1, onnotice: () => {} });
    url.username = "verrail_test_app";
    url.password = "fixture-only-runtime";
    runtime = postgres(url.href, { max: 1, onnotice: () => {} });
  }, 60000);
  afterAll(async () => {
    await runtime?.end();
    await migrator?.end();
    await admin?.end();
    await fixture?.cleanup();
  });

  it("rejects the administrator before migrating", async () => {
    await expect(applyMacoTestMigrations(fixture.connectionString)).rejects.toThrow("Unexpected migration identity");
  });

  it("refuses a concurrent migration job", async () => {
    await migrator.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(721403, 1)`;
      await expect(applyMacoTestMigrations(migrationUrl)).rejects.toThrow("Another migration is active");
    });
  });

  it("migrates twice safely and grants DML but not runtime DDL", async () => {
    await applyMacoTestMigrations(migrationUrl);
    await applyMacoTestMigrations(migrationUrl);
    expect((await inspectMigrations(migrationUrl)).status).toBe("upToDate");
    await runtime`SELECT count(*) FROM drizzle.__drizzle_migrations`;
    for (const schema of ["public", "verrail_temporal", "verrail_visibility"]) {
      await migrator`CREATE TABLE ${migrator(schema + ".permission_fixture")} (id serial PRIMARY KEY, value text)`;
      await runtime`INSERT INTO ${runtime(schema + ".permission_fixture")} (value) VALUES ('test')`;
      await runtime`UPDATE ${runtime(schema + ".permission_fixture")} SET value = 'updated'`;
      const rows = await runtime`SELECT value FROM ${runtime(schema + ".permission_fixture")}`;
      expect(rows[0]?.value).toBe("updated");
      await runtime`DELETE FROM ${runtime(schema + ".permission_fixture")}`;
      await expect(runtime`CREATE TABLE ${runtime(schema + ".forbidden")} (id int)`).rejects.toMatchObject({ code: "42501" });
    }
    await expect(runtime`DELETE FROM drizzle.__drizzle_migrations`).rejects.toMatchObject({ code: "42501" });
  }, 60000);
});
