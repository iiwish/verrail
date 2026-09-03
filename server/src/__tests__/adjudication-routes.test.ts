import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const FOREIGN_WORKSPACE_ID = "5f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const TARGET_ID = "b80f266a-87ea-47f0-81bd-c4f04e4d576e";
const REVISION_ID = "0de2d166-850e-4c74-ab63-beb86129b52a";
const ARTIFACT_REVISION_ID = "1af266a0-87ea-47f0-81bd-c4f04e4d576e";
const VERIFICATION_RESULT_ID = "2cf266a0-87ea-47f0-81bd-c4f04e4d576e";
const SUBMISSION_ID = "3df266a0-87ea-47f0-81bd-c4f04e4d576e";
const REVIEW_ID = "4ea266a0-87ea-47f0-81bd-c4f04e4d576e";

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
  const [{ adjudicationRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/adjudication.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", adjudicationRoutes({ domainApiClient: domainApi }));
  app.use(errorHandler);
  return app;
}

describe("adjudication routes", () => {
  const domainApi = {
    createSubmission: vi.fn(),
    recordDeliveryReview: vi.fn(),
    acceptSubmission: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    domainApi.createSubmission.mockResolvedValue(receipt("submission", SUBMISSION_ID));
    domainApi.recordDeliveryReview.mockResolvedValue(receipt("delivery_review", REVIEW_ID));
    domainApi.acceptSubmission.mockResolvedValue(receipt("acceptance", SUBMISSION_ID));
  });

  it("proxies the three adjudication commands to the Domain API", async () => {
    const app = await createApp(domainApi);
    const submission = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/submissions`)
      .set("Idempotency-Key", "adjudication:submission:create")
      .send({
        targetId: TARGET_ID,
        targetRevisionId: REVISION_ID,
        artifactRevisionIds: [ARTIFACT_REVISION_ID],
        verificationResultIds: [VERIFICATION_RESULT_ID],
        commitRef: "git:abc123",
        environmentSummary: null,
        notes: null,
      });
    expect(submission.status).toBe(201);
    expect(submission.body).toEqual(receipt("submission", SUBMISSION_ID));

    const review = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/delivery-reviews`)
      .set("Idempotency-Key", "adjudication:review:record")
      .send({
        submissionId: SUBMISSION_ID,
        reviewerPrincipalType: "user",
        reviewerPrincipalId: "user-2",
        verdict: "approved",
        risks: null,
        unprovenItems: [],
        comments: null,
      });
    expect(review.status).toBe(201);
    expect(review.body).toEqual(receipt("delivery_review", REVIEW_ID));

    const acceptance = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/acceptances`)
      .set("Idempotency-Key", "adjudication:acceptance:create")
      .send({ submissionId: SUBMISSION_ID, reviewId: REVIEW_ID });
    expect(acceptance.status).toBe(201);
    expect(acceptance.body).toEqual(receipt("acceptance", SUBMISSION_ID));

    expect(domainApi.createSubmission).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      principalType: "user",
      principalId: "user-1",
      idempotencyKey: "adjudication:submission:create",
      input: {
        targetId: TARGET_ID,
        targetRevisionId: REVISION_ID,
        artifactRevisionIds: [ARTIFACT_REVISION_ID],
        verificationResultIds: [VERIFICATION_RESULT_ID],
        commitRef: "git:abc123",
        environmentSummary: null,
        notes: null,
      },
    }));
    expect(domainApi.recordDeliveryReview).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "adjudication:review:record",
      input: {
        submissionId: SUBMISSION_ID,
        reviewerPrincipalType: "user",
        reviewerPrincipalId: "user-2",
        verdict: "approved",
        risks: null,
        unprovenItems: [],
        comments: null,
      },
    }));
    expect(domainApi.acceptSubmission).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "adjudication:acceptance:create",
      input: { submissionId: SUBMISSION_ID, reviewId: REVIEW_ID },
    }));
  });

  it("returns 200 for replayed command receipts", async () => {
    domainApi.createSubmission.mockResolvedValue(receipt("submission", SUBMISSION_ID, true));
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/submissions`)
      .set("Idempotency-Key", "adjudication:submission:replay")
      .send({
        targetId: TARGET_ID,
        targetRevisionId: REVISION_ID,
        artifactRevisionIds: [ARTIFACT_REVISION_ID],
        verificationResultIds: [],
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(receipt("submission", SUBMISSION_ID, true));
  });

  it("returns 503 when the Domain API client is unconfigured", async () => {
    const app = await createApp(null);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/acceptances`)
      .set("Idempotency-Key", "adjudication:acceptance:unavail")
      .send({ submissionId: SUBMISSION_ID, reviewId: REVIEW_ID });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "ADJUDICATION_DOMAIN_API_UNAVAILABLE" });
    expect(domainApi.acceptSubmission).not.toHaveBeenCalled();
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/submissions`)
      .send({
        targetId: TARGET_ID,
        targetRevisionId: REVISION_ID,
        artifactRevisionIds: [ARTIFACT_REVISION_ID],
        verificationResultIds: [],
      });
    expect(response.status).toBe(400);
    expect(domainApi.createSubmission).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that violates the shared adjudication schema", async () => {
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/delivery-reviews`)
      .set("Idempotency-Key", "adjudication:review:invalid")
      .send({
        submissionId: SUBMISSION_ID,
        reviewerPrincipalType: "agent",
        reviewerPrincipalId: "agent-1",
        verdict: "approved",
        unprovenItems: [],
      });
    expect(response.status).toBe(400);
    expect(domainApi.recordDeliveryReview).not.toHaveBeenCalled();
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
      .post(`/api/workspaces/${WORKSPACE_ID}/submissions`)
      .set("Idempotency-Key", "adjudication:submission:agent")
      .send({
        targetId: TARGET_ID,
        targetRevisionId: REVISION_ID,
        artifactRevisionIds: [ARTIFACT_REVISION_ID],
        verificationResultIds: [],
      });
    expect(response.status).toBe(403);
    expect(domainApi.createSubmission).not.toHaveBeenCalled();
  });

  it("rejects board users outside the workspace with 403", async () => {
    const app = await createApp(domainApi, boardActor([FOREIGN_WORKSPACE_ID]));
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/acceptances`)
      .set("Idempotency-Key", "adjudication:acceptance:foreign")
      .send({ submissionId: SUBMISSION_ID, reviewId: REVIEW_ID });
    expect(response.status).toBe(403);
    expect(domainApi.acceptSubmission).not.toHaveBeenCalled();
  });
});
