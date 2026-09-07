import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { collectGithubCiObservationSchema, type CollectGithubCiObservationInput, type GithubCiObservationReceipt } from "@paperclipai/shared";
import { HttpError, badRequest, conflict, forbidden, tooManyRequests } from "../errors.js";
import { resolveGithubConnectorCredential, type GithubConnectorCredentialActor } from "./secrets.js";
import { logActivity } from "./activity-log.js";
import { createGitHubCiProofReader, type GitHubCiReadDependencies } from "./github-ci-proof-reader.js";
import { createGitHubCiReadDependencies } from "./github-ci-proof-adapters.js";
import { loadGitHubCiCollectionContext } from "./github-ci-proof-context.js";

const positive = (max: number) => z.number().int().positive().max(max);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = z.object({
  workspaceId: z.string().uuid(), targetId: z.string().uuid(), targetRevisionId: z.string().uuid(),
  graphRevisionId: z.string().uuid(), connectionId: z.string().uuid(), bindingId: z.string().uuid(),
  authorizedUserIds: z.array(z.string().min(1).max(256).refine(v => v.trim() === v)).min(1).max(32).refine(v => new Set(v).size === v.length),
  policy: z.object({
    repository: z.string().max(401).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    repositoryId: positive(Number.MAX_SAFE_INTEGER), workflowId: positive(Number.MAX_SAFE_INTEGER),
    workflow: z.object({ path: z.literal(".github/workflows/verrail-candidate-verify.yml"), sha: z.string().regex(/^[a-f0-9]{40}$/), sha256 }).strict(),
    helper: z.object({ path: z.literal(".github/scripts/verrail-candidate-proof.mjs"), sha256 }).strict(),
    requiredJobs: z.array(z.object({ name: z.enum(["candidate_verify", "candidate_report"]), steps: z.array(z.string().min(1).max(100)).min(1).max(100) }).strict()).length(2),
    artifactDownloadHosts: z.array(z.string().max(253).regex(/^(?:[a-z][a-z0-9-]*\.)+[a-z]{2,}$/)).min(1).max(16).refine(v => new Set(v).size === v.length),
    maxAgeMs: positive(7 * 24 * 60 * 60 * 1000), timeoutMs: positive(120_000), maxPages: positive(20),
    maxResponseBytes: positive(2_000_000), maxArchiveBytes: positive(10_000_000), maxReportBytes: positive(1_000_000),
  }).strict(),
}).strict();

export function parseGitHubCiPolicies(raw: string | undefined) {
  try {
    if (!raw || Buffer.byteLength(raw, "utf8") > 131072) throw new Error();
    const entries = z.array(policySchema).min(1).max(64).parse(JSON.parse(raw));
    if (new Set(entries.map(p => `${p.workspaceId}/${p.targetId}`)).size !== entries.length) throw new Error();
    for (const entry of entries) {
      // Reuse the reader's complete required-step and identity validation, without I/O.
      createGitHubCiProofReader(entry.policy, {} as GitHubCiReadDependencies);
      // Validate against the production adapter too, before any real secret lookup.
      createGitHubCiReadDependencies({ repository: entry.policy.repository,
        artifactDownloadHosts: entry.policy.artifactDownloadHosts, authorization: "Bearer policy-validation-placeholder" });
    }
    return entries;
  } catch { throw new HttpError(503, "GitHub CI observation collection is disabled or misconfigured"); }
}

/** Process-local only: 4 in flight globally, 1/key, 4 starts/key/minute, 256 keys. */
export function createGitHubCiCollectionGuard(now: () => number = Date.now) {
  const keys = new Map<string, { startedAt: number; starts: number; active: boolean }>();
  let active = 0;
  return { acquire(key: string) {
    const time = now();
    for (const [id, state] of keys) if (!state.active && time - state.startedAt >= 60_000) keys.delete(id);
    const previous = keys.get(key);
    if (key.length > 256 || active >= 4 || previous?.active || (previous && previous.starts >= 4) || (!previous && keys.size >= 256)) throw tooManyRequests("GitHub CI collection capacity exceeded");
    const state = previous ?? { startedAt: time, starts: 0, active: false };
    state.starts++; state.active = true; active++; keys.set(key, state);
    let released = false;
    return () => { if (!released) { released = true; state.active = false; active--; } };
  } };
}
const processGuard = createGitHubCiCollectionGuard();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createGitHubCiObservationCollector(options: {
  db: Db;
  policyConfig?: () => string | undefined;
  loadContext?: typeof loadGitHubCiCollectionContext;
  resolveCredential?: typeof resolveGithubConnectorCredential;
  createReadDependencies?: typeof createGitHubCiReadDependencies;
  createReader?: typeof createGitHubCiProofReader;
  audit?: typeof logActivity;
  guard?: ReturnType<typeof createGitHubCiCollectionGuard>;
}) {
  const config = options.policyConfig ?? (() => process.env.VERRAIL_GITHUB_CI_POLICIES);
  const context: typeof loadGitHubCiCollectionContext = async (db, workspaceId, targetId) => {
    try { return await (options.loadContext ?? loadGitHubCiCollectionContext)(db, workspaceId, targetId); }
    catch (error) {
      if (error instanceof HttpError && error.status === 409) throw conflict("GitHub CI collection context unavailable or changed");
      throw new HttpError(503, "GitHub CI collection context unavailable");
    }
  };
  return { async collect(request: {
    workspaceId: string; targetId: string; actor: GithubConnectorCredentialActor; input: CollectGithubCiObservationInput;
  }): Promise<GithubCiObservationReceipt> {
    if (request.actor.actorType !== "user" || !request.actor.actorId?.trim()
      || !["session", "local_implicit", "board_key", "cloud_tenant"].includes(request.actor.actorSource ?? "")) throw forbidden("GitHub CI collection requires an authenticated initiating user");
    const parsed = collectGithubCiObservationSchema.safeParse(request.input);
    if (!parsed.success) throw badRequest("Invalid GitHub CI observation request");
    const entries = parseGitHubCiPolicies(config());
    const entry = entries.find(p => p.workspaceId === request.workspaceId && p.targetId === request.targetId);
    if (!entry) throw new HttpError(503, "GitHub CI observation collection is disabled or misconfigured");
    if (!entry.authorizedUserIds.includes(request.actor.actorId)) throw forbidden("GitHub CI collection is not authorized for this user");
    const policySha256 = hash(entry);
    const release = (options.guard ?? processGuard).acquire(`${request.workspaceId}/${request.targetId}`);
    try {
      const initial = await context(options.db, request.workspaceId, request.targetId);
      for (const key of ["workspaceId", "targetId", "targetRevisionId", "graphRevisionId", "connectionId", "bindingId"] as const) {
        if (initial[key] !== entry[key]) throw conflict("GitHub CI collection policy does not match current context");
      }
      if (initial.repository !== entry.policy.repository) throw conflict("GitHub CI collection policy does not match current context");
      const recheck = async () => {
        let current;
        try { current = parseGitHubCiPolicies(config()).find(p => p.workspaceId === request.workspaceId && p.targetId === request.targetId); }
        catch { throw conflict("GitHub CI collection policy changed"); }
        if (hash(current ?? null) !== policySha256) throw conflict("GitHub CI collection policy changed");
        const next = await context(options.db, request.workspaceId, request.targetId);
        if (hash(initial) !== hash(next)) throw conflict("GitHub CI collection context changed");
      };
      let credential;
      try { credential = await (options.resolveCredential ?? resolveGithubConnectorCredential)(options.db, request.workspaceId, request.actor); }
      catch { throw new HttpError(503, "GitHub CI credential unavailable"); }
      if (credential.connectionId !== initial.connectionId) throw conflict("GitHub CI collection connection changed");
      await recheck();
      let observation;
      try {
        const dependencies = (options.createReadDependencies ?? createGitHubCiReadDependencies)({ repository: initial.repository, authorization: credential.authorization, artifactDownloadHosts: entry.policy.artifactDownloadHosts });
        observation = await (options.createReader ?? createGitHubCiProofReader)(entry.policy, dependencies).read({ ...parsed.data, candidateSha: entry.policy.workflow.sha });
      } catch { throw new HttpError(502, "GitHub CI observation could not be verified"); }
      await recheck();
      const receipt = { schemaVersion: 1 as const, workspaceId: initial.workspaceId, targetId: initial.targetId,
        targetRevisionId: initial.targetRevisionId, graphRevisionId: initial.graphRevisionId,
        connectionId: initial.connectionId, bindingId: initial.bindingId, policySha256, observation };
      let audit;
      try {
        audit = await (options.audit ?? logActivity)(options.db, { companyId: request.workspaceId,
          actorType: "user", actorId: request.actor.actorId, action: "github.ci_observation.collected",
          entityType: "target", entityId: request.targetId,
          details: { ...receipt, actorSource: request.actor.actorSource, verifier: "verrail/github-fixed-ci-reader/v1", contextSha256: initial.contextSha256 },
        });
        if (!audit?.id) throw new Error();
      } catch { throw new HttpError(503, "GitHub CI observation audit unavailable"); }
      return { ...receipt, auditEventId: audit.id };
    } finally { release(); }
  } };
}
