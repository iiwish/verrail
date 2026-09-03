import { describe, expect, it } from "vitest";
import {
  approveActionSchema,
  connectorIdempotencyKeySchema,
  createGithubRepoBindingSchema,
  executeActionSchema,
  pullRequestParamsSchema,
  recordIntegrationRunSchema,
  requestPullRequestActionSchema,
} from "./connector.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const otherUuid = "22222222-2222-4222-8222-222222222222";
const hash = "1111111111111111111111111111111111111111111111111111111111111111";

describe("connector validators", () => {
  it("reuses the target idempotency key rules", () => {
    expect(connectorIdempotencyKeySchema.parse("connector:run:1234")).toBe("connector:run:1234");
    expect(connectorIdempotencyKeySchema.safeParse("short").success).toBe(false);
  });

  it("validates integration run recording", () => {
    const base = {
      targetId: uuid,
      claimId: otherUuid,
      provider: "github",
      externalRef: "run/1234",
      conclusion: "success",
      objectHash: hash,
      reference: "ci/build/1234",
    };
    expect(recordIntegrationRunSchema.parse(base)).toMatchObject({ conclusion: "success" });
    expect(
      recordIntegrationRunSchema.parse({ ...base, workNodeId: uuid }),
    ).toMatchObject({ workNodeId: uuid });
    expect(recordIntegrationRunSchema.parse({ ...base, workNodeId: null })).toMatchObject({
      workNodeId: null,
    });
    expect(recordIntegrationRunSchema.parse({ ...base, conclusion: "neutral" })).toMatchObject({
      conclusion: "neutral",
    });

    expect(() => recordIntegrationRunSchema.parse({ ...base, provider: "gitlab" })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, conclusion: "skipped" })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, externalRef: "" })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, externalRef: "x".repeat(301) })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, objectHash: "XYZ" })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, objectHash: hash.slice(1) })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, reference: "x".repeat(501) })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, workNodeId: "not-a-uuid" })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, extra: 1 })).toThrow();
  });

  it("validates pull request action requests with strict params", () => {
    const base = {
      targetId: uuid,
      submissionId: otherUuid,
      params: { title: "Merge feature", head: "feat/x", base: "main" },
    };
    expect(requestPullRequestActionSchema.parse(base)).toMatchObject({
      params: { head: "feat/x", base: "main" },
    });

    expect(() => requestPullRequestActionSchema.parse({ ...base, params: { title: "x", head: "h" } })).toThrow();
    expect(() =>
      requestPullRequestActionSchema.parse({ ...base, params: { ...base.params, extra: 1 } }),
    ).toThrow();
    expect(() => requestPullRequestActionSchema.parse({ ...base, params: { ...base.params, title: "" } })).toThrow();
    expect(() =>
      requestPullRequestActionSchema.parse({ ...base, params: { ...base.params, head: "x".repeat(201) } }),
    ).toThrow();
    expect(() => requestPullRequestActionSchema.parse({ ...base, extra: 1 })).toThrow();
  });

  it("validates pull request params standalone", () => {
    expect(pullRequestParamsSchema.parse({ title: "t", head: "h", base: "b" })).toMatchObject({ base: "b" });
    expect(() => pullRequestParamsSchema.parse({ title: "t", head: "h", base: "" })).toThrow();
    expect(() => pullRequestParamsSchema.parse({ title: "t", head: "h", base: "b", extra: true })).toThrow();
  });

  it("accepts approver wire parity fields and binds them to a human principal", () => {
    const base = { actionRequestId: uuid, approverPrincipalType: "user", approverPrincipalId: "approver-1", paramsHash: hash };
    expect(approveActionSchema.parse(base)).toMatchObject({ approverPrincipalId: "approver-1" });

    expect(() => approveActionSchema.parse({ ...base, approverPrincipalType: "agent" })).toThrow();
    expect(() => approveActionSchema.parse({ ...base, approverPrincipalId: "" })).toThrow();
    expect(() => approveActionSchema.parse({ ...base, approverPrincipalId: "x".repeat(201) })).toThrow();
    expect(() => approveActionSchema.parse({ ...base, paramsHash: "nope" })).toThrow();
    expect(() => approveActionSchema.parse({ actionRequestId: uuid })).toThrow();
    expect(() => approveActionSchema.parse({ ...base, extra: 1 })).toThrow();
  });

  it("validates action execution references", () => {
    expect(executeActionSchema.parse({ actionRequestId: uuid })).toMatchObject({ actionRequestId: uuid });
    expect(() => executeActionSchema.parse({ actionRequestId: "not-a-uuid" })).toThrow();
    expect(() => executeActionSchema.parse({})).toThrow();
    expect(() => executeActionSchema.parse({ actionRequestId: uuid, extra: 1 })).toThrow();
  });

  it("validates github repo binding creation", () => {
    const base = { connectionId: uuid, repoOwner: "owner", repoName: "repo" };
    expect(createGithubRepoBindingSchema.parse(base)).toMatchObject({ repoOwner: "owner" });
    expect(createGithubRepoBindingSchema.parse({ ...base, repoOwner: "  owner  " })).toMatchObject({ repoOwner: "owner" });
    expect(() => createGithubRepoBindingSchema.parse({ ...base, connectionId: "not-a-uuid" })).toThrow();
    expect(() => createGithubRepoBindingSchema.parse({ ...base, repoOwner: "" })).toThrow();
    expect(() => createGithubRepoBindingSchema.parse({ ...base, repoOwner: "x".repeat(201) })).toThrow();
    expect(() => createGithubRepoBindingSchema.parse({ ...base, repoName: "x".repeat(201) })).toThrow();
    expect(() => createGithubRepoBindingSchema.parse({ ...base, extra: 1 })).toThrow();
  });
});
