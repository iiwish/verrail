import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { resolveRepositoryGitHubRevision } from "./repository-github-revision.js";

function fixture() {
  const input = { workspaceId: randomUUID(), targetId: randomUUID(), targetRevisionId: randomUUID(), graphRevisionId: randomUUID(), ref: "feature/code" };
  const context = { ...input, bindingId: randomUUID(), connectionId: randomUUID(), repository: "owner/repo", contextSha256: "c".repeat(64) };
  const loadContext = vi.fn().mockResolvedValue(context);
  const resolveCredential = vi.fn().mockResolvedValue({ connectionId: context.connectionId, authorization: "Bearer secret-sentinel" });
  const fetch = vi.fn().mockImplementation(async () => Response.json({ sha: "a".repeat(40), ignored: "provider-private-data" }));
  const controller = new AbortController();
  const options = { db: {} as Db, input, actor: { actorType: "user" as const, actorId: "operator", actorSource: "session" as const }, signal: controller.signal, loadContext, resolveCredential, fetch };
  return { options, context, controller, fetch, loadContext, resolveCredential };
}

describe("authorized GitHub revision acquisition", () => {
  it("pins a branch, rechecks authorization, and returns only source provenance", async () => {
    const f = fixture();
    const result = await resolveRepositoryGitHubRevision(f.options);
    expect(result.baseCommit).toBe("a".repeat(40));
    expect(result.repository).toBe("owner/repo");
    expect(JSON.stringify(result)).not.toMatch(/secret-sentinel|provider-private-data/);
    expect(f.loadContext).toHaveBeenCalledTimes(3);
    expect(f.fetch).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/commits/feature%2Fcode", expect.objectContaining({ redirect: "error", credentials: "omit", method: "GET" }));
  });

  it.each(["targetRevisionId", "graphRevisionId", "workspaceId", "targetId"] as const)("rejects a stale or foreign %s before credentials", async key => {
    const f = fixture();
    f.options.input[key] = randomUUID();
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow("unavailable");
    expect(f.resolveCredential).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([2, 3])("rejects authorization drift at context read %s", async read => {
    const f = fixture();
    f.loadContext.mockReset();
    for (let i = 1; i < read; i++) f.loadContext.mockResolvedValueOnce(f.context);
    f.loadContext.mockResolvedValue({ ...f.context, contextSha256: "d".repeat(64) });
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow("authorization changed");
    expect(f.fetch).toHaveBeenCalledTimes(read === 2 ? 0 : 1);
  });

  it("rejects connection replacement before HTTP", async () => {
    const f = fixture();
    f.resolveCredential.mockResolvedValue({ connectionId: randomUUID(), authorization: "Bearer secret-sentinel" });
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow("unavailable");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["..", ".", "bad\nref"])("rejects unsafe revision %s", async ref => {
    const f = fixture();
    f.options.input.ref = ref;
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow("unavailable");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([302, 401, 403, 404, 429, 500])("rejects HTTP %s without reflecting its body", async status => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response("secret-sentinel", { status }));
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow(/^Repository GitHub revision unavailable or authorization changed$/);
  });

  it("rejects a different commit when an exact SHA was requested", async () => {
    const f = fixture();
    f.options.input.ref = "b".repeat(40);
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow("unavailable");
  });

  it.each(["malformed", JSON.stringify({ sha: "main" }), "x".repeat(2 * 1024 * 1024 + 1)])("rejects invalid or oversized response %#", async body => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response(body));
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow("unavailable");
  });

  it("cancels a hanging response stream", async () => {
    const f = fixture();
    const cancel = vi.fn();
    f.fetch.mockImplementation(async () => new Response(new ReadableStream({
      pull() { setTimeout(() => f.controller.abort(), 0); }, cancel,
    })));
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow("unavailable");
    expect(cancel).toHaveBeenCalled();
  });

  it("does not resolve credentials or send HTTP after cancellation", async () => {
    const f = fixture(); f.controller.abort();
    await expect(resolveRepositoryGitHubRevision(f.options)).rejects.toThrow("unavailable");
    expect(f.resolveCredential).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
