import { z } from "zod";
import { HttpError } from "../errors.js";
import { createGitHubCiProofReader, type GitHubCiReadDependencies } from "./github-ci-proof-reader.js";
import { createGitHubCiReadDependencies } from "./github-ci-proof-adapters.js";

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

/** Shared by the application collector and the credential-isolated standalone reader. */
export function parseGitHubCiPolicies(raw: string | undefined) {
  try {
    if (!raw || Buffer.byteLength(raw, "utf8") > 131072) throw new Error();
    const entries = z.array(policySchema).min(1).max(64).parse(JSON.parse(raw));
    if (new Set(entries.map(p => `${p.workspaceId}/${p.targetId}`)).size !== entries.length) throw new Error();
    for (const entry of entries) {
      createGitHubCiProofReader(entry.policy, {} as GitHubCiReadDependencies);
      createGitHubCiReadDependencies({ repository: entry.policy.repository,
        artifactDownloadHosts: entry.policy.artifactDownloadHosts, authorization: "Bearer policy-validation-placeholder" });
    }
    return entries;
  } catch { throw new HttpError(503, "GitHub CI observation collection is disabled or misconfigured"); }
}
