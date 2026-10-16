import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubFixedCiProofClient } from "./github-fixed-ci-proof-client.js";
import { HttpError } from "../errors.js";

const id = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const gitSha = "b".repeat(40);
const token = "proof-fixture-capability-not-a-live-secret";
const trust = { schemaVersion: 1, workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id,
  connectionId: id, bindingId: id, policySha256: sha, repository: "owner/repo", repositoryId: 1, workflowId: 2,
  workflowExecutionSha: gitSha, workflowSha256: sha, helperSha256: sha, maxAgeMs: 60000 };
const input = { schemaVersion: 1 as const, targetId: id, targetRevisionId: id, graphRevisionId: id,
  claimId: id, workNodeId: id, artifactRevisionId: id, criterionKey: "ci", requirementId: "fixed-ci",
  source: { runId: id, runAttemptId: id, runEventId: id, runEventContentHash: sha, outputReceiptSha256: sha, artifactOrdinal: 0 },
  ci: { providerRunId: "123", providerAttempt: 2, testedCommit: gitSha, verifiedAt: "2026-09-08T00:00:00Z",
    artifactId: "456", archiveSha256: sha, reportSha256: sha, observationSha256: sha },
  mapping: { version: 1 as const, commitTreeSha: gitSha, sourceSnapshotTreeSha: gitSha, sourceContentSha256: sha } };
const result = { schemaVersion: 1, resourceType: "integration_run", resourceId: id, replayed: false };
function setup(overrides: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(result), { status: 201 }));
  const options = { baseUrl: "http://127.0.0.1:1234", token, domainToken: "ordinary-domain-token",
    trustConfig: JSON.stringify(trust), fetchImpl, ...overrides };
  return { fetchImpl, client: createGitHubFixedCiProofClient(options)! };
}

describe("dedicated fixed CI proof capability client", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is disabled when both proof settings are absent", () => {
    vi.stubEnv("VERRAIL_GITHUB_CI_PROOF_TOKEN", undefined);
    vi.stubEnv("VERRAIL_GITHUB_CI_PROOF_TRUST", undefined);
    expect(createGitHubFixedCiProofClient()).toBeNull();
  });
  it("treats both literal empty proof settings as disabled, matching Go startup", () => {
    expect(createGitHubFixedCiProofClient({ token: "", trustConfig: "" })).toBeNull();
  });
  it("fails closed on partial, malformed, equal-token or unsafe startup configuration", () => {
    for (const override of [{ token: "" }, { trustConfig: "" }, { token: "short" }, { token: `${token}\n` },
      { domainToken: token }, { trustConfig: "{" }, { trustConfig: JSON.stringify([trust]) },
      { baseUrl: "http://domain.example.com" }, { baseUrl: "https://user:password@example.com" },
      { baseUrl: "https://example.com/path" }, { baseUrl: "https://example.com/?token=secret" }]) {
      expect(() => setup(override)).toThrow("GitHub fixed CI proof capability is misconfigured");
    }
  });
  it("rejects duplicate startup trust keys and dot repository components", () => {
    for (const raw of [JSON.stringify(trust).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      JSON.stringify(trust).replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
      JSON.stringify({ ...trust, repository: "../repo" }), JSON.stringify({ ...trust, repository: "owner/." })]) {
      expect(() => setup({ trustConfig: raw })).toThrow("GitHub fixed CI proof capability is misconfigured");
    }
  });
  it("sends only the dedicated token to a no-redirect fixed route without principal headers", async () => {
    const f = setup();
    expect(Object.isFrozen(f.client.trust)).toBe(true);
    expect(await f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:test", input })).toEqual(result);
    const [url, init] = f.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:1234/v1/workspaces/${id}/github-fixed-ci-proofs`);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
    expect(init.headers).toEqual({ Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "fixed-ci:test" });
    expect(JSON.parse(init.body as string)).toEqual(input);
  });
  it("snapshots startup trust and credentials instead of rereading process env", async () => {
    const f = setup();
    vi.stubEnv("VERRAIL_GITHUB_CI_PROOF_TOKEN", "changed");
    vi.stubEnv("VERRAIL_GITHUB_CI_PROOF_TRUST", "invalid");
    await expect(f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:snapshot", input })).resolves.toEqual(result);
  });
  it("rejects cross-workspace and malformed commands without network", async () => {
    const f = setup();
    await expect(f.client.record({ workspaceId: "22222222-2222-4222-8222-222222222222", idempotencyKey: "fixed-ci:test", input })).rejects.toMatchObject({ status: 403 });
    await expect(f.client.record({ workspaceId: id, idempotencyKey: "x", input })).rejects.toMatchObject({ status: 400 });
    await expect(f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:test", input: { ...input, conclusion: "success" } } as never)).rejects.toMatchObject({ status: 400 });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("never follows redirects or leaks provider/domain errors", async () => {
    for (const status of [302, 403, 409, 500]) {
      const f = setup(); f.fetchImpl.mockResolvedValue(new Response("private-domain-token", { status, headers: { location: "https://evil.example.com" } }));
      await expect(f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:test", input })).rejects.toMatchObject({
        status: [403, 409].includes(status) ? status : 503, message: "GitHub fixed CI proof could not be recorded" });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    }
    const f = setup(); f.fetchImpl.mockRejectedValue(new Error("private-transport-error"));
    await expect(f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:test", input })).rejects.toMatchObject({ status: 503, message: "GitHub fixed CI proof recording is unavailable" });
  });
  it("rejects malformed and oversized success responses", async () => {
    for (const body of ["{", JSON.stringify({ ...result, principalId: "spoof" }), " ".repeat(4097)]) {
      const f = setup(); f.fetchImpl.mockResolvedValue(new Response(body));
      await expect(f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:test", input })).rejects.toMatchObject({ status: 503 });
    }
  });
  it("bounds an oversized nonterminating response stream and cancels it", async () => {
    let canceled = false;
    const f = setup({ timeoutMs: 20 });
    f.fetchImpl.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4097)); }, cancel() { canceled = true; },
    }), { status: 201 }));
    const outcome = await Promise.race([f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:stream", input }).catch(error => error),
      new Promise(resolve => setTimeout(() => resolve("deadline missed"), 100))]);
    expect(outcome).toMatchObject({ status: 503 }); expect(canceled).toBe(true);
  });
  it("bounds a transport that ignores AbortSignal", async () => {
    const f = setup({ timeoutMs: 10 }); f.fetchImpl.mockImplementation(() => new Promise(() => {}));
    const outcome = await Promise.race([f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:timeout", input }).catch(error => error),
      new Promise(resolve => setTimeout(() => resolve("deadline missed"), 100))]);
    expect(outcome).toMatchObject({ status: 503 });
  });
  it("does not preserve a malicious transport HttpError", async () => {
    const f = setup(); f.fetchImpl.mockRejectedValue(new HttpError(403, "private-provider-error"));
    await expect(f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:error", input })).rejects.toMatchObject({ status: 503, message: "GitHub fixed CI proof recording is unavailable" });
  });
  it.each([[200, false], [201, true], [202, false]])("rejects inconsistent status %s replay %s", async (status, replayed) => {
    const f = setup(); f.fetchImpl.mockResolvedValue(new Response(JSON.stringify({ ...result, replayed }), { status }));
    await expect(f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:status", input })).rejects.toMatchObject({ status: 503 });
  });
  it("rejects an already-redirected response", async () => {
    const f = setup(); const response = new Response(JSON.stringify(result), { status: 201 });
    Object.defineProperty(response, "redirected", { value: true }); f.fetchImpl.mockResolvedValue(response);
    await expect(f.client.record({ workspaceId: id, idempotencyKey: "fixed-ci:redirect", input })).rejects.toMatchObject({ status: 503 });
  });
});
