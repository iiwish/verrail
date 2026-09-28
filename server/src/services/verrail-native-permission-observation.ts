import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import type { NativeSourceIdentity } from "./verrail-native-source.js";

export const NATIVE_PERMISSION_CONTEXT_KEY = "verrailNativePermissionObservation";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({ workspaceId: z.string().uuid(), agentId: z.string().uuid(), heartbeatRunId: z.string().uuid(),
  runId: z.string().uuid(), attemptId: z.string().uuid(), agentVersionId: z.string().uuid(), deploymentRevisionId: z.string().uuid() }).strict();
export const nativePermissionObservationSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("verrail.native-permission-observation"), scope: z.literal("control_plane_api"),
  identity: identitySchema, dispatchSha256: hash, tokenSha256: hash, apiOriginSha256: hash,
  probes: z.tuple([
    z.object({ name: z.literal("agent_self"), status: z.literal(200) }).strict(),
    z.object({ name: z.literal("board_context_denied"), status: z.literal(403) }).strict(),
    z.object({ name: z.literal("invalid_credential_denied"), status: z.literal(401) }).strict(),
    z.object({ name: z.literal("run_header_mismatch_denied"), status: z.literal(422) }).strict(),
  ]),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  limitations: z.tuple([z.literal("not_filesystem_or_network_isolation"), z.literal("not_independent_runtime_attestation")]), sha256: hash,
}).strict();
export type NativePermissionObservation = z.infer<typeof nativePermissionObservationSchema>;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const textDigest = (value: string) => createHash("sha256").update(value).digest("hex");
function unavailable(): never { throw new Error("NATIVE_PERMISSION_OBSERVATION_UNAVAILABLE"); }

export function validateNativePermissionObservation(raw: unknown, identity: NativeSourceIdentity, dispatchSha256: string): NativePermissionObservation | null {
  const parsed = nativePermissionObservationSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { sha256, ...observation } = parsed.data;
  if (canonicalJson(observation.identity) !== canonicalJson(identity) || observation.dispatchSha256 !== dispatchSha256
    || sha256 !== digest(observation) || Date.parse(observation.finishedAt) < Date.parse(observation.startedAt)
    || Date.parse(observation.finishedAt) - Date.parse(observation.startedAt) > 15_000) return null;
  return parsed.data;
}

/** Fixed read-only HTTP probes using the exact credential passed to the Adapter.
 * A host observation records behavior; a hash alone does not make it independent.
 */
export async function observeNativePermissions(input: { identity: NativeSourceIdentity; dispatchSha256: string; apiOrigin: string; authToken: string },
  dependencies: { fetch?: typeof fetch } = {}): Promise<NativePermissionObservation> {
  try {
    const identity = identitySchema.parse(input.identity), dispatchSha256 = hash.parse(input.dispatchSha256);
    const origin = new URL(input.apiOrigin);
    if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash || !origin.port || input.authToken.length > 8192) unavailable();
    const parts = input.authToken.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) unavailable();
    // Untrusted claim parsing selects the expected identity only. The API verifies the signature.
    const claims = z.object({ sub: z.literal(identity.agentId), company_id: z.literal(identity.workspaceId),
      run_id: z.literal(identity.heartbeatRunId), adapter_type: z.literal("codex_local"), exp: z.number().int().positive(),
    }).parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    if (claims.exp * 1000 <= Date.now()) unavailable();
    const startedAt = new Date().toISOString(), deadline = AbortSignal.timeout(12_000);
    const fetcher = dependencies.fetch ?? fetch;
    async function probe(path: string, credential: string, runId: string, expected: number) {
      const response = await fetcher(new URL(path, origin), { method: "GET", redirect: "error", credentials: "omit", signal: deadline,
        headers: { authorization: `Bearer ${credential}`, "X-Paperclip-Run-Id": runId } });
      if (response.redirected || response.status !== expected || !response.body) { await response.body?.cancel().catch(() => {}); unavailable(); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 256 * 1024) unavailable();
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    z.object({ id: z.literal(identity.agentId), companyId: z.literal(identity.workspaceId) }).parse(
      await probe("/api/agents/me", input.authToken, identity.heartbeatRunId, 200));
    await probe(`/api/workspaces/${identity.workspaceId}/delivery-context/codex`, input.authToken, identity.heartbeatRunId, 403);
    const invalid = `${parts[0]}.${parts[1]}.${parts[2]![0] === "a" ? "b" : "a"}${parts[2]!.slice(1)}`;
    await probe("/api/agents/me", invalid, identity.heartbeatRunId, 401);
    let mismatchedRunId = randomUUID();
    while (mismatchedRunId === identity.heartbeatRunId) mismatchedRunId = randomUUID();
    z.object({ code: z.literal("agent_jwt_run_id_mismatch"), details: z.object({
      code: z.literal("agent_jwt_run_id_mismatch"), claimRunId: z.literal(identity.heartbeatRunId), headerRunId: z.literal(mismatchedRunId),
    }) }).parse(
      await probe("/api/agents/me", input.authToken, mismatchedRunId, 422));
    if (deadline.aborted) unavailable();
    const observation = { schemaVersion: 1, kind: "verrail.native-permission-observation", scope: "control_plane_api", identity, dispatchSha256,
      tokenSha256: textDigest(input.authToken), apiOriginSha256: textDigest(origin.origin),
      probes: [{ name: "agent_self", status: 200 }, { name: "board_context_denied", status: 403 },
        { name: "invalid_credential_denied", status: 401 }, { name: "run_header_mismatch_denied", status: 422 }],
      startedAt, finishedAt: new Date().toISOString(), limitations: ["not_filesystem_or_network_isolation", "not_independent_runtime_attestation"] };
    const result = validateNativePermissionObservation({ ...observation, sha256: digest(observation) }, identity, dispatchSha256);
    if (!result) unavailable();
    return result;
  } catch { unavailable(); }
}
