import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import type { Db } from "@paperclipai/db";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const FOREIGN_WORKSPACE_ID = "5f9f7195-e5ce-4fd0-b8c7-ed151347e6e0";
const TARGET_ID = "b80f266a-87ea-47f0-81bd-c4f04e4d576e";
const TARGET_REVISION_ID = "c80f266a-87ea-47f0-81bd-c4f04e4d576e";
const GRAPH_REVISION_ID = "d80f266a-87ea-47f0-81bd-c4f04e4d576e";
const WORK_NODE_ID = "e80f266a-87ea-47f0-81bd-c4f04e4d576e";
const CLAIM_ID = "6cf266a0-87ea-47f0-81bd-c4f04e4d576e";
const SUBMISSION_ID = "3df266a0-87ea-47f0-81bd-c4f04e4d576e";
const ACTION_REQUEST_ID = "7df266a0-87ea-47f0-81bd-c4f04e4d576e";
const APPROVAL_ID = "8ef266a0-87ea-47f0-81bd-c4f04e4d576e";
const RECEIPT_ID = "9ff266a0-87ea-47f0-81bd-c4f04e4d576e";
const CONNECTION_ID = "aa1f266a-87ea-47f0-81bd-c4f04e4d576e";

function receipt(resourceType: string, resourceId: string, replayed = false) {
  return { schemaVersion: 1, resourceType, resourceId, replayed };
}

function integrationRunBody() {
  return {
    targetId: TARGET_ID,
    targetRevisionId: TARGET_REVISION_ID,
    graphRevisionId: GRAPH_REVISION_ID,
    claimId: CLAIM_ID,
    workNodeId: WORK_NODE_ID,
    connectorVersion: "github.v1",
    connectionId: CONNECTION_ID,
    provider: "github",
    externalRef: "ci:run:1",
    commitRef: "0123456789abcdef",
    criterionKey: "criterion-1",
    environmentRef: "github:owner/repo:main",
    conclusion: "success",
    objectHash: "a".repeat(64),
    reference: "ci:job:1",
    providerReceipt: { runId: 1, workflow: "verify" },
  };
}

function humanWorkResultBody() {
  return {
    targetId: TARGET_ID,
    targetRevisionId: TARGET_REVISION_ID,
    graphRevisionId: GRAPH_REVISION_ID,
    workNodeId: WORK_NODE_ID,
    inputHash: "b".repeat(64),
    result: { decision: "ready" },
    artifactRevisionId: null,
    attachmentHashes: ["c".repeat(64)],
  };
}

function actionRequestBody() {
  return {
    targetId: TARGET_ID,
    submissionId: SUBMISSION_ID,
    params: { title: "Add connector", head: "feat/connector", base: "main" },
  };
}

function normalizedActionRequestBody() {
  const input = actionRequestBody();
  return { ...input, params: { ...input.params, body: "" } };
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

async function createApp(
  domainApi: any,
  actor: Record<string, unknown> = boardActor(),
  resolveGithubCredential = vi.fn().mockResolvedValue({
    connectionId: CONNECTION_ID,
    authorization: "Bearer github-ephemeral-sentinel",
  }),
  collectGithubCiObservation?: (...args: any[]) => Promise<any>,
) {
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
  app.use("/api", connectorRoutes({ domainApiClient: domainApi, resolveGithubCredential, collectGithubCiObservation }));
  app.use(errorHandler);
  return app;
}

describe("connector routes", () => {
  const domainApi = {
    recordIntegrationRun: vi.fn(),
    recordHumanWorkResult: vi.fn(),
    requestPullRequestAction: vi.fn(),
    approveAction: vi.fn(),
    executeAction: vi.fn(),
    createGithubRepoBinding: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    domainApi.recordIntegrationRun.mockResolvedValue(receipt("integration_run", CLAIM_ID));
    domainApi.recordHumanWorkResult.mockResolvedValue(receipt("human_work_result", WORK_NODE_ID));
    domainApi.requestPullRequestAction.mockResolvedValue(receipt("action_request", ACTION_REQUEST_ID));
    domainApi.approveAction.mockResolvedValue(receipt("action_approval", APPROVAL_ID));
    domainApi.executeAction.mockResolvedValue(receipt("effect_receipt", RECEIPT_ID));
    domainApi.createGithubRepoBinding.mockResolvedValue(receipt("repo_binding", CONNECTION_ID));
  });

  it("proxies connector commands to the Domain API", async () => {
    const app = await createApp(domainApi);

    const integrationRun = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/integration-runs`)
      .set("Idempotency-Key", "connector:integration-run:record")
      .send(integrationRunBody());
    expect(integrationRun.status).toBe(201);
    expect(integrationRun.body).toEqual(receipt("integration_run", CLAIM_ID));

    const humanWorkResult = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/human-work-results`)
      .set("Idempotency-Key", "connector:human-work-result:record")
      .send(humanWorkResultBody());
    expect(humanWorkResult.status).toBe(201);
    expect(humanWorkResult.body).toEqual(receipt("human_work_result", WORK_NODE_ID));

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
    expect(domainApi.recordHumanWorkResult).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      principalType: "user",
      principalId: "user-1",
      idempotencyKey: "connector:human-work-result:record",
      input: humanWorkResultBody(),
    }));
    expect(domainApi.requestPullRequestAction).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "connector:action-request:create",
      input: normalizedActionRequestBody(),
    }));
    expect(domainApi.approveAction).toHaveBeenCalledWith(expect.objectContaining({
      actionRequestId: ACTION_REQUEST_ID,
      idempotencyKey: "connector:action:approve",
      input: approveBody(),
    }));
    expect(domainApi.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      actionRequestId: ACTION_REQUEST_ID,
      idempotencyKey: "connector:action:execute",
      githubConnectionId: CONNECTION_ID,
      githubAuthorization: "Bearer github-ephemeral-sentinel",
      input: { actionRequestId: ACTION_REQUEST_ID },
    }));
  });

  it("resolves the GitHub credential only for execution and never accepts one from the body", async () => {
    const resolveGithubCredential = vi.fn().mockResolvedValue({
      connectionId: CONNECTION_ID,
      authorization: "Bearer github-ephemeral-sentinel",
    });
    const app = await createApp(domainApi, boardActor(), resolveGithubCredential);

    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/executions`)
      .set("Idempotency-Key", "connector:action:ephemeral")
      .send({ actionRequestId: ACTION_REQUEST_ID });

    expect(response.status).toBe(201);
    expect(resolveGithubCredential).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining({
      actorType: "user",
      actorId: "user-1",
    }));
    expect(domainApi.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      githubAuthorization: "Bearer github-ephemeral-sentinel",
    }));

    const spoofed = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/executions`)
      .set("Idempotency-Key", "connector:action:spoofed-credential")
      .send({ actionRequestId: ACTION_REQUEST_ID, githubAuthorization: "Bearer attacker" });
    expect(spoofed.status).toBe(400);
  });

  it("does not call the Domain API when credential resolution fails", async () => {
    const resolveGithubCredential = vi.fn().mockRejectedValue(new Error("credential unavailable"));
    const app = await createApp(domainApi, boardActor(), resolveGithubCredential);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/executions`)
      .set("Idempotency-Key", "connector:action:no-credential")
      .send({ actionRequestId: ACTION_REQUEST_ID });

    expect(response.status).toBe(500);
    expect(domainApi.executeAction).not.toHaveBeenCalled();
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

  it("keeps HumanWorkResult human-only", async () => {
    const app = await createApp(domainApi, {
      type: "agent",
      agentId: "agent-1",
      companyId: WORKSPACE_ID,
      source: "agent_key",
      keyId: "key-1",
    });
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/human-work-results`)
      .set("Idempotency-Key", "connector:human-work-result:agent")
      .send(humanWorkResultBody());
    expect(response.status).toBe(403);
    expect(domainApi.recordHumanWorkResult).not.toHaveBeenCalled();
  });

  it("allows an authenticated workspace agent to create an action request", async () => {
    const app = await createApp(domainApi, {
      type: "agent",
      agentId: "agent-1",
      companyId: WORKSPACE_ID,
      source: "agent_key",
      keyId: "key-1",
    });
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions`)
      .set("Idempotency-Key", "connector:action-request:agent")
      .send(actionRequestBody());

    expect(response.status).toBe(201);
    expect(domainApi.requestPullRequestAction).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      principalType: "agent",
      principalId: "agent-1",
    }));
  });

  it("keeps action approval human-only", async () => {
    const app = await createApp(domainApi, {
      type: "agent",
      agentId: "agent-1",
      companyId: WORKSPACE_ID,
      source: "agent_key",
      keyId: "key-1",
    });
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions/${ACTION_REQUEST_ID}/approvals`)
      .set("Idempotency-Key", "connector:action:approve-agent")
      .send({ ...approveBody(), approverPrincipalId: "agent-1" });

    expect(response.status).toBe(403);
    expect(domainApi.approveAction).not.toHaveBeenCalled();
  });

  it("rejects an agent creating an action request across workspace boundaries", async () => {
    const app = await createApp(domainApi, {
      type: "agent",
      agentId: "agent-1",
      companyId: FOREIGN_WORKSPACE_ID,
      source: "agent_key",
      keyId: "key-1",
    });
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions`)
      .set("Idempotency-Key", "connector:action-request:foreign-agent")
      .send(actionRequestBody());

    expect(response.status).toBe(403);
    expect(domainApi.requestPullRequestAction).not.toHaveBeenCalled();
  });

  it("rejects action requester principal fields supplied in the body", async () => {
    const app = await createApp(domainApi);
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/pull-request-actions`)
      .set("Idempotency-Key", "connector:action-request:spoof")
      .send({ ...actionRequestBody(), principalType: "service", principalId: "spoofed-service" });

    expect(response.status).toBe(400);
    expect(domainApi.requestPullRequestAction).not.toHaveBeenCalled();
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

  it("creates a github repo binding through the connector facade", async () => {
    const app = await createApp(domainApi, boardActor([WORKSPACE_ID]));
    const response = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/github-repo-bindings`)
      .set("Idempotency-Key", "connector:binding:create")
      .send({ connectionId: CONNECTION_ID, repoOwner: "owner", repoName: "repo" });
    expect(response.status).toBe(201);
    expect(domainApi.createGithubRepoBinding).toHaveBeenCalledWith(
      expect.objectContaining({ principalType: "user", input: { connectionId: CONNECTION_ID, repoOwner: "owner", repoName: "repo" } }),
    );
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

describe("GitHub CI observation route", () => {
  const path = `/api/workspaces/${WORKSPACE_ID}/targets/${TARGET_ID}/github-ci-observations`;
  const input = { runId: "123", runAttempt: 2 };

  it.each(["session", "board_key", "cloud_tenant", "local_implicit"])("preserves actual initiating identity and %s source without domain ingestion", async (source) => {
    const collect = vi.fn().mockResolvedValue({ schemaVersion: 1, observation: { kind: "verrail.fixed-ci-observation" } });
    const domainApi = { recordIntegrationRun: vi.fn() };
    const actor = source === "local_implicit"
      ? { type: "board", userId: "local-board", source }
      : { ...boardActor(), source };
    const app = await createApp(domainApi, actor, vi.fn(), collect);
    const result = await request(app).post(path).send(input);
    expect(result.status).toBe(201);
    expect(collect).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, targetId: TARGET_ID, input,
      actor: { actorType: "user", actorId: actor.userId, actorSource: source } });
    expect(domainApi.recordIntegrationRun).not.toHaveBeenCalled();
  });

  it.each([
    ["anonymous", { type: "none", source: "none" }, 401],
    ["agent", { type: "agent", agentId: "agent-1", companyId: WORKSPACE_ID, source: "agent_key" }, 403],
    ["missing user", { ...boardActor(), userId: undefined }, 403],
    ["blank user", { ...boardActor(), userId: "  " }, 403],
    ["missing source", { ...boardActor(), source: undefined }, 403],
    ["foreign workspace", boardActor([FOREIGN_WORKSPACE_ID]), 403],
    ["missing membership", { ...boardActor(), memberships: undefined }, 403],
    ["inactive membership", { ...boardActor(), memberships: [{ companyId: WORKSPACE_ID, membershipRole: "owner", status: "inactive" }] }, 403],
    ["viewer including instance admin", { ...boardActor(), memberships: [{ companyId: WORKSPACE_ID, membershipRole: "viewer", status: "active" }] }, 403],
  ])("rejects %s before collection or secrets", async (_name, actor, status) => {
    const collect = vi.fn(); const resolve = vi.fn();
    const app = await createApp(null, actor as Record<string, unknown>, resolve, collect);
    expect((await request(app).post(path).send(input)).status).toBe(status);
    expect(collect).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, candidateSha: "a".repeat(40) }, { ...input, policy: {} },
    { ...input, githubAuthorization: "Bearer spoof" }, { ...input, principalId: "spoof" },
    { ...input, verdict: "passed" }, { ...input, artifactId: "123" },
    { ...input, runId: "0" }, { ...input, runId: "9007199254740992" },
    { ...input, runId: 123 }, { ...input, runId: "01" },
    { ...input, runAttempt: 0 }, { ...input, runAttempt: 1.5 }, { ...input, runAttempt: 2147483648 },
  ])("rejects non-contract collection input %j", async (body) => {
    const collect = vi.fn(); const app = await createApp(null, boardActor(), vi.fn(), collect);
    expect((await request(app).post(path).send(body)).status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });

  it("fails closed when no collector database is configured", async () => {
    const app = await createApp(null);
    const result = await request(app).post(path).send(input);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("GITHUB_CI_COLLECTION_UNAVAILABLE");
  });
});

// An actual stored ZIP member exercises the production decoder, not an injected success.
function observationZip(body: Buffer) {
  const name = Buffer.from("verrail-fixed-ci.json"); const checksum = crc32(body);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

async function productionObservationFixture() {
  const [{ connectorRoutes }, { errorHandler }, secrets, tables] = await Promise.all([
    import("../routes/connector.js"), import("../middleware/index.js"), import("../services/secrets.js"), import("@paperclipai/db"),
  ]);
  const targetId = randomUUID(); const bindingId = randomUUID(); const secretId = randomUUID();
  const now = new Date(Date.now() - 1000).toISOString(); const sha = "a".repeat(40);
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const checkIds = ["ts_tests", "ts_typecheck", "ts_build", "go_tests"];
  const stepNames = ["checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install", "proof_tests", ...checkIds, "source_unchanged"];
  const policy = {
    repository: "acme/repo", repositoryId: 42, workflowId: 11,
    workflow: { path: ".github/workflows/verrail-candidate-verify.yml", sha, sha256: digest("trusted workflow") },
    helper: { path: ".github/scripts/verrail-candidate-proof.mjs", sha256: digest("trusted helper") },
    requiredJobs: [{ name: "candidate_verify", steps: [...stepNames, "capture_results"] }, { name: "candidate_report", steps: ["checkout", "setup_node", "report", "upload"] }],
    artifactDownloadHosts: ["artifacts.example.com"], maxAgeMs: 86400000, timeoutMs: 5000,
    maxPages: 3, maxResponseBytes: 100000, maxArchiveBytes: 100000, maxReportBytes: 50000,
  };
  const entry = { workspaceId: WORKSPACE_ID, targetId, targetRevisionId: TARGET_REVISION_ID, graphRevisionId: GRAPH_REVISION_ID,
    connectionId: CONNECTION_ID, bindingId, authorizedUserIds: ["local-board", "user-1"], policy };
  vi.stubEnv("VERRAIL_GITHUB_CI_POLICIES", JSON.stringify([entry]));
  const report = {
    schemaVersion: 1, kind: "verrail.fixed-ci", repository: policy.repository,
    candidate: { sha, ref: "refs/heads/codex/g2-7-candidate-test" },
    workflow: { ...policy.workflow, ref: `${policy.repository}/${policy.workflow.path}@refs/heads/codex/g2-7-candidate-test` },
    helper: policy.helper, run: { id: "123", attempt: 2 },
    jobs: [{ id: "candidate_verify", result: "success", steps: stepNames.map(id => ({ id, outcome: "success", conclusion: "success" })) }],
    checks: checkIds.map(id => ({ id, status: "passed" })),
    unsupportedObligations: ["live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"],
  };
  const archive = observationZip(Buffer.from(JSON.stringify(report)));
  const run = { id: 123, run_attempt: 2, repository: { id: 42, full_name: policy.repository }, head_repository: { id: 42, full_name: policy.repository },
    workflow_id: 11, path: policy.workflow.path, head_sha: sha, head_branch: "codex/g2-7-candidate-test", event: "push", status: "completed", conclusion: "success", created_at: now };
  const jobs = policy.requiredJobs.map((j, index) => ({ id: index + 1, run_id: 123, head_sha: sha, name: j.name, status: "completed", conclusion: "success", completed_at: now,
    steps: j.steps.map((name, i) => ({ name, number: i + 1, status: "completed", conclusion: "success" })) }));
  const artifact = { id: 456, name: "verrail-fixed-ci-123-2", expired: false, size_in_bytes: archive.length, digest: `sha256:${digest(archive)}`,
    expires_at: new Date(Date.now() + 86400000).toISOString(), workflow_run: { id: 123, head_sha: sha, repository_id: 42, head_repository_id: 42 } };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe("GET"); expect(init.redirect).toBe("manual");
    if (url.startsWith("https://artifacts.example.com/")) {
      expect(new Headers(init.headers).has("authorization")).toBe(false); expect(init.credentials).toBe("omit");
      return new Response(archive);
    }
    expect(url.startsWith("https://api.github.com/repos/acme/repo/")).toBe(true);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-only-ephemeral");
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (url.includes("/contents/")) return json({ encoding: "base64", content: Buffer.from(url.includes("workflows") ? "trusted workflow" : "trusted helper").toString("base64") });
    if (url.includes("/jobs?")) return json({ total_count: jobs.length, jobs });
    if (url.includes("/artifacts?")) return json({ total_count: 1, artifacts: [artifact] });
    if (url.endsWith("/456/zip")) return new Response(null, { status: 302, headers: { location: "https://artifacts.example.com/archive?signed=private-download" } });
    return json(run);
  });
  vi.stubGlobal("fetch", fetch);
  const joined = { ...entry, targetHash: "b".repeat(64), targetStatus: "active", targetUpdatedAt: now,
    graphHash: "c".repeat(64), graphUpdatedAt: now, graphStatus: "active", graphActivatedAt: now,
    bindingCreatedAt: now, repoOwner: "acme", repoName: "repo", connectionUpdatedAt: now, authKind: "api_key",
    credentialRefs: [{ placement: "header", key: "Authorization", secretId }], credentialSecretRefs: [] };
  const rows = new Map<unknown, unknown[]>([
    [tables.verrailTargets, [joined]],
    [tables.companySecrets, [{ id: secretId, scope: "company", status: "active", provider: "local_encrypted", providerConfigId: null, externalRef: null, managedMode: "managed", latestVersion: 1, lastRotatedAt: now }]],
    [tables.companySecretVersions, [{ id: randomUUID(), version: 1, status: "active", revokedAt: null, providerVersionRef: null }]],
    [tables.companySecretProviderConfigs, []], [tables.instanceSettings, [{ general: { censorUsernameInLogs: false } }]],
  ]);
  const select = vi.fn(() => {
    let result: unknown[] = [];
    const chain: any = {
      from: (table: unknown) => { if (!rows.has(table)) throw new Error("Unexpected database read"); result = rows.get(table)!; return chain; },
      innerJoin: () => chain, where: () => chain, limit: () => Promise.resolve(result),
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  });
  const persisted: any[] = []; const auditId = randomUUID();
  const insert = vi.fn((table: unknown) => {
    expect(table).toBe(tables.activityLog);
    return { values: (value: unknown) => { persisted.push(value); return { returning: async () => [{ id: auditId }] }; } };
  });
  const db = { select, insert, transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ select })) } as unknown as Db;
  const resolve = vi.spyOn(secrets, "resolveGithubConnectorCredential").mockResolvedValue({ connectionId: CONNECTION_ID, authorization: "Bearer test-only-ephemeral" });
  const app = express(); app.use(express.json());
  let actor: Record<string, unknown> = { type: "board", userId: "local-board", source: "local_implicit" };
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", connectorRoutes({ db })); app.use(errorHandler);
  return { app, db, entry, resolve, fetch, persisted, auditId, insert, setActor: (value: Record<string, unknown>) => { actor = value; },
    path: `/api/workspaces/${WORKSPACE_ID}/targets/${targetId}/github-ci-observations` };
}

describe("GitHub CI production route composition", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("collects with real reader, adapters, ZIP and audit through connectorRoutes({db}) for actual local-board", async () => {
    const f = await productionObservationFixture();
    const result = await request(f.app).post(f.path).send({ runId: "123", runAttempt: 2 });
    expect(result.status).toBe(201);
    expect(f.resolve).toHaveBeenCalledWith(f.db, WORKSPACE_ID, { actorType: "user", actorId: "local-board", actorSource: "local_implicit" });
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect(f.db.transaction).toHaveBeenCalledTimes(3);
    expect(result.body).toMatchObject({ schemaVersion: 1, auditEventId: f.auditId, targetId: f.entry.targetId, observation: { kind: "verrail.fixed-ci-observation", testedCandidateSha: f.entry.policy.workflow.sha } });
    expect(f.persisted).toHaveLength(1);
    expect(f.persisted[0]).toMatchObject({ actorType: "user", actorId: "local-board", action: "github.ci_observation.collected", details: { actorSource: "local_implicit", verifier: "verrail/github-fixed-ci-reader/v1" } });
    expect(JSON.stringify([result.body, f.persisted])).not.toMatch(/test-only-ephemeral|private-download|criterionProof|assertions/);
  });

  it.each(["unauthorized", "unconfigured"])("rejects %s policy before secret or network in default composition", async mode => {
    const f = await productionObservationFixture();
    if (mode === "unauthorized") f.setActor({ ...boardActor(), userId: "not-authorized" });
    else vi.stubEnv("VERRAIL_GITHUB_CI_POLICIES", "");
    const result = await request(f.app).post(f.path).send({ runId: "123", runAttempt: 2 });
    expect(result.status).toBe(mode === "unauthorized" ? 403 : 503);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it("returns sanitized provider failure and no audit/domain write", async () => {
    const f = await productionObservationFixture(); f.fetch.mockRejectedValue(new Error("private-provider-body"));
    const result = await request(f.app).post(f.path).send({ runId: "123", runAttempt: 2 });
    expect(result.status).toBe(502); expect(JSON.stringify(result.body)).not.toContain("private-provider-body");
    expect(f.insert).not.toHaveBeenCalled();
  });

  it("fails closed when the required real audit persistence fails", async () => {
    const f = await productionObservationFixture(); f.insert.mockImplementation(() => { throw new Error("private-database-body"); });
    const result = await request(f.app).post(f.path).send({ runId: "123", runAttempt: 2 });
    expect(result.status).toBe(503); expect(JSON.stringify(result.body)).not.toContain("private-database-body");
  });
});
