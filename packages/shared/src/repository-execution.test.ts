import { describe, expect, it } from "vitest";
import { repositoryExecutionRequestSchema, repositorySourceReceiptSchema } from "./repository-execution.js";

const id = "11111111-1111-4111-8111-111111111111";
it("validates source receipts before browser Run binding", () => {
  const artifact = { artifactId: id, artifactRevisionId: id, contentHash: "a".repeat(64) };
  const receipt = { schemaVersion: 1, workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id,
    bindingId: id, connectionId: id, repository: "owner/repo", ref: "main", baseCommit: "b".repeat(40),
    authorizationContextHash: "c".repeat(64), source: { ...artifact, baseCommit: "b".repeat(40), format: "git_bundle" },
    provenanceArtifact: artifact };
  expect(repositorySourceReceiptSchema.safeParse(receipt).success).toBe(true);
  expect(repositorySourceReceiptSchema.safeParse({ ...receipt, authorization: "Bearer secret" }).success).toBe(false);
  expect(repositorySourceReceiptSchema.safeParse({ ...receipt, source: { ...receipt.source, baseCommit: "d".repeat(40) } }).success).toBe(false);
  expect(repositorySourceReceiptSchema.safeParse({ ...receipt, provenanceArtifact: { ...artifact, artifactRevisionId: "missing" } }).success).toBe(false);
});
const request = () => ({
  schemaVersion: 1, kind: "target_repository_execution",
  workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id,
  workNodeId: id, runId: id, runAttemptId: id, leaseId: id, fencingToken: 1,
  agentVersionId: id, deploymentRevisionId: id,
  source: { artifactId: id, contentHash: "a".repeat(64), baseCommit: "b".repeat(40), format: "git_bundle" },
  runtime: "opencode", model: "fixture/test", instructions: "Implement the assigned node.",
  timeoutSeconds: 120,
  output: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 2048 },
});

describe("repository execution request", () => {
  it("requires versioned Run, lease and immutable source identities", () => {
    expect(repositoryExecutionRequestSchema.safeParse(request()).success).toBe(true);
    for (const key of ["runId", "runAttemptId", "leaseId", "agentVersionId", "graphRevisionId"]) {
      expect(repositoryExecutionRequestSchema.safeParse({ ...request(), [key]: undefined }).success).toBe(false);
    }
  });
  it("rejects path, URL, credential and conversation authority injection", () => {
    for (const key of ["cwd", "repositoryUrl", "directorToken", "conversationId", "push", "env"]) {
      expect(repositoryExecutionRequestSchema.safeParse({ ...request(), [key]: "injected" }).success).toBe(false);
    }
    expect(repositoryExecutionRequestSchema.safeParse({ ...request(), source: { ...request().source, path: "/etc" } }).success).toBe(false);
  });
  it("rejects mutable source refs, stale fencing and unbounded output", () => {
    expect(repositoryExecutionRequestSchema.safeParse({ ...request(), source: { ...request().source, baseCommit: "main" } }).success).toBe(false);
    expect(repositoryExecutionRequestSchema.safeParse({ ...request(), fencingToken: 0 }).success).toBe(false);
    expect(repositoryExecutionRequestSchema.safeParse({ ...request(), timeoutSeconds: 3601 }).success).toBe(false);
    expect(repositoryExecutionRequestSchema.safeParse({ ...request(), output: { ...request().output, maxFileBytes: 4096 } }).success).toBe(false);
  });
});
