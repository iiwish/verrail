import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import { createDb } from "@paperclipai/db";
import { assertDeliveryProofReader, type DeliveryProofReaderAccess } from "../src/services/delivery-proof-reader-access.js";
import { channelTargetProofContextInputSchema, loadChannelTargetProofContext } from "../src/services/channel-target-proof-context.js";
import { codexExecutionProofContextInputSchema, loadCodexExecutionProofContext } from "../src/services/codex-execution-proof-context.js";
import { observeChannelTargetProvider, type ChannelProviderObservationConfig } from "../src/services/channel-target-provider-observation.js";
import { deliveryProofRequestSchema, recordDeliveryProof, type DeliveryProofRecorderConfig } from "../src/services/delivery-proof-recorder.js";
import type { RunLogStore } from "../src/services/run-log-store.js";

const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inspect") }).strict(),
  z.object({ kind: z.literal("channel"), references: channelTargetProofContextInputSchema.omit({ workspaceId: true }) }).strict(),
  z.object({ kind: z.literal("channel-provider"), references: channelTargetProofContextInputSchema.omit({ workspaceId: true }) }).strict(),
  z.object({ kind: z.literal("codex"), references: codexExecutionProofContextInputSchema.omit({ workspaceId: true }) }).strict(),
  z.object({ kind: z.literal("prove"), references: deliveryProofRequestSchema }).strict(),
]);

async function main() {
  if (process.execArgv.length || Object.keys(process.env).some(key => /^(NODE_(?!ENV$)|LD_|DYLD_)/.test(key) && process.env[key])) throw new Error();
  const configPath = process.env.VERRAIL_PROOF_READER_CONFIG;
  if (!configPath || !path.isAbsolute(configPath)) throw new Error();
  const directory = await stat(path.dirname(configPath));
  const file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let access: DeliveryProofReaderAccess & { logRoot: string; channelProvider?: ChannelProviderObservationConfig; deliveryProof?: DeliveryProofRecorderConfig };
  try {
    const metadata = await file.stat();
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0
      || !metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size > 131072) throw new Error();
    access = JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16384) throw new Error();
    chunks.push(buffer);
  }
  const input = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (input.kind === "prove") {
    clearTimeout(deadline);
    deadline = setTimeout(() => { process.stderr.write("PROOF_READER_DEADLINE\n"); process.exit(1); }, 120_000);
  }
  const db = createDb(access.databaseUrl, { maxConnections: 1, connectTimeoutSeconds: 3 });
  try {
    const authority = await assertDeliveryProofReader(db, access);
    if (input.kind === "inspect") return authority;
    if (input.kind === "channel") return await loadChannelTargetProofContext(db, { ...input.references, workspaceId: access.workspaceId });
    if (input.kind === "channel-provider") {
      if (!access.channelProvider) throw new Error();
      return await observeChannelTargetProvider(db, { ...input.references, workspaceId: access.workspaceId }, access.channelProvider, { access });
    }
    if (!path.isAbsolute(access.logRoot)) throw new Error();
    const root = await realpath(path.join(access.logRoot, access.workspaceId));
    const logs: Pick<RunLogStore, "read"> = {
      read: async (handle, options) => {
        const segments = handle.logRef.split(path.sep);
        if (handle.store !== "local_file" || segments.length !== 3 || segments[0] !== access.workspaceId
          || !z.string().uuid().safeParse(segments[1]).success || !/^[a-f0-9-]{36}\.ndjson$/.test(segments[2]!)
          || options?.offset !== 0 || !options.limitBytes || options.limitBytes > 16 * 1024 * 1024 + 1) throw new Error();
        const name = await realpath(path.join(root, segments[1]!, segments[2]!));
        if (!name.startsWith(`${root}${path.sep}`)) throw new Error();
        const log = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await log.stat();
          if (!before.isFile() || before.size > options.limitBytes) throw new Error();
          const buffer = Buffer.alloc(options.limitBytes);
          const { bytesRead } = await log.read(buffer, 0, buffer.length, 0);
          const after = await log.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytesRead !== before.size) throw new Error();
          return { content: buffer.subarray(0, bytesRead).toString("utf8") };
        } finally { await log.close(); }
      },
    };
    if (input.kind === "prove") {
      if (!access.deliveryProof || createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")
        !== access.deliveryProof.trust.verifierBuildSha256) throw new Error();
      return await recordDeliveryProof(db, access, input.references, access.deliveryProof, logs);
    }
    return await loadCodexExecutionProofContext(db, { ...input.references, workspaceId: access.workspaceId }, { logs });
  } finally { await db.$client.end(); }
}

let deadline = setTimeout(() => { process.stderr.write("PROOF_READER_DEADLINE\n"); process.exit(1); }, 20_000);
try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
catch { process.stderr.write("PROOF_READER_REQUEST_FAILED\n"); process.exitCode = 1; }
finally { clearTimeout(deadline); }
