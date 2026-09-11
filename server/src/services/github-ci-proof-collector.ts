import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { collectGithubCiObservationSchema, type CollectGithubCiObservationInput, type GithubCiObservationReceipt } from "@paperclipai/shared";
import { HttpError, badRequest, conflict, forbidden, tooManyRequests } from "../errors.js";
import { resolveGithubConnectorCredential, type GithubConnectorCredentialActor } from "./secrets.js";
import { logActivity } from "./activity-log.js";
import { createGitHubCiProofReader, type GitHubCiReadDependencies } from "./github-ci-proof-reader.js";
import { createGitHubCiReadDependencies } from "./github-ci-proof-adapters.js";
import { loadGitHubCiCollectionContext } from "./github-ci-proof-context.js";
import type { GitHubCiCollectionContext } from "./github-ci-proof-context.js";
import type { GithubCiObservation } from "@paperclipai/shared";

import { parseGitHubCiPolicies } from "./github-ci-proof-policy.js";
export { parseGitHubCiPolicies } from "./github-ci-proof-policy.js";

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

export interface GitHubCiCollectionOptions {
  db: Db;
  policyConfig?: () => string | undefined;
  loadContext?: typeof loadGitHubCiCollectionContext;
  resolveCredential?: typeof resolveGithubConnectorCredential;
  createReadDependencies?: typeof createGitHubCiReadDependencies;
  createReader?: typeof createGitHubCiProofReader;
  audit?: typeof logActivity;
  guard?: ReturnType<typeof createGitHubCiCollectionGuard>;
}

type CollectionRequest = {
  workspaceId: string; targetId: string; actor: GithubConnectorCredentialActor; input: CollectGithubCiObservationInput;
};

export interface GitHubCiVerificationContext {
  entry: ReturnType<typeof parseGitHubCiPolicies>[number];
  context: GitHubCiCollectionContext;
  policySha256: string;
}

/** Internal composition only; no HTTP body can supply hooks or a verified observation. */
export function createGitHubCiVerificationSession(options: GitHubCiCollectionOptions) {
  const config = options.policyConfig ?? (() => process.env.VERRAIL_GITHUB_CI_POLICIES);
  const context: typeof loadGitHubCiCollectionContext = async (db, workspaceId, targetId) => {
    try { return await (options.loadContext ?? loadGitHubCiCollectionContext)(db, workspaceId, targetId); }
    catch (error) {
      if (error instanceof HttpError && error.status === 409) throw conflict("GitHub CI collection context unavailable or changed");
      throw new HttpError(503, "GitHub CI collection context unavailable");
    }
  };
  return { async run<T>(request: CollectionRequest, hooks: {
    preflight?: (context: GitHubCiVerificationContext) => Promise<void>;
    consume: (context: GitHubCiVerificationContext & {
      observation: GithubCiObservation;
      dependencies: GitHubCiReadDependencies;
      recheck: () => Promise<void>;
    }) => Promise<T>;
  }): Promise<T> {
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
      const verificationContext = { entry, context: initial, policySha256 };
      await hooks.preflight?.(verificationContext);
      let credential;
      try { credential = await (options.resolveCredential ?? resolveGithubConnectorCredential)(options.db, request.workspaceId, request.actor); }
      catch { throw new HttpError(503, "GitHub CI credential unavailable"); }
      if (credential.connectionId !== initial.connectionId) throw conflict("GitHub CI collection connection changed");
      await recheck();
      let observation;
      let dependencies;
      try {
        dependencies = (options.createReadDependencies ?? createGitHubCiReadDependencies)({ repository: initial.repository, authorization: credential.authorization, artifactDownloadHosts: entry.policy.artifactDownloadHosts });
        observation = await (options.createReader ?? createGitHubCiProofReader)(entry.policy, dependencies).read({ ...parsed.data, candidateSha: entry.policy.workflow.sha });
      } catch { throw new HttpError(502, "GitHub CI observation could not be verified"); }
      await recheck();
      return await hooks.consume({ ...verificationContext, observation, dependencies, recheck });
    } finally { release(); }
  } };
}

export function createGitHubCiObservationCollector(options: GitHubCiCollectionOptions) {
  const session = createGitHubCiVerificationSession(options);
  return { collect(request: CollectionRequest): Promise<GithubCiObservationReceipt> {
    return session.run(request, { async consume({ context, policySha256, observation }) {
      const receipt = { schemaVersion: 1 as const, workspaceId: context.workspaceId, targetId: context.targetId,
        targetRevisionId: context.targetRevisionId, graphRevisionId: context.graphRevisionId,
        connectionId: context.connectionId, bindingId: context.bindingId, policySha256, observation };
      let audit;
      try {
        audit = await (options.audit ?? logActivity)(options.db, { companyId: request.workspaceId,
          actorType: "user", actorId: request.actor.actorId, action: "github.ci_observation.collected",
          entityType: "target", entityId: request.targetId,
          details: { ...receipt, actorSource: request.actor.actorSource, verifier: "verrail/github-fixed-ci-reader/v1", contextSha256: context.contextSha256 },
        });
        if (!audit?.id) throw new Error();
      } catch { throw new HttpError(503, "GitHub CI observation audit unavailable"); }
      return { ...receipt, auditEventId: audit.id };
    } });
  } };
}
