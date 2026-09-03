import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const FOREIGN_WORKSPACE_ID = "5f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const TARGET_ID = "b80f266a-87ea-47f0-81bd-c4f04e4d576e";
const CLAIM_ID = "6cf266a0-87ea-47f0-81bd-c4f04e4d576e";
const SUBMISSION_ID = "3df266a0-87ea-47f0-81bd-c4f04e4d576e";
const ACTION_REQUEST_ID = "7df266a0-87ea-47f0-81bd-c4f04e4d576e";
const APPROVAL_ID = "8ef266a0-87ea-47f0-81bd-c4f04e4d576e";
const RECEIPT_ID = "9ff266a0-87ea-47f0-81bd-c4f04e4d576e";

function receipt(resourceType: string, resourceId: string, replayed = false) {
  return { schemaVersion: 1, resourceType, resourceId, replayed };
}

function integrationRunBody() {
  return {
    targetId: TARGET_ID,
    claimId: CLAIM_ID,
    workNodeId: null,
    provider: "github",
    externalRef: "ci:run:1",
    conclusion: "success",
    objectHash: "a".repeat(64),
    reference: "ci:job:1",
  };
}

function actionRequestBody() {
  return {
    targetId: TARGET_ID,
    submissionId: SUBMISSION_ID,
    params: { title: "Add connector", head: "feat/connector", base: "main" },
  };
}

function approveBody() {
  return {
    actionRequestId: ACTION_REQUEST_ID,
    approverPrincipalType: "user",
    approverPrincipalId: "user-2",
    paramsHash: "b".repeat(64),
  };
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
  const [{ connectorRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/connector.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", connectorRoutes({ domainApiClient: domainApi }));
  app.use(errorHandler);
  return app;
}

describe("connector routes", () => {
  const domainApi = {
    recordIntegrationRun: vi.fn(),
    requestPullRequestAction: vi.fn(),
    approveAction: vi.fn(),
    executeAction: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    domainApi.recordIntegrationRun.mockResolvedValue(receipt("integration_run", CLAIM_ID));
    domainApi.requestPullRequestAction.mockResolvedValue(receipt("action_request", ACTION_REQUEST_ID));
    domainApi.approveAction.mockResolvedValue(receipt("action_approval", APPROVAL_ID));
    domainApi.executeAction.mockResolvedValue(receipt("effect_receipt", RECEIPT_ID));
  });

  it("proxies the four connector commands to the Domain API", async () => {
    const app = await createApp(domainApi);

    const integrationRun = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/integration-runs`)
      .set("Idempotency-Key", "connector:integration-run:record")
      .send(integrationRunBody());
    expect(integrationRun.status).toBe(201);
    expect(integrationRun.body).toEqual(receipt("integration_run", CLAIM_ID));

    const actionRequest = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions`)
      .set("Idempotency-Key", "connector:action-request:create")
      .send(actionRequestBody());
    expect(actionRequest.status).toBe(201);
    expect(actionRequest.body).toEqual(receipt("action_request", ACTION_REQUEST_ID));

    const approval = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/approvals`)
      .set("Idempotency-Key", "connector:action:approve")
      .send(approveBody());
    expect(approval.status).toBe(201);
    expect(approval.body).toEqual(receipt("action_approval", APPROVAL_ID));

    const execution = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/executions`)
      .set("Idempotency-Key", "connector:action:execute")
      .send({ actionRequestId: ACTION_REQUEST_ID });
    expect(execution.status).toBe(201);
    expect(execution.body).toEqual(receipt("effect_receipt", RECEIPT_ID));

    expect(domainApi.recordIntegrationRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      principalType: "user",
      principalId: "user-1",
      idempotencyKey: "connector:integration-run:record",
      input: integrationRunBody(),
    }));
    expect(domainApi.requestPullRequestAction).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "connector:action-request:create",
      input: actionRequestBody(),
    }));
    expect(domainApi.approveAction).toHaveBeenCalledWith(expect.objectContaining({
      actionRequestId: ACTION_REQUEST_ID,
      idempotencyKey: "connector:action:approve",
      input: approveBody(),
    }));
    expect(domainApi.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      actionRequestId: ACTION_REQUEST_ID,
      idempotencyKey: "connector:action:execute",
      input: { actionRequestId: ACTION_REQUEST_ID },
    }));
  });

  it("returns 200 for replayed command receipts", async () => {
    domainApi.executeAction.mockResolvedValue(receipt("effect_receipt", RECEIPT_ID, true));
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/executions`)
      .set("Idempotency-Key", "connector:action:replay")
      .send({ actionRequestId: ACTION_REQUEST_ID });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(receipt("effect_receipt", RECEIPT_ID, true));
  });

  it("returns 503 when the Domain API client is unconfigured", async () => {
    const app = await createApp(null);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/integration-runs`)
      .set("Idempotency-Key", "connector:integration-run:unavail")
      .send(integrationRunBody());
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "CONNECTOR_DOMAIN_API_UNAVAILABLE" });
    expect(domainApi.recordIntegrationRun).not.toHaveBeenCalled();
  });

  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions`)
      .send(actionRequestBody());
    expect(response.status).toBe(400);
    expect(domainApi.requestPullRequestAction).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that violates the shared connector schema", async () => {
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/integration-runs`)
      .set("Idempotency-Key", "connector:integration-run:invalid")
      .send({ ...integrationRunBody(), provider: "gitlab" });
    expect(response.status).toBe(400);
    expect(domainApi.recordIntegrationRun).not.toHaveBeenCalled();
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
      .post(`/api/workspaces/${WORKSPACE_ID}/integration-runs`)
      .set("Idempotency-Key", "connector:integration-run:agent")
      .send(integrationRunBody());
    expect(response.status).toBe(403);
    expect(domainApi.recordIntegrationRun).not.toHaveBeenCalled();
  });

  it("rejects board users outside the workspace with 403", async () => {
    const app = await createApp(domainApi, boardActor([FOREIGN_WORKSPACE_ID]));
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/approvals`)
      .set("Idempotency-Key", "connector:action:foreign")
      .send(approveBody());
    expect(response.status).toBe(403);
    expect(domainApi.approveAction).not.toHaveBeenCalled();
  });

  it("returns 400 when the path action request does not match the payload", async () => {
    const app = await createApp(domainApi, boardActor([WORKSPACE_ID]));
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/executions`)
      .set("Idempotency-Key", "connector:action:mismatch")
      .send({ actionRequestId: "11111111-2222-4333-8444-555555555555" });
    expect(response.status).toBe(400);
    expect(domainApi.executeAction).not.toHaveBeenCalled();
  });
});
