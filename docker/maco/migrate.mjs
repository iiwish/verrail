import { applyMacoTestMigrations } from "@paperclipai/db";

try {
  if (!process.env.DATABASE_URL) throw new Error("Missing migration connection");
  await applyMacoTestMigrations(process.env.DATABASE_URL);
  console.log("Application migrations and runtime schema grants complete");
} catch {
  console.error("Application migration failed; inspect schema and role ownership through the authorized operator");
  process.exitCode = 1;
}
