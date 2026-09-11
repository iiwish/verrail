import {
  githubFixedCiProofCommandSchema, recordGithubFixedCiProofSchema, targetIdempotencyKeySchema,
  type GithubFixedCiProofTrust, type RecordGithubFixedCiProofInput,
} from "@paperclipai/shared";
import { HttpError, badRequest, conflict } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { createGitHubCiVerificationSession, type GitHubCiCollectionOptions, type GitHubCiVerificationContext } from "./github-ci-proof-collector.js";
import { createGitHubFixedCiProofClient, type GitHubFixedCiProofClient } from "./github-fixed-ci-proof-client.js";
import { loadGitHubCiSourceContext, type GitHubCiSourceContext } from "./github-ci-source-context.js";
import { mapGitHubCiSource } from "./github-ci-source-mapping.js";
import type { GithubConnectorCredentialActor } from "./secrets.js";

function assertTrust(trust: Readonly<GithubFixedCiProofTrust>, verified: GitHubCiVerificationContext) {
  const { entry, policySha256 } = verified;
  for (const key of ["workspaceId", "targetId", "targetRevisionId", "graphRevisionId", "connectionId", "bindingId"] as const) {
    if (trust[key] !== entry[key]) throw conflict("GitHub fixed CI proof trust does not match current policy");
  }
  if (trust.policySha256 !== policySha256 || trust.repository !== entry.policy.repository
    || trust.repositoryId !== entry.policy.repositoryId || trust.workflowId !== entry.policy.workflowId
    || trust.workflowExecutionSha !== entry.policy.workflow.sha || trust.workflowSha256 !== entry.policy.workflow.sha256
    || trust.helperSha256 !== entry.policy.helper.sha256 || trust.maxAgeMs !== entry.policy.maxAgeMs) {
    throw conflict("GitHub fixed CI proof trust does not match current policy");
  }
}

export function createGitHubFixedCiProofRecorder(options: GitHubCiCollectionOptions & {
  proofClient?: GitHubFixedCiProofClient | null;
  loadSourceContext?: typeof loadGitHubCiSourceContext;
  mapSource?: typeof mapGitHubCiSource;
}) {
  // Snapshot configuration at composition/startup, before any request or secret lookup.
  const client = options.proofClient === undefined ? createGitHubFixedCiProofClient() : options.proofClient;
  if (!client) return null;
  const session = createGitHubCiVerificationSession(options);
  const sourceContext: typeof loadGitHubCiSourceContext = async (db, input) => {
    try { return await (options.loadSourceContext ?? loadGitHubCiSourceContext)(db, input); }
    catch (error) {
      if (error instanceof HttpError && [403, 404, 409, 422].includes(error.status)) {
        throw new HttpError(error.status, "GitHub fixed CI proof source or requirement is unavailable");
      }
      throw new HttpError(503, "GitHub fixed CI proof source context is unavailable");
    }
  };
  return { async record(request: {
    workspaceId: string; targetId: string; idempotencyKey: string;
    actor: GithubConnectorCredentialActor; input: RecordGithubFixedCiProofInput;
  }) {
    const input = recordGithubFixedCiProofSchema.safeParse(request.input);
    const key = targetIdempotencyKeySchema.safeParse(request.idempotencyKey);
    if (!input.success || !key.success) throw badRequest("Invalid GitHub fixed CI proof request");
    const { claimId, workNodeId, artifactRevisionId, requirementId } = input.data;
    const selection = { workspaceId: request.workspaceId, targetId: request.targetId,
      targetRevisionId: client.trust.targetRevisionId, graphRevisionId: client.trust.graphRevisionId,
      claimId, workNodeId, artifactRevisionId, requirementId };
    let source: GitHubCiSourceContext;
    return session.run({ ...request, input: { runId: input.data.runId, runAttempt: input.data.runAttempt } }, {
      async preflight(verified) {
        assertTrust(client.trust, verified);
        source = await sourceContext(options.db, selection);
      },
      async consume({ entry, context, observation, dependencies, recheck, policySha256 }) {
        let mapping;
        try {
          mapping = await (options.mapSource ?? mapGitHubCiSource)({ source: source.snapshot,
            repository: context.repository, testedCandidateSha: observation.testedCandidateSha,
            get: dependencies.get, timeoutMs: entry.policy.timeoutMs, maxResponseBytes: entry.policy.maxResponseBytes });
        } catch { throw new HttpError(502, "GitHub fixed CI proof source mapping could not be verified"); }
        await recheck();
        const command = githubFixedCiProofCommandSchema.parse({ schemaVersion: 1,
          targetId: request.targetId, targetRevisionId: context.targetRevisionId, graphRevisionId: context.graphRevisionId,
          claimId, workNodeId, artifactRevisionId, criterionKey: source.criterionKey, requirementId,
          source: source.source,
          ci: { providerRunId: observation.providerRunId, providerAttempt: observation.providerAttempt,
            testedCommit: observation.testedCandidateSha, verifiedAt: observation.verifiedAt,
            artifactId: observation.artifactId, archiveSha256: observation.archiveSha256,
            reportSha256: observation.reportSha256, observationSha256: observation.receiptSha256 }, mapping });
        const verifySource = async () => {
          const current = await sourceContext(options.db, selection);
          if (source.contextSha256 !== current.contextSha256) throw conflict("GitHub fixed CI proof source context changed");
        };
        await verifySource();
        try {
          const audit = await (options.audit ?? logActivity)(options.db, {
            companyId: request.workspaceId, actorType: "user", actorId: request.actor.actorId,
            action: "github.fixed_ci_proof.collected", entityType: "target", entityId: request.targetId,
            details: { ...command, policySha256, actorSource: request.actor.actorSource,
              verifier: "verrail/github-fixed-ci-reader/v1", contextSha256: context.contextSha256,
              sourceContextSha256: source.contextSha256 },
          });
          if (!audit?.id) throw new Error();
        } catch { throw new HttpError(503, "GitHub fixed CI proof collection audit is unavailable"); }
        await recheck();
        await verifySource();
        return client.record({ workspaceId: request.workspaceId, idempotencyKey: key.data, input: command });
      },
    });
  } };
}
