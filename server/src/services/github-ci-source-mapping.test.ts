import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readlink, readdir, rm, symlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureNativeSource } from "./verrail-native-source.js";
import { createNativeSourceSnapshot } from "./verrail-native-source-snapshot.js";
import { mapGitHubCiSource } from "./github-ci-source-mapping.js";

const exec = promisify(execFile);
const processFixture = vi.hoisted(() => ({ mode: "" as "" | "stall" | "oversize", pid: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: (...args: Parameters<typeof original.spawn>) => {
    if (processFixture.mode && Array.isArray(args[1]) && args[1].includes("mktree")) {
      const child = original.spawn(process.execPath, ["-e", `${processFixture.mode === "oversize" ? "process.stdout.write(Buffer.alloc(16385));" : ""}setInterval(() => {}, 1000)`], args[2]);
      processFixture.pid = child.pid ?? 0; return child;
    }
    return original.spawn(...args);
  } };
});
const temporary: string[] = [];
afterEach(async () => { processFixture.mode = ""; processFixture.pid = 0; await Promise.all(temporary.splice(0).map(cwd => rm(cwd, { recursive: true, force: true }))); });
const identity = { workspaceId: "workspace", heartbeatRunId: "heartbeat", agentId: "agent", runId: "run", attemptId: "attempt", deploymentRevisionId: "deployment", agentVersionId: "version" };
type Entry = { path: string; mode: string; type: string; sha: string };
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "verrail-mapping-test-")); temporary.push(cwd);
  const git = async (...args: string[]) => (await exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_EMAIL: "test@example.invalid" } })).stdout.trim();
  await git("init", "--quiet", "--template=");
  await mkdir(path.join(cwd, ".verrail")); await writeFile(path.join(cwd, ".verrail", "record"), "old delivery");
  await mkdir(path.join(cwd, "src", ".verrail"), { recursive: true }); await writeFile(path.join(cwd, "src", ".verrail", "nested"), "included");
  await writeFile(path.join(cwd, "code.txt"), "initial"); await git("add", "."); await git("commit", "--quiet", "-m", "initial");
  await writeFile(path.join(cwd, "code.txt"), "dirty actual bytes");
  await writeFile(path.join(cwd, "new executable"), "new bytes"); await chmod(path.join(cwd, "new executable"), 0o755);
  await writeFile(path.join(cwd, 'unicode-\u4e2d".txt'), Buffer.from([0, 1, 255])); await symlink("code.txt", path.join(cwd, "link"));
  const observation = await captureNativeSource({ cwd, identity, phase: "after_adapter_return" });
  const snapshot = await createNativeSourceSnapshot({ cwd, identity, source: observation });
  const source = { sourceSnapshotTreeSha: snapshot.sourceSnapshot.snapshotTree, sourceContentSha256: snapshot.sourceSnapshot.sourceContentSha256 };
  await writeFile(path.join(cwd, ".verrail", "record"), "delivery record changed only");
  await git("add", "."); await git("commit", "--quiet", "-m", "candidate");
  const read = async () => {
    const sha = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}");
    const entries: Entry[] = (await exec("git", ["ls-tree", "-z", "HEAD"], { cwd })).stdout.split("\0").filter(Boolean).map(line => {
      const [header, name] = line.split("\t"); const [mode, type, hash] = header!.split(" "); return { path: name!, mode: mode!, type: type!, sha: hash! };
    });
    const commit = { sha, tree: { sha: tree } }; const root = { sha: tree, truncated: false, tree: entries };
    const get = vi.fn(async (endpoint: string) => new Response(JSON.stringify(endpoint.includes("/commits/") ? commit : root)));
    const map = (extra = {}) => mapGitHubCiSource({ source, repository: "acme/repo", testedCandidateSha: sha, get, ...extra });
    return { sha, tree, entries, commit, root, get, map };
  };
  return { cwd, git, source, read };
}

describe("fixed CI independently derived product tree mapping", () => {
  it("maps exact dirty/untracked product bytes without equating synthetic and tested commits", async () => {
    const s = await fixture(), r = await s.read();
    expect(await r.map()).toEqual({ version: 1, commitTreeSha: r.tree, ...s.source });
    expect(r.tree).not.toBe(s.source.sourceSnapshotTreeSha);
    expect(r.get.mock.calls.map(call => call[0])).toEqual([`/repos/acme/repo/git/commits/${r.sha}`, `/repos/acme/repo/git/trees/${r.tree}`]);
    expect(await readlink(path.join(s.cwd, "link"))).toBe("code.txt");
  });
  it.each(["bytes", "nested_record", "mode", "symlink", "delete", "add"])("rejects actual covered %s mutation", async change => {
    const s = await fixture();
    if (change === "bytes") await writeFile(path.join(s.cwd, "code.txt"), "different");
    if (change === "nested_record") await writeFile(path.join(s.cwd, "src", ".verrail", "nested"), "different");
    if (change === "mode") await chmod(path.join(s.cwd, "new executable"), 0o644);
    if (change === "symlink") { await rm(path.join(s.cwd, "link")); await symlink("new executable", path.join(s.cwd, "link")); }
    if (change === "delete") await rm(path.join(s.cwd, "code.txt"));
    if (change === "add") await writeFile(path.join(s.cwd, ".verrail-other"), "included");
    await s.git("add", "."); await s.git("commit", "--quiet", "-m", "mutated");
    await expect((await s.read()).map()).rejects.toThrow("GitHub CI source mapping failed");
  });
  it.each(["wrong_commit", "wrong_tree", "missing_entry", "duplicate", "truncated", "no_truncated", "path", "mode", "type", "sha", "surrogate"])("rejects untrusted root response %s", async change => {
    const s = await fixture(), r = await s.read();
    if (change === "wrong_commit") r.commit.sha = "a".repeat(40);
    if (change === "wrong_tree") r.root.sha = "b".repeat(40);
    if (change === "missing_entry") r.root.tree.pop();
    if (change === "duplicate") r.root.tree.push(r.root.tree[0]!);
    if (change === "truncated") r.root.truncated = true;
    if (change === "no_truncated") delete (r.root as Partial<typeof r.root>).truncated;
    if (change === "path") r.root.tree[0]!.path = "../private";
    if (change === "mode") r.root.tree[0]!.mode = "100600";
    if (change === "type") r.root.tree[0]!.type = "commit";
    if (change === "sha") r.root.tree[0]!.sha = "invalid";
    if (change === "surrogate") r.root.tree[0]!.path = "\ud800";
    await expect(r.map()).rejects.toThrow("GitHub CI source mapping failed");
  });
  it("rejects malformed, redirected, oversized and stalled streams with bounded cancellation", async () => {
    const s = await fixture(), r = await s.read();
    for (const response of [new Response("private not JSON"), new Response("{}", { status: 302 }), new Response("x".repeat(101))]) {
      await expect(r.map({ get: async () => response, maxResponseBytes: 100 })).rejects.toThrow("GitHub CI source mapping failed");
    }
    const cancel = vi.fn();
    await expect(r.map({ get: async () => new Response(new ReadableStream({ cancel })), timeoutMs: 20 })).rejects.toThrow("GitHub CI source mapping failed");
    expect(cancel).toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(); r.get.mockClear();
    await expect(r.map({ signal: controller.signal })).rejects.toThrow("GitHub CI source mapping failed"); expect(r.get).not.toHaveBeenCalled();
  });
  it("cleans isolated temporary repositories on success and failure", async () => {
    const s = await fixture(), r = await s.read();
    const before = (await readdir(os.tmpdir())).filter(name => name.startsWith("verrail-ci-tree-"));
    await r.map(); r.root.tree.pop(); await expect(r.map()).rejects.toThrow();
    expect((await readdir(os.tmpdir())).filter(name => name.startsWith("verrail-ci-tree-"))).toEqual(before);
  });
  it.each(["stall", "oversize"] as const)("kills bounded %s plumbing and cleans its temporary directory before returning", async mode => {
    const s = await fixture(), r = await s.read();
    const before = (await readdir(os.tmpdir())).filter(name => name.startsWith("verrail-ci-tree-"));
    processFixture.mode = mode;
    await expect(r.map({ timeoutMs: 500 })).rejects.toThrow("GitHub CI source mapping failed");
    expect(processFixture.pid).toBeGreaterThan(0);
    expect(() => process.kill(processFixture.pid, 0)).toThrow();
    expect((await readdir(os.tmpdir())).filter(name => name.startsWith("verrail-ci-tree-"))).toEqual(before);
  });
});
