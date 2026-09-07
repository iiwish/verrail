import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureNativeSource, validateNativeSourceObservation } from "./verrail-native-source.js";

const exec = promisify(execFile);
const identity = { workspaceId: "workspace-1", heartbeatRunId: "heartbeat-1", agentId: "agent-1", runId: "run-1", attemptId: "attempt-1", deploymentRevisionId: "deployment-1", agentVersionId: "version-1" };

describe("native pre-dispatch source observation", () => {
  let cwd: string;
  const git = (args: string[]) => exec("git", args, { cwd });
  const capture = (options: Parameters<typeof captureNativeSource>[0] = { cwd, identity }) => captureNativeSource(options);
  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-source-")));
    await git(["init", "-q"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(cwd, "source.ts"), "export const source = 1;\n");
    await git(["add", "."]);
    await git(["commit", "-qm", "fixture"]);
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("hashes stable actual bytes independently from HEAD and binds verified identities", async () => {
    const a = await capture();
    const b = await capture();
    expect(a).toMatchObject({ status: "captured", identity, repository: { root: cwd, objectFormat: "sha1" }, manifest: { files: 1, bytes: 25 } });
    expect(a.manifest).toEqual(b.manifest);
    expect(validateNativeSourceObservation(a, identity)).toEqual(a);
    expect(validateNativeSourceObservation({ ...a, identity: { ...identity, runId: "foreign" } }, identity)).toBeNull();
    expect(JSON.stringify(a)).not.toContain("export const");
  });
  it("keeps terminal captures phase-separated from dispatch observations", async () => {
    const terminal = await captureNativeSource({ cwd, identity, phase: "after_adapter_return" });
    expect(terminal.phase).toBe("after_adapter_return");
    expect(validateNativeSourceObservation(terminal, identity)).toBeNull();
    expect(validateNativeSourceObservation(terminal, identity, "after_adapter_return")).toEqual(terminal);
  });
  it("includes dirty, untracked, deleted and executable state even with assume-unchanged index", async () => {
    const digests = new Set<string | undefined>();
    digests.add((await capture()).manifest?.sha256);
    await git(["update-index", "--assume-unchanged", "source.ts"]);
    await writeFile(path.join(cwd, "source.ts"), "different bytes\n");
    digests.add((await capture()).manifest?.sha256);
    await writeFile(path.join(cwd, "untracked.ts"), "untracked\n");
    digests.add((await capture()).manifest?.sha256);
    await chmod(path.join(cwd, "untracked.ts"), 0o755);
    digests.add((await capture()).manifest?.sha256);
    await rm(path.join(cwd, "source.ts"));
    digests.add((await capture()).manifest?.sha256);
    expect(digests.size).toBe(5);
    expect(digests.has(undefined)).toBe(false);
    expect((await capture()).manifest?.deletedFiles).toBe(1);
  });
  it("keeps present-content digest stable through staging/commit while full index/HEAD state changes", async () => {
    await writeFile(path.join(cwd, "source.ts"), "changed bytes\n");
    await writeFile(path.join(cwd, "new.ts"), "new source\n");
    const dirty = await capture();
    await git(["add", "."]);
    const staged = await capture();
    await git(["commit", "-qm", "same source content"]);
    const committed = await capture();
    expect(dirty.manifest?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dirty.manifest?.contentSha256).toBe(staged.manifest?.contentSha256);
    expect(staged.manifest?.contentSha256).toBe(committed.manifest?.contentSha256);
    expect(dirty.manifest?.sha256).not.toBe(staged.manifest?.sha256);
    expect(dirty.repository?.headCommit).not.toBe(committed.repository?.headCommit);
    await chmod(path.join(cwd, "new.ts"), 0o654);
    expect((await capture()).manifest?.contentSha256).toBe(committed.manifest?.contentSha256);
    await chmod(path.join(cwd, "new.ts"), 0o754);
    expect((await capture()).manifest?.contentSha256).not.toBe(committed.manifest?.contentSha256);
  });
  it("rejects an actual unmerged index", async () => {
    const original = (await git(["branch", "--show-current"])).stdout.trim();
    await git(["checkout", "-qb", "conflicting"]);
    await writeFile(path.join(cwd, "source.ts"), "branch\n");
    await git(["commit", "-qam", "branch"]);
    await git(["checkout", "-q", original]);
    await writeFile(path.join(cwd, "source.ts"), "main\n");
    await git(["commit", "-qam", "main"]);
    await expect(git(["merge", "conflicting"])).rejects.toThrow();
    expect(await capture()).toMatchObject({ status: "unavailable", reasonCode: "unsupported_index" });
  });
  it("observes root from nested cwd and excludes only ignored files and exact native output namespace", async () => {
    await writeFile(path.join(cwd, ".gitignore"), "cache/\n");
    await mkdir(path.join(cwd, "cache"));
    await mkdir(path.join(cwd, ".verrail/run-artifacts/attempt"), { recursive: true });
    await mkdir(path.join(cwd, "nested"));
    const a = await capture();
    await writeFile(path.join(cwd, "cache/ignored"), "private ignored bytes");
    await writeFile(path.join(cwd, ".verrail/run-artifacts/attempt/output"), "output");
    const b = await capture({ cwd: path.join(cwd, "nested"), identity });
    expect(a.manifest).toEqual(b.manifest);
    expect(b.scope.excludedPaths).toEqual([".verrail/run-artifacts/**"]);
    await writeFile(path.join(cwd, ".verrail/source-contract.json"), "{}\n");
    expect((await capture()).manifest).not.toEqual(a.manifest);
  });
  it.each(["symlink", "hardlink", "directory", "unsafe"])("marks %s unavailable without reading source outside scope", async (kind) => {
    if (kind === "symlink") await symlink("/etc/passwd", path.join(cwd, "linked"));
    if (kind === "hardlink") await link(path.join(cwd, "source.ts"), path.join(cwd, "linked"));
    if (kind === "directory") { await rm(path.join(cwd, "source.ts")); await mkdir(path.join(cwd, "source.ts")); }
    if (kind === "unsafe") await writeFile(path.join(cwd, "bad\nname"), "unsafe");
    expect(await capture()).toMatchObject({ status: "unavailable", reasonCode: kind === "unsafe" ? "unsafe_path" : "unsupported_file" });
  });
  it("rejects submodules and unmerged index entries", async () => {
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["update-index", "--add", "--cacheinfo", `160000,${head},submodule`]);
    expect(await capture()).toMatchObject({ status: "unavailable", reasonCode: "unsupported_index" });
  });
  it("hashes relative in-root symlink target bytes without including linked contents", async () => {
    await mkdir(path.join(cwd, "links"));
    await symlink("../source.ts", path.join(cwd, "links/skill"));
    await git(["add", "links/skill"]);
    const a = await capture();
    expect(a).toMatchObject({ status: "captured", scope: { symlinks: "relative_in_root_target_bytes_only" } });
    await rm(path.join(cwd, "links/skill"));
    await symlink("../missing-in-root", path.join(cwd, "links/skill"));
    expect((await capture()).manifest).not.toEqual(a.manifest);
    await rm(path.join(cwd, "links/skill"));
    await symlink("../../outside", path.join(cwd, "links/skill"));
    expect(await capture()).toMatchObject({ status: "unavailable", reasonCode: "unsafe_path" });
  });
  it("reports absent or unborn Git without pretending to capture", async () => {
    await rm(path.join(cwd, ".git"), { recursive: true });
    expect(await capture()).toMatchObject({ status: "unavailable", reasonCode: "not_git" });
    await git(["init", "-q"]);
    expect(await capture()).toMatchObject({ status: "unavailable", reasonCode: "unborn_head" });
  });
  it.each([{ files: 0 }, { totalBytes: 1 }, { fileBytes: 1 }, { timeoutMs: 0 }, { gitOutputBytes: 1 }])("fails closed at bounded limit %j", async (limits) => {
    expect(await capture({ cwd, identity, limits })).toMatchObject({ status: "unavailable" });
  });
  it("does not inherit hostile Git environment or execute repository fsmonitor", async () => {
    const old = process.env.GIT_DIR;
    const oldTrace = process.env.GIT_TRACE;
    process.env.GIT_DIR = "/not/a/repository";
    process.env.GIT_TRACE = path.join(cwd, "leak");
    try {
      await exec("git", ["-C", cwd, "config", "core.fsmonitor", "sh -c 'touch ran-monitor'"], { env: { PATH: process.env.PATH } });
      expect(await capture()).toMatchObject({ status: "captured" });
      await expect(readFile(path.join(cwd, "ran-monitor"))).rejects.toThrow();
      await expect(readFile(path.join(cwd, "leak"))).rejects.toThrow();
    } finally {
      if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old;
      if (oldTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = oldTrace;
    }
  });
  it("never lazy-fetches missing partial-clone objects or executes configured upload-pack", async () => {
    const tree = (await git(["rev-parse", "HEAD^{tree}"])).stdout.trim();
    await git(["config", "extensions.partialClone", "origin"]);
    await git(["config", "remote.origin.promisor", "true"]);
    await git(["config", "remote.origin.url", cwd]);
    await git(["config", "remote.origin.uploadpack", `/usr/bin/touch ${path.join(cwd, "upload-pack-ran")}`]);
    await rm(path.join(cwd, ".git/objects", tree.slice(0, 2), tree.slice(2)));
    expect(await capture()).toMatchObject({ status: "unavailable" });
    await expect(readFile(path.join(cwd, "upload-pack-ran"))).rejects.toThrow();
  });
  it("marks mutation between inventory and final recheck unavailable", async () => {
    const result = await capture({ cwd, identity, beforeRecheck: async () => { await writeFile(path.join(cwd, "source.ts"), "raced"); } });
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "source_changed" });
  });
});
