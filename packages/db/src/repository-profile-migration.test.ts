import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

it.skipIf(!support.supported)("repository profile migration enforces executor pairing in both tables", async () => {
  // Startup applies the complete production migration chain to an isolated DB.
  const database = await startEmbeddedPostgresTestDatabase("verrail-repository-profile-");
  const sql = postgres(database.connectionString, { max: 1 });
  try {
    const constraints = await sql`select conname from pg_constraint where conname in
      ('verrail_execution_leases_repository_executor_check', 'verrail_run_attempts_repository_executor_check')`;
    expect(constraints).toHaveLength(2);
    await sql.unsafe("create schema profile_fixture; set search_path to profile_fixture");
    const tables = ["verrail_execution_leases", "verrail_run_attempts"];
    for (const table of tables) {
      await sql.unsafe(`create table ${table} (runtime_profile text not null, executor_principal_id text not null,
        constraint ${table}_runtime_profile_check check (runtime_profile in ('host_trusted')))`);
      await sql.unsafe(`insert into ${table} values ('host_trusted', 'verrail-host-runner')`);
    }
    const migration = await readFile(new URL("./migrations/0259_cute_marvex.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await sql.unsafe(statement);
    }
    for (const table of tables) {
      await sql.unsafe(`insert into ${table} values ('repository_sandbox', 'verrail-repository-runner')`);
      for (const [profile, executor] of [
        ["repository_sandbox", "verrail-host-runner"],
        ["repository_sandbox", "arbitrary-runner"],
        ["host_trusted", "verrail-repository-runner"],
        ["unknown", "arbitrary-runner"],
      ]) {
        await expect(sql.unsafe(`insert into ${table} values ($1, $2)`, [profile, executor]))
          .rejects.toMatchObject({ code: "23514" });
      }
      expect(await sql.unsafe(`select * from ${table}`)).toHaveLength(2);
    }
  } finally {
    await sql.end();
    await database.cleanup();
  }
}, 60_000);
