import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";

export async function applyMacoTestMigrations(connection: string): Promise<void> {
  const migrator = "verrail_test_migrator";
  const runtime = "verrail_test_app";
  const sql = postgres(connection, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const [identity] = await sql`
      SELECT current_user AS name, current_database() AS database,
        rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
        pg_get_userbyid(datdba) AS owner
      FROM pg_roles JOIN pg_database ON datname = current_database()
      WHERE rolname = current_user`;
    if (identity?.name !== migrator || identity.database !== "verrail_test" || identity.owner !== migrator ||
      identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolreplication || identity.rolbypassrls) {
      throw new Error("Unexpected migration identity");
    }
    const [role] = await sql`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname = ${runtime}`;
    if (!role || Object.values(role).some(Boolean)) throw new Error("Unexpected runtime identity");
    await sql.begin(async tx => {
      // A transaction pins this connection while the separate migration client works.
      const [lock] = await tx`SELECT pg_try_advisory_xact_lock(721403, 1) AS acquired`;
      if (!lock.acquired) throw new Error("Another migration is active");
      const [privileges] = await tx`SELECT has_database_privilege(${runtime}, current_database(), 'CREATE') AS create`;
      if (privileges?.create) throw new Error("Runtime has database DDL authority");
      await applyPendingMigrations(connection);
      for (const schema of ["verrail_temporal", "verrail_visibility"]) {
        await tx`CREATE SCHEMA IF NOT EXISTS ${tx(schema)} AUTHORIZATION ${tx(migrator)}`;
        const [owner] = await tx`SELECT pg_get_userbyid(nspowner) AS name FROM pg_namespace WHERE nspname = ${schema}`;
        if (owner?.name !== migrator) throw new Error("Unexpected schema owner");
      }
      for (const schema of ["public", "verrail_temporal", "verrail_visibility"]) {
        await tx`REVOKE ALL ON SCHEMA ${tx(schema)} FROM PUBLIC`;
        await tx`GRANT USAGE ON SCHEMA ${tx(schema)} TO ${tx(runtime)}`;
        await tx`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${tx(schema)} TO ${tx(runtime)}`;
        await tx`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${tx(schema)} TO ${tx(runtime)}`;
        await tx`ALTER DEFAULT PRIVILEGES FOR ROLE ${tx(migrator)} IN SCHEMA ${tx(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${tx(runtime)}`;
        await tx`ALTER DEFAULT PRIVILEGES FOR ROLE ${tx(migrator)} IN SCHEMA ${tx(schema)} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${tx(runtime)}`;
        const [privileges] = await tx`SELECT has_schema_privilege(${runtime}, ${schema}, 'CREATE') AS create`;
        if (privileges?.create) throw new Error("Runtime has schema DDL authority");
      }
      await tx`GRANT USAGE ON SCHEMA drizzle TO ${tx(runtime)}`;
      await tx`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${tx(runtime)}`;
    });
  } finally {
    await sql.end();
  }
}
