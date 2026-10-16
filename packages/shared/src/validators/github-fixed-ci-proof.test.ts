import { describe, expect, it } from "vitest";
import { githubFixedCiProofCommandSchema, githubFixedCiProofTrustSchema, recordGithubFixedCiProofSchema } from "./github-fixed-ci-proof.js";

const id = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const gitSha = "b".repeat(40);
const publicInput = { runId: "123", runAttempt: 2, claimId: id, workNodeId: id, artifactRevisionId: id, requirementId: "fixed-ci" };
const command = { schemaVersion: 1, targetId: id, targetRevisionId: id, graphRevisionId: id,
  claimId: id, workNodeId: id, artifactRevisionId: id, criterionKey: "ci", requirementId: "fixed-ci",
  source: { runId: id, runAttemptId: id, runEventId: id, runEventContentHash: sha, outputReceiptSha256: sha, artifactOrdinal: 0 },
  ci: { providerRunId: "123", providerAttempt: 2, testedCommit: gitSha, verifiedAt: "2026-09-08T00:00:00Z",
    artifactId: "456", archiveSha256: sha, reportSha256: sha, observationSha256: sha },
  mapping: { version: 1, commitTreeSha: gitSha, sourceSnapshotTreeSha: gitSha, sourceContentSha256: sha } };

describe("fixed CI proof wire contracts", () => {
  it("accepts only public existing-resource selectors", () => {
    expect(recordGithubFixedCiProofSchema.parse(publicInput)).toEqual(publicInput);
    for (const field of ["source", "mapping", "ci", "observation", "auditEventId", "assertions", "verdict", "principalId", "token", "policy"]) {
      expect(recordGithubFixedCiProofSchema.safeParse({ ...publicInput, [field]: {} }).success).toBe(false);
    }
  });
  it("accepts a strictly bound internal command without a caller verdict", () => {
    expect(githubFixedCiProofCommandSchema.parse(command)).toEqual(command);
    for (const field of ["principalId", "verifierVersion", "assertions", "conclusion", "objectHash"]) {
      expect(githubFixedCiProofCommandSchema.safeParse({ ...command, [field]: "spoof" }).success).toBe(false);
    }
    for (const source of [{ ...command.source, artifactOrdinal: 10 }, { ...command.source, runEventContentHash: gitSha }, { ...command.source, extra: true }]) {
      expect(githubFixedCiProofCommandSchema.safeParse({ ...command, source }).success).toBe(false);
    }
  });
  it("bounds provider identities, exact commit digests and timestamps", () => {
    for (const change of [{ providerRunId: "01" }, { providerRunId: "9007199254740992" }, { providerAttempt: 2147483648 },
      { testedCommit: sha }, { verifiedAt: "today" }, { artifactId: "0" }, { observationSha256: "A".repeat(64) }]) {
      expect(githubFixedCiProofCommandSchema.safeParse({ ...command, ci: { ...command.ci, ...change } }).success).toBe(false);
    }
  });
  it("requires a single strict non-wildcard trust profile", () => {
    const trust = { schemaVersion: 1, workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id,
      connectionId: id, bindingId: id, policySha256: sha, repository: "owner/repo", repositoryId: 1, workflowId: 2,
      workflowExecutionSha: gitSha, workflowSha256: sha, helperSha256: sha, maxAgeMs: 60000 };
    expect(githubFixedCiProofTrustSchema.parse(trust)).toEqual(trust);
    for (const bad of [[trust], { ...trust, workspaceId: "*" }, { ...trust, assertions: ["live_codex"] },
      { ...trust, nativeExecutor: "caller" }, { ...trust, maxAgeMs: 604800001 }, { ...trust, repositoryId: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(githubFixedCiProofTrustSchema.safeParse(bad).success).toBe(false);
    }
  });
});
