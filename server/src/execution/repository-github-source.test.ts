import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { beforeEach, expect, it, vi } from "vitest";
import { acquireRepositoryGitHubBundle } from "./repository-github-bundle.js";
import { resolveRepositoryGitHubRevision } from "./repository-github-revision.js";
import { prepareAuthorizedRepositorySource } from "./repository-github-source.js";

vi.mock("./repository-github-bundle.js", () => ({ acquireRepositoryGitHubBundle: vi.fn() }));
vi.mock("./repository-github-revision.js", () => ({ resolveRepositoryGitHubRevision: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const provenance = { schemaVersion: 1 as const, workspaceId: randomUUID(), targetId: randomUUID(),
    targetRevisionId: randomUUID(), graphRevisionId: randomUUID(), bindingId: randomUUID(), connectionId: randomUUID(),
    repository: "owner/repo", ref: "main", baseCommit: "a".repeat(40), authorizationContextHash: "b".repeat(64) };
  const bundle = Buffer.from("source fixture");
  const contentHash = createHash("sha256").update(bundle).digest("hex");
  vi.mocked(resolveRepositoryGitHubRevision).mockResolvedValue(provenance);
  vi.mocked(acquireRepositoryGitHubBundle).mockResolvedValue({ bundle, contentHash, baseCommit: provenance.baseCommit });
  const loadContext = vi.fn().mockResolvedValue({ ...provenance, contextSha256: provenance.authorizationContextHash });
  const putFile = vi.fn(async (input: { companyId: string; body: Buffer }) => {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    return { provider: "local_disk" as const, objectKey: `${input.companyId}/verrail/run-artifacts/sha256/${sha256}`,
      sha256, byteSize: input.body.length, contentType: "application/octet-stream", originalFilename: null };
  });
  const createArtifact = vi.fn().mockImplementation(async () => ({ schemaVersion: 1,
    resourceType: "artifact", resourceId: randomUUID(), replayed: false }));
  const addArtifactRevision = vi.fn().mockImplementation(async () => ({ schemaVersion: 1,
    resourceType: "artifact_revision", resourceId: randomUUID(), replayed: false }));
  return { provenance, loadContext, putFile, createArtifact, options: {
    db: {} as Db, input: { workspaceId: provenance.workspaceId, targetId: provenance.targetId,
      targetRevisionId: provenance.targetRevisionId, graphRevisionId: provenance.graphRevisionId, ref: "main" },
    actor: { actorType: "user" as const, actorId: "authorized-operator" }, signal: new AbortController().signal,
    scratchRoot: "/fixture", validateScratch: async () => {}, loadContext,
    resolveCredential: async () => ({ connectionId: provenance.connectionId, authorization: "Bearer fixture" }),
    storage: { putFile }, domainApi: { createArtifact, addArtifactRevision },
  } };
}

it("registers acquired source using the credential-requesting human identity", async () => {
  const f = fixture();
  const result = await prepareAuthorizedRepositorySource(f.options);
  expect(result.baseCommit).toBe(f.provenance.baseCommit);
  expect(f.putFile).toHaveBeenCalledTimes(2);
  expect(f.createArtifact).toHaveBeenCalledWith(expect.objectContaining({
    principalType: "user", principalId: "authorized-operator", workspaceId: f.provenance.workspaceId,
  }));
  expect(JSON.stringify(result)).not.toContain("Bearer fixture");
});

it("rechecks the acquisition context after upload before creating domain facts", async () => {
  const f = fixture();
  const upload = f.putFile.getMockImplementation()!;
  f.putFile.mockImplementation(async input => {
    const result = await upload(input);
    f.loadContext.mockResolvedValue({ ...f.provenance, contextSha256: "c".repeat(64) });
    return result;
  });
  await expect(prepareAuthorizedRepositorySource(f.options)).rejects.toThrow("REPOSITORY_SOURCE_AUTHORIZATION_CHANGED");
  expect(f.createArtifact).not.toHaveBeenCalled();
});
