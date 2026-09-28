import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, verrailAgentVersions, verrailDeploymentRevisions } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { resolveNativeRunWorkspace } from "./verrail-native-workspace.js";
import type { NativeSourceIdentity } from "./verrail-native-source.js";

export const NATIVE_DISPATCH_CONTEXT_KEY = "verrailNativeDispatchConfiguration";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({ workspaceId: z.string().uuid(), runId: z.string().uuid(), attemptId: z.string().uuid(),
  heartbeatRunId: z.string().uuid(), agentId: z.string().uuid(), agentVersionId: z.string().uuid(), deploymentRevisionId: z.string().uuid() }).strict();
const fields = ["engine", "dangerouslyBypassApprovalsAndSandbox", "dangerouslyBypassSandbox", "permissionMode", "acpPermissionMode",
  "nonInteractivePermissions", "acpNonInteractivePermissions", "filesystemScope", "filesystemExtraPaths", "networkScope", "networkAllowlist",
  "command", "agentCommand", "acpAgentCommand", "args", "extraArgs"] as const;
const limitations = ["not_effective_permission_enforcement", "not_runtime_build_attestation", "ambient_config_and_credentials_not_attested"] as const;
export const nativeDispatchConfigurationSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("verrail.native-dispatch-configuration"), scope: z.literal("selected_adapter_fields"),
  identity: identitySchema, model: z.string().min(1).max(256), runtime: z.literal("codex_local"),
  agentVersionContentHash: hash, deploymentRevisionContentHash: hash,
  configurationSha256: hash, permissionFieldsSha256: hash, versionedPermissionFieldsSha256: hash.nullable(),
  binding: z.enum(["version_bound", "compatibility_only"]), recordedAt: z.iso.datetime(),
  runtimeSessionId: z.string().uuid().optional(),
  limitations: z.tuple([z.literal(limitations[0]), z.literal(limitations[1]), z.literal(limitations[2])]), sha256: hash,
}).strict();
export type NativeDispatchConfiguration = z.infer<typeof nativeDispatchConfigurationSchema>;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function invalid(): never { throw new Error("NATIVE_DISPATCH_CONFIGURATION_INVALID"); }
const project = (config: Record<string, unknown>) => Object.fromEntries(fields.map(key => [key, config[key] ?? null]));

export function bindNativeDispatchConfiguration(input: { identity: NativeSourceIdentity; runtime: string; model: string;
  agentVersionContentHash: string; deploymentRevisionContentHash: string; permissionConfig: unknown; config: Record<string, unknown>; runtimeSessionId?: string }): NativeDispatchConfiguration {
  if (input.runtime !== "codex_local" || input.config.model !== input.model || !input.model.trim()) invalid();
  const observed = project(input.config);
  if (canonicalJson(observed).length > 16_384) invalid();
  let versionedPermissionFieldsSha256: string | null = null;
  if (input.permissionConfig !== undefined) {
    const parsed = z.record(z.string(), z.json()).safeParse(input.permissionConfig);
    if (!parsed.success || Object.keys(parsed.data).some(key => !fields.includes(key as typeof fields[number]))) invalid();
    const expected = project(parsed.data);
    if (canonicalJson(expected) !== canonicalJson(observed)) invalid();
    versionedPermissionFieldsSha256 = digest(expected);
  }
  const base = { schemaVersion: 1, kind: "verrail.native-dispatch-configuration", scope: "selected_adapter_fields",
    identity: input.identity, model: input.model, runtime: input.runtime, agentVersionContentHash: input.agentVersionContentHash,
    deploymentRevisionContentHash: input.deploymentRevisionContentHash, configurationSha256: digest({ model: input.model, permissions: observed }),
    permissionFieldsSha256: digest(observed), versionedPermissionFieldsSha256,
    ...(input.runtimeSessionId ? { runtimeSessionId: input.runtimeSessionId } : {}),
    binding: versionedPermissionFieldsSha256 ? "version_bound" : "compatibility_only", recordedAt: new Date().toISOString(), limitations };
  const result = nativeDispatchConfigurationSchema.safeParse({ ...base, sha256: digest(base) });
  if (!result.success) invalid();
  return result.data;
}

export function validateNativeDispatchConfiguration(raw: unknown, identity: NativeSourceIdentity): NativeDispatchConfiguration | null {
  const parsed = nativeDispatchConfigurationSchema.safeParse(raw);
  if (!parsed.success || canonicalJson(parsed.data.identity) !== canonicalJson(identity)) return null;
  const { sha256, ...base } = parsed.data;
  if (digest(base) !== sha256 || (base.binding === "version_bound"
    ? base.versionedPermissionFieldsSha256 !== base.permissionFieldsSha256 : base.versionedPermissionFieldsSha256 !== null)) return null;
  return parsed.data;
}

/** Read current trusted identity immediately before Adapter dispatch, not from wake payload fields. */
export async function loadNativeDispatchConfiguration(db: Db, identity: NativeSourceIdentity, config: Record<string, unknown>) {
  try {
    const binding = await resolveNativeRunWorkspace(db, { ...identity, context: { verrailRunId: identity.runId, verrailRunAttemptId: identity.attemptId } });
    if (!binding || binding.agentVersionId !== identity.agentVersionId || binding.deploymentRevisionId !== identity.deploymentRevisionId) invalid();
    const [row] = await db.select({ runtime: verrailAgentVersions.runtime, model: verrailAgentVersions.model,
      agentVersionContentHash: verrailAgentVersions.contentHash, deploymentRevisionContentHash: verrailDeploymentRevisions.contentHash,
      runtimeConfig: verrailDeploymentRevisions.runtimeConfig }).from(verrailAgentVersions)
      .innerJoin(verrailDeploymentRevisions, and(eq(verrailDeploymentRevisions.agentVersionId, verrailAgentVersions.id),
        eq(verrailDeploymentRevisions.workspaceId, identity.workspaceId), eq(verrailDeploymentRevisions.id, identity.deploymentRevisionId)))
      .where(and(eq(verrailAgentVersions.id, identity.agentVersionId), eq(verrailAgentVersions.workspaceId, identity.workspaceId)));
    if (!row) invalid();
    return bindNativeDispatchConfiguration({ ...row, identity, config, permissionConfig: row.runtimeConfig.permissionConfig,
      runtimeSessionId: process.env.VERRAIL_RUNTIME_SESSION_ID });
  } catch { invalid(); }
}
