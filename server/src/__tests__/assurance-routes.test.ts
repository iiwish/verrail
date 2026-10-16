import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { assuranceRoutes } from "../routes/assurance.js";
import { errorHandler } from "../middleware/error-handler.js";

const WORKSPACE_ID = "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const FOREIGN_WORKSPACE_ID = "5f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const TARGET_ID = "b80f266a-87ea-47f0-81bd-c4f04e4d576e";
const REVISION_ID = "0de2d166-850e-4c74-ab63-beb86129b52a";
const ARTIFACT_ID = "1af266a0-87ea-47f0-81bd-c4f04e4d576e";
const CLAIM_ID = "2cf266a0-87ea-47f0-81bd-c4f04e4d576e";
const EVIDENCE_ID = "3df266a0-87ea-47f0-81bd-c4f04e4d576e";
const CONTENT_HASH = "a".repeat(64);

function receipt(resourceType: string, resourceId: string, replayed = false) {
  return { schemaVersion: 1, resourceType, resourceId, replayed };
}

function boardActor(companyIds: string[] = [WORKSPACE_ID]) {
  return {
    type: "board",
    userId: "user-1",
    companyIds,
    memberships: [{ companyId: WORKSPACE_ID, membershipRole: "owner", status: "active" }],
    source: "session",
    isInstanceAdmin: true,
  };
}

async function createApp(domainApi: any, actor: Record<string, unknown> = boardActor(), options: Record<string, any> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", assuranceRoutes({ domainApiClient: domainApi, ...options }));
  app.use(errorHandler);
  return app;
}

describe("assurance routes", () => {
  function storedContent(contentRef = `storage:${WORKSPACE_ID}/verrail/run-artifacts/sha256/${CONTENT_HASH}`) {
    const limit = vi.fn().mockResolvedValue([{ contentHash: CONTENT_HASH, contentRef }]);
    const where = vi.fn(() => ({ limit }));
    const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })) };
    const storage = { getObject: vi.fn(async () => ({ stream: Readable.from([Buffer.from("candidate")]), contentLength: 9 })) };
    return { db, storage, limit, where };
  }
  it("serves stored revision bytes as a private attachment", async () => {
    const content = storedContent();
    const app = await createApp(null, boardActor(), content);
    const response = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/artifact-revisions/${REVISION_ID}/content`);
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("candidate");
    expect(response.headers["content-disposition"]).toContain("attachment;");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(content.storage.getObject).toHaveBeenCalledWith(WORKSPACE_ID, `${WORKSPACE_ID}/verrail/run-artifacts/sha256/${CONTENT_HASH}`);
  });
  it.each(["file:/etc/passwd", "https://example.com", `storage:${FOREIGN_WORKSPACE_ID}/verrail/run-artifacts/sha256/${CONTENT_HASH}`, `storage:${WORKSPACE_ID}/verrail/run-artifacts/sha256/${"b".repeat(64)}`])("does not dereference unsafe content %s", async (ref) => {
    const content = storedContent(ref);
    const response = await request(await createApp(null, boardActor(), content)).get(`/api/workspaces/${WORKSPACE_ID}/artifact-revisions/${REVISION_ID}/content`);
    expect(response.status).toBe(404);
    expect(content.storage.getObject).not.toHaveBeenCalled();
  });
  it.each([
    boardActor([FOREIGN_WORKSPACE_ID]),
    { type: "agent", agentId: "foreign-agent", companyId: FOREIGN_WORKSPACE_ID, source: "agent_key", keyId: "key" },
    { type: "none" },
  ])("denies content before database lookup for unauthorized actors", async (actor) => {
    const content = storedContent();
    const response = await request(await createApp(null, actor, content)).get(`/api/workspaces/${WORKSPACE_ID}/artifact-revisions/${REVISION_ID}/content`);
    expect([401, 403]).toContain(response.status);
    expect(content.db.select).not.toHaveBeenCalled();
    expect(content.storage.getObject).not.toHaveBeenCalled();
  });
  it("does not disclose missing revisions", async () => {
    const content = storedContent();
    content.limit.mockResolvedValue([]);
    const response = await request(await createApp(null, boardActor(), content)).get(`/api/workspaces/${WORKSPACE_ID}/artifact-revisions/${REVISION_ID}/content`);
    expect(response.status).toBe(404);
    expect(content.storage.getObject).not.toHaveBeenCalled();
  });
  const domainApi = {
    createArtifact: vi.fn(),
    addArtifactRevision: vi.fn(),
    createClaim: vi.fn(),
    recordEvidence: vi.fn(),
    recordVerificationResult: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    domainApi.createArtifact.mockResolvedValue(receipt("artifact", ARTIFACT_ID));
    domainApi.addArtifactRevision.mockResolvedValue(receipt("artifact_revision", ARTIFACT_ID));
    domainApi.createClaim.mockResolvedValue(receipt("claim", CLAIM_ID));
    domainApi.recordEvidence.mockResolvedValue(receipt("evidence", EVIDENCE_ID));
    domainApi.recordVerificationResult.mockResolvedValue(receipt("verification_result", CLAIM_ID));
  });

  it("proxies the five assurance commands to the Domain API", async () => {
    const app = await createApp(domainApi);
    const artifact = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/artifacts`)
      .set("Idempotency-Key", "assurance:artifact:create")
      .send({ targetId: TARGET_ID, kind: "code_change", title: "Patch" });
    expect(artifact.status).toBe(201);
    expect(artifact.body).toEqual(receipt("artifact", ARTIFACT_ID));

    const revision = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/artifact-revisions`)
      .set("Idempotency-Key", "assurance:artifact:revision")
      .send({ artifactId: ARTIFACT_ID, contentHash: CONTENT_HASH, contentRef: "git:abc123", sourceRunId: null });
    expect(revision.status).toBe(201);
    expect(revision.body).toEqual(receipt("artifact_revision", ARTIFACT_ID));

    const claim = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/claims`)
      .set("Idempotency-Key", "assurance:claim:create")
      .send({ targetId: TARGET_ID, targetRevisionId: REVISION_ID, criterionKey: "criterion-1", title: "Claim" });
    expect(claim.status).toBe(201);
    expect(claim.body).toEqual(receipt("claim", CLAIM_ID));

    const evidence = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/evidence`)
      .set("Idempotency-Key", "assurance:evidence:record")
      .send({
        targetId: TARGET_ID,
        claimId: CLAIM_ID,
        kind: "ci_result",
        producerPrincipalType: "service",
        producerPrincipalId: "ci",
        objectHash: CONTENT_HASH,
        reference: "ci:run:1",
        trustLevel: "high",
      });
    expect(evidence.status).toBe(201);
    expect(evidence.body).toEqual(receipt("evidence", EVIDENCE_ID));

    const verification = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/verification-results`)
      .set("Idempotency-Key", "assurance:verification:record")
      .send({ claimId: CLAIM_ID, verdict: "passed", verifierVersion: "verifier@1", evidenceIds: [EVIDENCE_ID] });
    expect(verification.status).toBe(201);
    expect(verification.body).toEqual(receipt("verification_result", CLAIM_ID));

    expect(domainApi.createArtifact).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      principalType: "user",
      principalId: "user-1",
      idempotencyKey: "assurance:artifact:create",
      input: { targetId: TARGET_ID, kind: "code_change", title: "Patch" },
    }));
    expect(domainApi.recordVerificationResult).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "assurance:verification:record",
      input: { claimId: CLAIM_ID, verdict: "passed", verifierVersion: "verifier@1", evidenceIds: [EVIDENCE_ID] },
    }));
  });

  it("returns 200 for replayed command receipts", async () => {
    domainApi.createArtifact.mockResolvedValue(receipt("artifact", ARTIFACT_ID, true));
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/artifacts`)
      .set("Idempotency-Key", "assurance:artifact:replay")
      .send({ targetId: TARGET_ID, kind: "report", title: "Report" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(receipt("artifact", ARTIFACT_ID, true));
  });

  it("returns 503 when the Domain API client is unconfigured", async () => {
    const app = await createApp(null);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/artifacts`)
      .set("Idempotency-Key", "assurance:artifact:unavailable")
      .send({ targetId: TARGET_ID, kind: "report", title: "Report" });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "ASSURANCE_DOMAIN_API_UNAVAILABLE" });
    expect(domainApi.createArtifact).not.toHaveBeenCalled();
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/artifacts`)
      .send({ targetId: TARGET_ID, kind: "report", title: "Report" });
    expect(response.status).toBe(400);
    expect(domainApi.createArtifact).not.toHaveBeenCalled();
  });

  it("rejects non-board actors with 403", async () => {
    const app = await createApp(domainApi, {
      type: "agent",
      agentId: "agent-1",
      companyId: WORKSPACE_ID,
      source: "agent_key",
      keyId: "key-1",
    });
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/artifacts`)
      .set("Idempotency-Key", "assurance:artifact:agent")
      .send({ targetId: TARGET_ID, kind: "report", title: "Report" });
    expect(response.status).toBe(403);
    expect(domainApi.createArtifact).not.toHaveBeenCalled();
  });

  it("rejects board users outside the workspace with 403", async () => {
    const app = await createApp(domainApi, boardActor([FOREIGN_WORKSPACE_ID]));
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/artifacts`)
      .set("Idempotency-Key", "assurance:artifact:foreign")
      .send({ targetId: TARGET_ID, kind: "report", title: "Report" });
    expect(response.status).toBe(403);
    expect(domainApi.createArtifact).not.toHaveBeenCalled();
  });
});
