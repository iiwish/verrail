import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  type Db, companies, agents, agentWakeupRequests, heartbeatRuns,
  verrailChannelEvents, verrailChannelTargetReplies, verrailConversations, verrailConversationMessages, verrailProviderConversationBindings,
  verrailTargetCreationDrafts, verrailTargetCreationDraftRevisions, verrailTargets, verrailTargetRevisions,
  verrailCommandReceipts, verrailAuditEvents, verrailWorkGraphs, verrailGraphRevisions, verrailWorkNodes,
  verrailRuns, verrailRunAttempts, verrailRunEvents, verrailExecutionLeases, verrailAgentDefinitions,
  verrailAgentVersions, verrailDeployments, verrailDeploymentRevisions, verrailCriterionProofs,
  verrailIntegrationRuns, verrailIntegrationAttempts, verrailEvidence, verrailVerificationResults,
  verrailArtifacts, verrailArtifactRevisions, verrailAgentCommandReceipts, verrailClaims,
  toolConnections, verrailGithubRepoBindings,
} from "@paperclipai/db";

const roleSchema = z.string().regex(/^verrail_proof_ro_[a-f0-9]{12}$/);
const policy = (version: 1 | 2) => `verrail.workspace-proof-reader.v${version}`;
const quote = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("PROOF_READER_IDENTIFIER_INVALID");
  return `"${name}"`;
};
type View = { table: PgTable; columns?: string[]; expressions?: Record<string, string> };
const views: View[] = [
  { table: companies, columns: ["id", "status"] },
  { table: agents, columns: ["id", "company_id", "adapter_type"] },
  { table: agentWakeupRequests, columns: ["id", "company_id", "agent_id", "run_id", "requested_by_actor_type", "requested_by_actor_id", "idempotency_key"] },
  { table: heartbeatRuns, columns: ["id", "company_id", "agent_id", "status", "wakeup_request_id", "started_at", "finished_at", "exit_code", "error_code",
    "log_store", "log_ref", "log_sha256", "log_bytes", "log_compressed", "usage_json", "context_snapshot", "updated_at"],
    expressions: { context_snapshot: `jsonb_build_object(${[
      "verrailRunId", "verrailRunAttemptId", "verrailTargetId", "verrailTargetRevisionId", "verrailGraphRevisionId", "verrailWorkNodeId",
      "verrailAgentVersionId", "verrailDeploymentRevisionId", "verrailEnvironmentManifest", "verrailNativeOutputReceipt", "verrailNativeDispatchConfiguration", "issueId", "taskId",
    ].map(key => `'${key}',context_snapshot->'${key}'`).join(",")})` } },
  { table: verrailAgentDefinitions, columns: ["id", "workspace_id", "compatibility_agent_id"] },
  { table: verrailAgentVersions, columns: ["id", "workspace_id", "agent_definition_id", "runtime", "model", "content_hash"] },
  { table: verrailDeployments, columns: ["id", "workspace_id", "agent_definition_id"] },
  { table: verrailDeploymentRevisions, columns: ["id", "workspace_id", "deployment_id", "agent_version_id", "content_hash", "runtime_config"],
    expressions: { runtime_config: "jsonb_build_object('cwd',runtime_config->'cwd')" } },
  { table: verrailConversationMessages, columns: ["id", "workspace_id", "conversation_id", "role", "status", "author_principal_type", "author_principal_id", "metadata"],
    expressions: { metadata: "jsonb_build_object('channelConnector',metadata->'channelConnector','providerEventId',metadata->'providerEventId','providerMessageId',metadata->'providerMessageId')" } },
  ...[verrailChannelEvents, verrailConversations, verrailProviderConversationBindings, verrailTargetCreationDrafts,
    verrailTargetCreationDraftRevisions, verrailTargets, verrailTargetRevisions, verrailCommandReceipts, verrailAuditEvents,
    verrailWorkGraphs, verrailGraphRevisions, verrailWorkNodes, verrailRuns, verrailRunAttempts, verrailRunEvents, verrailExecutionLeases,
    verrailCriterionProofs, verrailIntegrationRuns, verrailIntegrationAttempts, verrailEvidence, verrailVerificationResults,
    verrailArtifacts, verrailArtifactRevisions, verrailAgentCommandReceipts, verrailClaims].map(table => ({ table })),
];
export const deliveryProofReaderTables = views.map(view => getTableName(view.table));
function viewsFor(version: 1 | 2): View[] {
  if (version === 1) return views;
  return [...views.map(view => view.table === heartbeatRuns ? { ...view, expressions: { ...view.expressions,
    context_snapshot: `${view.expressions!.context_snapshot} || jsonb_build_object('verrailNativePermissionObservation',context_snapshot->'verrailNativePermissionObservation')` } }
    : view.table !== verrailConversationMessages ? view : {
    ...view, expressions: { ...view.expressions, metadata: `${view.expressions!.metadata} || jsonb_build_object('proofReaderBodySha256',encode(sha256(convert_to(body,'UTF8')),'hex'),'runtimeSessionId',metadata->'runtimeSessionId')` },
  }), { table: verrailChannelTargetReplies }, { table: verrailGithubRepoBindings },
  { table: toolConnections, columns: ["id", "company_id", "enabled", "status", "auth_kind", "updated_at"] }];
}
export interface DeliveryProofReaderAccess {
  schemaVersion: 1 | 2;
  workspaceId: string;
  roleName: string;
  schemaName: string;
  databaseUrl: string;
  expiresAt: string;
  policySha256: string;
}
function marker(workspaceId: string, version: 1 | 2) { return `${policy(version)}:${workspaceId}`; }
function projection(view: View) {
  const available = Object.values(getTableColumns(view.table)).map(column => column.name);
  const columns = view.columns ?? available;
  if (columns.some(column => !available.includes(column))) throw new Error("PROOF_READER_COLUMNS_INVALID");
  return columns.map(column => view.expressions?.[column] ? `${view.expressions[column]} as ${quote(column)}` : quote(column)).join(",");
}
function policyHash(workspaceId: string, version: 1 | 2) {
  return createHash("sha256").update(JSON.stringify({ policy: policy(version), workspaceId,
    views: viewsFor(version).map(view => [getTableName(view.table), projection(view)]) })).digest("hex");
}
function scram(password: string) {
  const salt = randomBytes(16), salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(clientKey).digest("base64");
  const server = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
}

/** Creates only a new private role/schema. Existing roles, grants and business rows are never altered. */
export async function provisionDeliveryProofReader(db: Db, input: { workspaceId: string; roleName: string; databaseUrl: string; schemaVersion?: 1 | 2 }): Promise<DeliveryProofReaderAccess> {
  const workspaceId = z.string().uuid().parse(input.workspaceId), roleName = roleSchema.parse(input.roleName);
  const schemaVersion = z.union([z.literal(1), z.literal(2)]).parse(input.schemaVersion ?? 1);
  const schemaName = `${roleName}_facts`, password = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const url = new URL(input.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("PROOF_READER_DATABASE_INVALID");
  url.username = roleName; url.password = password; url.search = ""; url.hash = "";
  try {
    await db.$client.begin(async tx => {
      const rows = await tx`select id from public.companies where id=${workspaceId} and status='active'`;
      if (rows.length !== 1) throw new Error("Workspace unavailable");
      await tx.unsafe(`create role ${quote(roleName)} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 2 password '${scram(password)}' valid until '${expiresAt}'`);
      await tx.unsafe(`comment on role ${quote(roleName)} is '${marker(workspaceId, schemaVersion)}'`);
      await tx.unsafe(`create schema ${quote(schemaName)}`);
      await tx.unsafe(`revoke all on schema ${quote(schemaName)} from public`);
      await tx.unsafe(`grant usage on schema ${quote(schemaName)} to ${quote(roleName)}`);
      for (const view of viewsFor(schemaVersion)) {
        const table = getTableName(view.table);
        const scope = table === "companies" ? "id" : ["agents", "heartbeat_runs", "agent_wakeup_requests", "tool_connections"].includes(table) ? "company_id" : "workspace_id";
        await tx.unsafe(`create view ${quote(schemaName)}.${quote(table)} with (security_barrier=true) as select ${projection(view)} from public.${quote(table)} where ${quote(scope)}='${workspaceId}'::uuid`);
        await tx.unsafe(`grant select on ${quote(schemaName)}.${quote(table)} to ${quote(roleName)}`);
      }
      const [{ name }] = await tx<{ name: string }[]>`select current_database() as name`;
      await tx.unsafe(`grant connect on database ${quote(name!)} to ${quote(roleName)}`);
      await tx.unsafe(`alter role ${quote(roleName)} set search_path = ${quote(schemaName)}, pg_catalog`);
      await tx.unsafe(`alter role ${quote(roleName)} set default_transaction_read_only = on`);
      await tx.unsafe(`alter role ${quote(roleName)} set statement_timeout = '5000ms'`);
      await tx.unsafe(`alter role ${quote(roleName)} set idle_in_transaction_session_timeout = '5000ms'`);
    });
    return { schemaVersion, workspaceId, roleName, schemaName, databaseUrl: url.toString(), expiresAt, policySha256: policyHash(workspaceId, schemaVersion) };
  } catch { throw new Error("PROOF_READER_PROVISION_FAILED"); }
}

export async function assertDeliveryProofReader(db: Db, access: DeliveryProofReaderAccess) {
  try {
    const roleName = roleSchema.parse(access.roleName), workspaceId = z.string().uuid().parse(access.workspaceId);
    if (![1, 2].includes(access.schemaVersion) || access.schemaName !== `${roleName}_facts` || access.policySha256 !== policyHash(workspaceId, access.schemaVersion)
      || !Number.isFinite(Date.parse(access.expiresAt)) || Date.parse(access.expiresAt) <= Date.now()) throw new Error();
    const rows = await db.$client`select current_user as name, current_schema() as schema,
      current_setting('transaction_read_only') as readonly, rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolcanlogin,rolvaliduntil,
      shobj_description(oid,'pg_authid') as marker from pg_roles where rolname=current_user`;
    const role = rows[0];
    if (!role || role.name !== roleName || role.schema !== access.schemaName || role.readonly !== "on"
      || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.rolinherit || !role.rolcanlogin
      || new Date(role.rolvaliduntil).getTime() !== Date.parse(access.expiresAt) || role.marker !== marker(workspaceId, access.schemaVersion)) throw new Error();
    const memberships = await db.$client`select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=current_user) limit 1`;
    if (memberships.length) throw new Error();
    const forbidden = await db.$client`select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p','v','m')
      and (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) limit 1`;
    const functions = await db.$client`select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef and has_function_privilege(current_user,p.oid,'EXECUTE') limit 1`;
    if (forbidden.length || functions.length) throw new Error();
    const scoped = await db.$client`select id from companies`;
    if (scoped.length !== 1 || scoped[0]!.id !== workspaceId) throw new Error();
    return { schemaVersion: access.schemaVersion, roleName, workspaceId, policySha256: access.policySha256, assurance: "scoped_database_read_only" };
  } catch { throw new Error("PROOF_READER_AUTHORITY_INVALID"); }
}

export async function removeDeliveryProofReader(db: Db, access: DeliveryProofReaderAccess) {
  const roleName = roleSchema.parse(access.roleName), workspaceId = z.string().uuid().parse(access.workspaceId);
  if (access.schemaName !== `${roleName}_facts`) throw new Error("PROOF_READER_CLEANUP_INVALID");
  await db.$client.begin(async tx => {
    const rows = await tx`select shobj_description(oid,'pg_authid') as marker from pg_roles where rolname=${roleName}`;
    if (rows.length !== 1 || rows[0]!.marker !== marker(workspaceId, access.schemaVersion)) throw new Error("PROOF_READER_CLEANUP_INVALID");
    await tx.unsafe(`drop schema ${quote(access.schemaName)} cascade`);
    const [{ name }] = await tx<{ name: string }[]>`select current_database() as name`;
    await tx.unsafe(`revoke connect on database ${quote(name!)} from ${quote(roleName)}`);
    await tx.unsafe(`drop role ${quote(roleName)}`);
  });
}
