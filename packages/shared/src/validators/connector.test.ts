import { describe, expect, it } from "vitest";
import {
  approveActionSchema,
  connectorIdempotencyKeySchema,
  createGithubRepoBindingSchema,
  executeActionSchema,
  pullRequestParamsSchema,
  recordHumanWorkResultSchema,
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
      targetRevisionId: "33333333-3333-4333-8333-333333333333",
      graphRevisionId: "44444444-4444-4444-8444-444444444444",
      claimId: otherUuid,
      workNodeId: "55555555-5555-4555-8555-555555555555",
      connectorVersion: "github-actions.v1",
      connectionId: "66666666-6666-4666-8666-666666666666",
      provider: "github",
      externalRef: "run/1234",
      commitRef: "abc123",
      criterionKey: "ac-1",
      environmentRef: "github-actions:ubuntu-24.04",
      conclusion: "success",
      objectHash: hash,
      reference: "ci/build/1234",
      providerReceipt: { runId: 1234, conclusion: "success" },
    };
    expect(recordIntegrationRunSchema.parse(base)).toMatchObject({ conclusion: "success" });
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
    expect(() => recordIntegrationRunSchema.parse({ ...base, workNodeId: null })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, connectorVersion: "" })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, providerReceipt: { accessToken: "secret" } })).toThrow();
    expect(() => recordIntegrationRunSchema.parse({ ...base, extra: 1 })).toThrow();
  });

  it("validates immutable human work results", () => {
    const base = {
      targetId: uuid,
      targetRevisionId: "33333333-3333-4333-8333-333333333333",
      graphRevisionId: "44444444-4444-4444-8444-444444444444",
      workNodeId: "55555555-5555-4555-8555-555555555555",
      inputHash: hash,
      result: { decision: "ready" },
      artifactRevisionId: "66666666-6666-4666-8666-666666666666",
      attachmentHashes: ["2".repeat(64)],
    };

    expect(recordHumanWorkResultSchema.parse(base)).toMatchObject({ result: { decision: "ready" } });
    expect(recordHumanWorkResultSchema.parse({ ...base, artifactRevisionId: null })).toMatchObject({ artifactRevisionId: null });
    expect(() => recordHumanWorkResultSchema.parse({ ...base, inputHash: "bad" })).toThrow();
    expect(() => recordHumanWorkResultSchema.parse({ ...base, attachmentHashes: ["bad"] })).toThrow();
    expect(() => recordHumanWorkResultSchema.parse({ ...base, result: { nested: { secret: "do-not-store" } } })).toThrow();
    expect(() => recordHumanWorkResultSchema.parse({ ...base, extra: true })).toThrow();
  });

  it("validates pull request action requests with strict params", () => {
    const base = {
      targetId: uuid,
      submissionId: otherUuid,
      params: { title: "Merge feature", head: "feat/x", base: "main", body: "## Verification\n\n- Passed" },
    };
    expect(requestPullRequestActionSchema.parse(base)).toMatchObject({
      params: { head: "feat/x", base: "main", body: "## Verification\n\n- Passed" },
    });

    expect(() => requestPullRequestActionSchema.parse({ ...base, params: { title: "x", head: "h" } })).toThrow();
    expect(() =>
      requestPullRequestActionSchema.parse({ ...base, params: { ...base.params, extra: 1 } }),
    ).toThrow();
    expect(() => requestPullRequestActionSchema.parse({ ...base, params: { ...base.params, title: "" } })).toThrow();
    expect(() =>
      requestPullRequestActionSchema.parse({ ...base, params: { ...base.params, head: "x".repeat(201) } }),
    ).toThrow();
    expect(() =>
      requestPullRequestActionSchema.parse({ ...base, params: { ...base.params, body: "x".repeat(65_537) } }),
    ).toThrow();
    expect(() => requestPullRequestActionSchema.parse({ ...base, extra: 1 })).toThrow();
  });

  it("validates pull request params standalone", () => {
    expect(pullRequestParamsSchema.parse({ title: "t", head: "h", base: "b" })).toMatchObject({ base: "b", body: "" });
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
