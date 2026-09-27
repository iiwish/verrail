import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { acquireRepositoryGitHubBundle, runTrustedRepositoryGit, type RepositoryGitCommand } from "./repository-github-bundle.js";
import { prepareRepositoryCheckout } from "./repository-checkout.js";
import { acquireAuthorizedRepositorySource } from "./repository-github-source.js";

it("acquires the exact commit into a bundle without persisting fetch credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "verrail-github-bundle-test-"));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init", "--template=", "-b", "main");
    await writeFile(join(root, "hello.txt"), "pinned");
    git("add", "hello.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");
    const baseCommit = git("rev-parse", "HEAD");
    await writeFile(join(root, "hello.txt"), "later");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-am", "later");
    let acquisitionRoot = "";
    let fetched = 0;
    const run: RepositoryGitCommand = async (args, options) => {
      acquisitionRoot = options.cwd;
      expect(args.join(" ")).not.toContain("secret-sentinel");
      const remoteIndex = args.indexOf("https://github.com/owner/repo.git");
      const fixtureArgs = [...args];
      if (remoteIndex >= 0) {
        fetched++;
        expect(options.env.GIT_CONFIG_VALUE_0).toBe("Authorization: Bearer secret-sentinel");
        expect(args).toContain(`${baseCommit}:refs/heads/source`);
        // Replace only the network transport; all Git object and bundle work is real.
        fixtureArgs[remoteIndex] = root;
        fixtureArgs.unshift("-c", "protocol.file.allow=always");
      } else {
        expect(options.env.GIT_CONFIG_VALUE_0).toBeUndefined();
      }
      const result = execFileSync("git", fixtureArgs, { ...options, encoding: "utf8", stdio: "pipe" });
      if (remoteIndex >= 0) {
        const config = await readFile(join(options.cwd, "config"), "utf8");
        expect(config).not.toMatch(/secret-sentinel|extraheader/);
      }
      return result;
    };
    const context = { workspaceId: randomUUID(), targetId: randomUUID(), targetRevisionId: randomUUID(),
      graphRevisionId: randomUUID(), bindingId: randomUUID(), connectionId: randomUUID(),
      repository: "owner/repo", contextSha256: "b".repeat(64) };
    const loadContext = vi.fn().mockResolvedValue(context);
    const input = await acquireAuthorizedRepositorySource({ db: {} as Db,
      input: { workspaceId: context.workspaceId, targetId: context.targetId, targetRevisionId: context.targetRevisionId,
        graphRevisionId: context.graphRevisionId, ref: "main" },
      actor: { actorType: "user", actorId: "test-user", actorSource: "local_implicit" },
      resolveCredential: async () => ({ connectionId: context.connectionId, authorization: "Bearer secret-sentinel" }),
      loadContext, fetch: async () => Response.json({ sha: baseCommit }),
      signal: new AbortController().signal, git: run, scratchRoot: root, validateScratch: async () => {} });
    expect(fetched).toBe(1);
    expect(loadContext).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(input.provenance)).not.toContain("secret-sentinel");
    await expect(readFile(join(acquisitionRoot, "config"))).rejects.toMatchObject({ code: "ENOENT" });
    const checkout = await prepareRepositoryCheckout(input);
    try {
      expect(await readFile(join(checkout.cwd, "hello.txt"), "utf8")).toBe("pinned");
      expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("later");
    } finally { await checkout.dispose(); }
    await expect(input.recheck()).resolves.toBeUndefined();
    loadContext.mockResolvedValue({ ...context, graphRevisionId: randomUUID() });
    await expect(input.recheck()).rejects.toThrow("REPOSITORY_SOURCE_AUTHORIZATION_CHANGED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not launch Git for invalid input or revoked authorization", async () => {
  const git = vi.fn();
  const recheck = vi.fn().mockRejectedValue(new Error("revoked"));
  const input = { repository: "owner/repo", baseCommit: "a".repeat(40), authorization: "Bearer test",
    signal: new AbortController().signal, recheck, git, scratchRoot: tmpdir(), validateScratch: async () => {} };
  await expect(acquireRepositoryGitHubBundle({ ...input, repository: "../repo" })).rejects.toThrow("SOURCE_INVALID");
  await expect(acquireRepositoryGitHubBundle(input)).rejects.toThrow("ACQUISITION_FAILED");
  expect(git).not.toHaveBeenCalled();
});

it("rejects unadmitted scratch before credentials or network acquisition", async () => {
  const resolveCredential = vi.fn();
  const fetch = vi.fn();
  await expect(acquireAuthorizedRepositorySource({ db: {} as Db,
    input: { workspaceId: randomUUID(), targetId: randomUUID(), targetRevisionId: randomUUID(), graphRevisionId: randomUUID(), ref: "main" },
    actor: { actorType: "user", actorId: "operator", actorSource: "session" },
    signal: new AbortController().signal, scratchRoot: "relative", resolveCredential, fetch }))
    .rejects.toThrow("REPOSITORY_SCRATCH_INVALID");
  expect(resolveCredential).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("cleans temporary source and hides Git diagnostics on fetch failure", async () => {
  let cwd = "";
  const git: RepositoryGitCommand = async (_args, options) => { cwd = options.cwd; throw new Error("secret-sentinel"); };
  await expect(acquireRepositoryGitHubBundle({ repository: "owner/repo", baseCommit: "a".repeat(40),
    authorization: "Bearer test", signal: new AbortController().signal, recheck: async () => {}, git,
    scratchRoot: tmpdir(), validateScratch: async () => {} }))
    .rejects.toThrow(/^REPOSITORY_GITHUB_ACQUISITION_FAILED$/);
  await expect(readFile(join(cwd, "config"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("supervises a real Git process and cancels its process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "verrail-git-supervision-"));
  const controller = new AbortController();
  const options = { cwd: root, env: { PATH: process.env.PATH, HOME: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, signal: controller.signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(await runTrustedRepositoryGit(["--version"], options)).toContain("git version");
    timer = setTimeout(() => controller.abort(), 200);
    await expect(runTrustedRepositoryGit(["-c", "alias.pause=!sleep 30", "pause"], options)).rejects.toThrow("REPOSITORY_GIT_FAILED");
  } finally {
    if (timer) clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
});
