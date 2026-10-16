import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { bootstrapFirstOperator } from "./services/first-operator.js";

async function main() {
  if (process.env.PAPERCLIP_DEPLOYMENT_MODE !== "authenticated" ||
      process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE !== "private" ||
      process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP !== "true" || !process.env.DATABASE_URL) {
    throw new Error("Private authenticated bootstrap configuration required");
  }
  const db = createDb(process.env.DATABASE_URL, { maxConnections: 1, connectTimeoutSeconds: 10 });
  try {
    await db.execute(sql`set statement_timeout = '15s'`);
    const rows = await db.execute(sql`select current_database() as database, current_user as role`);
    if (rows[0]?.database !== "verrail_test" || rows[0]?.role !== "verrail_test_migrator") {
      throw new Error("Registered migration job identity required");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => process.stdin.destroy(new Error("Bootstrap input deadline exceeded")), 30_000);
    try {
      for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 4096) throw new Error("Bootstrap input exceeds limit");
        chunks.push(bytes);
      }
    } finally { clearTimeout(timer); }
    const result = await bootstrapFirstOperator(db, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await db.$client.end({ timeout: 5 }); }
}

main().catch(() => {
  process.stderr.write("First operator bootstrap failed\n");
  process.exitCode = 1;
});
