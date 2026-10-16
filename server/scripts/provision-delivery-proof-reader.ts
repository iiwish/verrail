import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createDb } from "@paperclipai/db";
import { assertDeliveryProofReader, provisionDeliveryProofReader, removeDeliveryProofReader, type DeliveryProofReaderAccess } from "../src/services/delivery-proof-reader-access.js";

async function main() {
  const [workspaceId, outputPath, logRoot] = process.argv.slice(2);
  const databaseUrl = process.env.VERRAIL_PROOF_ADMIN_DATABASE_URL;
  if (!workspaceId || !outputPath || !path.isAbsolute(outputPath) || !logRoot || !path.isAbsolute(logRoot) || !databaseUrl) throw new Error();
  const repo = await realpath(path.resolve(import.meta.dirname, "../.."));
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const directory = await realpath(path.dirname(outputPath)), metadata = await stat(directory);
  if (directory === repo || directory.startsWith(`${repo}${path.sep}`) || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error();
  const output = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const admin = createDb(databaseUrl, { maxConnections: 1, connectTimeoutSeconds: 3 });
  let access: DeliveryProofReaderAccess | undefined;
  let committed = false;
  try {
    const roleName = `verrail_proof_ro_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    access = await provisionDeliveryProofReader(admin, { workspaceId, roleName, databaseUrl });
    const reader = createDb(access.databaseUrl, { maxConnections: 1, connectTimeoutSeconds: 3 });
    try { await assertDeliveryProofReader(reader, access); }
    finally { await reader.$client.end(); }
    await output.writeFile(`${JSON.stringify({ ...access, logRoot }, null, 2)}\n`, "utf8");
    await output.sync();
    committed = true;
    process.stdout.write(`${JSON.stringify({ roleName, workspaceId, schemaName: access.schemaName, expiresAt: access.expiresAt,
      policySha256: access.policySha256, configPath: outputPath })}\n`);
  } finally {
    await output.close();
    try {
      if (!committed) {
        if (access) await removeDeliveryProofReader(admin, access);
        await unlink(outputPath);
      }
    } finally { await admin.$client.end(); }
  }
}
try { await main(); }
catch { process.stderr.write("PROOF_READER_PROVISION_FAILED\n"); process.exitCode = 1; }
