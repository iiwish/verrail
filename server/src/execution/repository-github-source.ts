import { loadGitHubCiCollectionContext } from "../services/github-ci-proof-context.js";
import { resolveGithubConnectorCredential } from "../services/secrets.js";
import { acquireRepositoryGitHubBundle, type RepositoryGitCommand } from "./repository-github-bundle.js";
import { resolveRepositoryGitHubRevision } from "./repository-github-revision.js";
import { assertRepositoryScratch } from "./repository-scratch.js";
import { registerRepositorySource } from "./repository-source-registration.js";

/** Returns unregistered source bytes; callers must durably admit them before dispatch. */
export async function acquireAuthorizedRepositorySource(
  options: Parameters<typeof resolveRepositoryGitHubRevision>[0] & {
    git?: RepositoryGitCommand; scratchRoot: string; validateScratch?: typeof assertRepositoryScratch;
  },
) {
  await (options.validateScratch ?? assertRepositoryScratch)(options.scratchRoot);
  const provenance = await resolveRepositoryGitHubRevision(options);
  const load = options.loadContext ?? loadGitHubCiCollectionContext;
  const recheck = async () => {
    options.signal.throwIfAborted();
    const current = await load(options.db, provenance.workspaceId, provenance.targetId);
    if (current.contextSha256 !== provenance.authorizationContextHash
      || current.workspaceId !== provenance.workspaceId || current.targetId !== provenance.targetId
      || current.targetRevisionId !== provenance.targetRevisionId || current.graphRevisionId !== provenance.graphRevisionId
      || current.bindingId !== provenance.bindingId || current.connectionId !== provenance.connectionId
      || current.repository !== provenance.repository) throw new Error("REPOSITORY_SOURCE_AUTHORIZATION_CHANGED");
    options.signal.throwIfAborted();
  };
  try {
    await recheck();
    const credential = await (options.resolveCredential ?? resolveGithubConnectorCredential)(options.db, provenance.workspaceId, options.actor);
    if (credential.connectionId !== provenance.connectionId) throw new Error("REPOSITORY_SOURCE_AUTHORIZATION_CHANGED");
    const source = await acquireRepositoryGitHubBundle({ repository: provenance.repository,
      baseCommit: provenance.baseCommit, authorization: credential.authorization,
      signal: options.signal, recheck, git: options.git, scratchRoot: options.scratchRoot, validateScratch: options.validateScratch });
    return { provenance, ...source, recheck };
  } catch {
    throw new Error("REPOSITORY_GITHUB_ACQUISITION_FAILED");
  }
}

/** Keep the acquisition authorization alive through every durable registration step. */
export async function prepareAuthorizedRepositorySource(options:
  Parameters<typeof acquireAuthorizedRepositorySource>[0]
  & Pick<Parameters<typeof registerRepositorySource>[0], "storage" | "domainApi">
) {
  const { recheck, ...source } = await acquireAuthorizedRepositorySource(options);
  return registerRepositorySource({ source, recheck, principalId: options.actor.actorId,
    signal: options.signal, storage: options.storage, domainApi: options.domainApi });
}
