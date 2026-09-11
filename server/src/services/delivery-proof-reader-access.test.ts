import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDeliveryProofReader } from "./delivery-proof-reader-build.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, verrailConversations, verrailConversationMessages } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { provisionDeliveryProofReader, removeDeliveryProofReader, assertDeliveryProofReader } from "./delivery-proof-reader-access.js";

describe("dedicated delivery proof reader database authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let admin: ReturnType<typeof createDb>, reader: ReturnType<typeof createDb>;
  let access: Awaited<ReturnType<typeof provisionDeliveryProofReader>>;
  let directory: string, configPath: string, bundlePath: string;
  async function invoke(input: unknown, config = configPath) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [bundlePath], { cwd: directory,
        env: { VERRAIL_PROOF_READER_CONFIG: config }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, stdout, stderr }));
      child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    });
  }
  const workspaceId = randomUUID(), foreignId = randomUUID();
  const roleName = `verrail_proof_ro_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("verrail-proof-reader-");
    admin = createDb(database.connectionString);
    await admin.insert(companies).values([{ id: workspaceId, name: "Allowed", issuePrefix: "PRA" }, { id: foreignId, name: "Foreign", issuePrefix: "PRB" }]);
    access = await provisionDeliveryProofReader(admin, { workspaceId, roleName, databaseUrl: database.connectionString });
    reader = createDb(access.databaseUrl, { maxConnections: 1 });
    directory = await mkdtemp(path.join(os.tmpdir(), "verrail-proof-cli-"));
    await chmod(directory, 0o700);
    configPath = path.join(directory, "access.json");
    bundlePath = path.join(directory, "reader.mjs");
    await writeFile(configPath, JSON.stringify({ ...access, logRoot: directory }), { mode: 0o600 });
    await buildDeliveryProofReader(bundlePath);
  }, 30_000);
  afterAll(async () => {
    await reader?.$client.end();
    if (admin && access) await removeDeliveryProofReader(admin, access);
    await admin?.$client.end();
    await database?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("authenticates as a distinct role with only the fixed Workspace visible", async () => {
    const identity = await assertDeliveryProofReader(reader, access);
    expect(identity.roleName).toBe(roleName);
    expect(identity.workspaceId).toBe(workspaceId);
    expect(await reader.$client`select id from companies`).toEqual([{ id: workspaceId }]);
    expect(await reader.$client`select id from companies where id=${foreignId}`).toEqual([]);
  });

  it.each([
    "select * from public.companies", "select * from public.agents", "select * from public.agent_api_keys",
    "select * from public.company_secrets", "select * from public.tool_connections", "select adapter_config from agents",
    "select prompt from verrail_agent_versions", "select body from verrail_conversation_messages",
    "create table public.reader_probe(id int)", "create schema reader_probe", "create role reader_probe",
  ])("refuses base data, secrets and unneeded columns or DDL: %s", async query => {
    await expect(reader.$client.unsafe(query)).rejects.toBeTruthy();
  });

  it("cannot turn disabled transaction defaults into business write or role authority", async () => {
    await reader.$client`set default_transaction_read_only = off`;
    try {
      await expect(reader.$client`update companies set status='paused' where id=${workspaceId}`).rejects.toMatchObject({ code: "42501" });
      await expect(reader.$client`delete from public.companies where id=${workspaceId}`).rejects.toMatchObject({ code: "42501" });
      await expect(reader.$client.unsafe(`set role "${new URL(database.connectionString).username}"`)).rejects.toMatchObject({ code: "42501" });
      await expect(reader.$client.unsafe(`create view "${access.schemaName}".escape as select * from public.companies`)).rejects.toMatchObject({ code: "42501" });
    } finally { await reader.$client`set default_transaction_read_only = on`; }
  });

  it("rejects a mismatched scope or administrator instead of trusting configuration", async () => {
    await expect(assertDeliveryProofReader(reader, { ...access, workspaceId: foreignId })).rejects.toThrow("PROOF_READER_AUTHORITY_INVALID");
    await expect(assertDeliveryProofReader(admin, access)).rejects.toThrow("PROOF_READER_AUTHORITY_INVALID");
  });

  it("does not replace an existing role or silently broaden its scope", async () => {
    await expect(provisionDeliveryProofReader(admin, { workspaceId: foreignId, roleName, databaseUrl: database.connectionString }))
      .rejects.toThrow("PROOF_READER_PROVISION_FAILED");
    expect((await assertDeliveryProofReader(reader, access)).workspaceId).toBe(workspaceId);
  });

  it("provides a separate v2 identity with a database-computed body hash, never the body", async () => {
    const conversationId = randomUUID(), messageId = randomUUID();
    await admin.insert(verrailConversations).values({ id: conversationId, workspaceId, createdByPrincipalType: "user", createdByPrincipalId: "test" });
    await admin.insert(verrailConversationMessages).values({ id: messageId, workspaceId, conversationId, role: "user", status: "complete", body: "PRIVATE BODY",
      authorPrincipalType: "user", authorPrincipalId: "test", metadata: { proofReaderBodySha256: "untrusted-spoof", private: "PRIVATE METADATA" } });
    const extended = await provisionDeliveryProofReader(admin, { workspaceId, roleName: `verrail_proof_ro_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      databaseUrl: database.connectionString, schemaVersion: 2 });
    const limited = createDb(extended.databaseUrl, { maxConnections: 1 });
    try {
      expect(extended.schemaVersion).toBe(2);
      await assertDeliveryProofReader(limited, extended);
      expect(await limited.$client`select metadata->>'proofReaderBodySha256' as hash from verrail_conversation_messages where id=${messageId}`)
        .toEqual(await admin.$client`select encode(sha256(convert_to(body,'UTF8')),'hex') as hash from verrail_conversation_messages where id=${messageId}`);
      await expect(limited.$client`select body from verrail_conversation_messages`).rejects.toBeTruthy();
      expect(JSON.stringify(await limited.$client`select metadata from verrail_conversation_messages where id=${messageId}`)).not.toContain("PRIVATE");
      expect(await limited.$client`select id from verrail_channel_target_replies`).toEqual([]);
      await expect(reader.$client`select id from verrail_channel_target_replies`).rejects.toBeTruthy();
      await expect(assertDeliveryProofReader(limited, { ...extended, schemaVersion: 1 })).rejects.toThrow("PROOF_READER_AUTHORITY_INVALID");
    } finally { await limited.$client.end(); await removeDeliveryProofReader(admin, extended); }
  });

  it("executes a fixed bundle outside the candidate checkout without inherited credentials", async () => {
    const result = await invoke({ kind: "inspect" });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ roleName, workspaceId, assurance: "scoped_database_read_only" });
    expect(result.stdout).not.toContain(access.databaseUrl);
  });

  it.each([{ kind: "query", sql: "select * from public.agent_api_keys" }, { kind: "inspect", workspaceId: foreignId }, "x".repeat(16385)])(
    "rejects arbitrary SQL, scope injection and oversized requests", async input => {
      const result = await invoke(input);
      expect(result).toEqual({ code: 1, stdout: "", stderr: "PROOF_READER_REQUEST_FAILED\n" });
    });

  it("rejects symlink and permissive credential files", async () => {
    const link = path.join(directory, "linked.json");
    await symlink(configPath, link);
    expect((await invoke({ kind: "inspect" }, link)).code).toBe(1);
    await chmod(configPath, 0o644);
    try { expect((await invoke({ kind: "inspect" })).code).toBe(1); }
    finally { await chmod(configPath, 0o600); }
  });
});
