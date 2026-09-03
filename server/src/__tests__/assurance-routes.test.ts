import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function createApp(domainApi: any, actor: Record<string, unknown> = boardActor()) {
  const [{ assuranceRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/assurance.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", assuranceRoutes({ domainApiClient: domainApi }));
  app.use(errorHandler);
  return app;
}

describe("assurance routes", () => {
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
