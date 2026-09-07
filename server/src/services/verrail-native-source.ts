import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
export const NATIVE_SOURCE_CONTEXT_KEY = "verrailNativeSourceObservation";
const scope = {
  version: 1 as const,
  kind: "git_tracked_and_nonignored_untracked" as const,
  excludedPaths: [".verrail/run-artifacts/**"] as [".verrail/run-artifacts/**"],
  ignoredFiles: "outside_coverage" as const,
  symlinks: "relative_in_root_target_bytes_only" as const,
  contentMode: "git_owner_execute_bit" as const,
};
const limitations = ["not_runtime_build_attestation", "not_effective_permission_snapshot", "not_artifact_tree_equivalence", "not_adversarial_isolation"] as const;
export const NATIVE_SOURCE_LIMITS = Object.freeze({ files: 20_000, totalBytes: 512 * 1024 * 1024, fileBytes: 32 * 1024 * 1024, timeoutMs: 15_000, gitOutputBytes: 8 * 1024 * 1024 });
type CaptureLimits = Record<keyof typeof NATIVE_SOURCE_LIMITS, number>;
const reasonSchema = z.enum(["not_git", "unborn_head", "unsupported_format", "unsupported_index", "unsafe_path", "unsupported_file", "limit_exceeded", "deadline_exceeded", "source_changed", "read_failed", "unsupported_execution", "cwd_mismatch"]);
type Reason = z.infer<typeof reasonSchema>;
const id = z.string().min(1).max(128);
const identitySchema = z.object({ workspaceId: id, heartbeatRunId: id, agentId: id, runId: id, attemptId: id, deploymentRevisionId: id, agentVersionId: id }).strict();
export type NativeSourceIdentity = z.infer<typeof identitySchema>;
export type NativeSourcePhase = "before_dispatch" | "after_adapter_return";
const observationSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("verrail.native-source-observation"), phase: z.enum(["before_dispatch", "after_adapter_return"]),
  status: z.enum(["captured", "unavailable"]), observedAt: z.iso.datetime(), identity: identitySchema,
  scope: z.object({ version: z.literal(1), kind: z.literal(scope.kind), excludedPaths: z.tuple([z.literal(".verrail/run-artifacts/**")]), ignoredFiles: z.literal("outside_coverage"), symlinks: z.literal(scope.symlinks), contentMode: z.literal(scope.contentMode) }).strict(),
  limitations: z.tuple(limitations.map((item) => z.literal(item)) as [z.ZodLiteral<typeof limitations[0]>, z.ZodLiteral<typeof limitations[1]>, z.ZodLiteral<typeof limitations[2]>, z.ZodLiteral<typeof limitations[3]>]),
  reasonCode: reasonSchema.optional(),
  repository: z.object({ root: z.string().min(1).max(4096), headCommit: z.string().regex(/^[a-f0-9]{40}$/), headTree: z.string().regex(/^[a-f0-9]{40}$/), objectFormat: z.literal("sha1") }).strict().optional(),
  manifest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), contentSha256: z.string().regex(/^[a-f0-9]{64}$/), files: z.number().int().min(0).max(NATIVE_SOURCE_LIMITS.files), deletedFiles: z.number().int().min(0).max(NATIVE_SOURCE_LIMITS.files), bytes: z.number().int().min(0).max(NATIVE_SOURCE_LIMITS.totalBytes) }).strict().optional(),
}).strict().refine((value) => value.status === "captured"
  ? !!value.repository && !!value.manifest && !value.reasonCode
  : !!value.reasonCode && !value.repository && !value.manifest);
export type NativeSourceObservation = z.infer<typeof observationSchema>;

export function unavailableNativeSource(identity: NativeSourceIdentity, reasonCode: Reason, phase: NativeSourcePhase = "before_dispatch"): NativeSourceObservation {
  return { schemaVersion: 1, kind: "verrail.native-source-observation", phase, status: "unavailable", observedAt: new Date().toISOString(), identity: identitySchema.parse(identity), scope: { ...scope, excludedPaths: [...scope.excludedPaths] }, limitations: [...limitations], reasonCode };
}

// This validates structure and correlation, not authorship. Call only after the
// store has independently verified the server-owned system wakeup association.
export function validateNativeSourceObservation(raw: unknown, identity: NativeSourceIdentity, phase: NativeSourcePhase = "before_dispatch"): NativeSourceObservation | null {
  const parsed = observationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.phase !== phase || Object.keys(identitySchema.shape).some((key) => parsed.data.identity[key as keyof NativeSourceIdentity] !== identity[key as keyof NativeSourceIdentity])) return null;
  return parsed.data;
}

class Unavailable extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
function fail(reason: Reason): never { throw new Unavailable(reason); }
function safeRelative(value: string) {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value) || path.posix.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) fail("unsafe_path");
  return value;
}
function sameFile(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export async function captureNativeSource(input: {
  cwd: string; identity: NativeSourceIdentity;
  phase?: NativeSourcePhase;
  limits?: Partial<CaptureLimits>;
  /** Test-only interleaving; production never supplies this callback. */
  beforeRecheck?: () => Promise<void>;
}): Promise<NativeSourceObservation> {
  const base = unavailableNativeSource(input.identity, "read_failed", input.phase);
  const limits: CaptureLimits = { ...NATIVE_SOURCE_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    const value = input.limits?.[key];
    if (value !== undefined) limits[key] = Number.isSafeInteger(value) && value >= 0 ? Math.min(value, limits[key]) : 0;
  }
  const deadline = performance.now() + limits.timeoutMs;
  const check = () => { if (performance.now() >= deadline) fail("deadline_exceeded"); };
  const git = async (cwd: string, args: string[], failure: Reason = "read_failed") => {
    check();
    try {
      const result = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", ...args], {
        cwd, encoding: "buffer", maxBuffer: limits.gitOutputBytes, timeout: Math.max(1, Math.floor(deadline - performance.now())), killSignal: "SIGKILL",
        env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: "/nonexistent", XDG_CONFIG_HOME: "/nonexistent", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
      });
      check();
      return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    } catch (error) {
      if (error instanceof Unavailable) throw error;
      if ((error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail("limit_exceeded");
      if ((error as { killed?: boolean }).killed) fail("deadline_exceeded");
      check();
      fail(failure);
    }
  };
  try {
    check();
    if (!path.isAbsolute(input.cwd) || input.cwd.includes("\0")) fail("unsafe_path");
    const cwd = await realpath(input.cwd);
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"], "not_git")).replace(/\n$/, "");
    if (!path.isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root) || root.length > 4096 || await realpath(root) !== root) fail("unsafe_path");
    const relativeCwd = path.relative(root, cwd);
    if (relativeCwd.startsWith("../") || path.isAbsolute(relativeCwd)) fail("unsafe_path");
    const inventory = async () => {
      const format = (await git(cwd, ["rev-parse", "--show-object-format"])).trim();
      if (format !== "sha1") fail("unsupported_format");
      const headCommit = (await git(cwd, ["rev-parse", "--verify", "HEAD"], "unborn_head")).trim();
      const headTree = (await git(cwd, ["rev-parse", "--verify", "HEAD^{tree}"])).trim();
      if (!/^[a-f0-9]{40}$/.test(headCommit) || !/^[a-f0-9]{40}$/.test(headTree)) fail("unsupported_format");
      const tracked = await git(root, ["ls-files", "--stage", "-z", "--full-name"]);
      const others = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"]);
      const files = new Map<string, { indexedMode: string | null; indexedBlob: string | null }>();
      const add = (name: string, indexedMode: string | null, indexedBlob: string | null) => {
        safeRelative(name);
        if (name.startsWith(".verrail/run-artifacts/")) return;
        if (files.has(name)) fail("unsupported_index");
        files.set(name, { indexedMode, indexedBlob });
        if (files.size > limits.files) fail("limit_exceeded");
      };
      for (const record of tracked.split("\0").filter(Boolean)) {
        const match = /^(\d{6}) ([a-f0-9]{40}) ([0-3])\t([\s\S]+)$/.exec(record);
        if (!match || match[3] !== "0" || !["100644", "100755", "120000"].includes(match[1]!)) fail("unsupported_index");
        add(match[4]!, match[1]!, match[2]!);
      }
      for (const name of others.split("\0").filter(Boolean)) add(name, null, null);
      return { repository: { root, headCommit, headTree, objectFormat: "sha1" as const }, files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) };
    };
    const initial = await inventory();
    const records: unknown[] = [];
    const contentRecords: unknown[] = [];
    const fileStats = new Map<string, BigIntStats | null>();
    const directoryStats = new Map<string, BigIntStats>();
    let bytes = 0;
    let deletedFiles = 0;
    const parents = async (filename: string) => {
      let parent = root;
      for (const part of ["", ...filename.split("/").slice(0, -1)]) {
        if (part) parent = path.join(parent, part);
        check();
        let entry;
        try { entry = await lstat(parent, { bigint: true }); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail("unsupported_file");
        const previous = directoryStats.get(parent);
        if (previous && (previous.ino !== entry.ino || previous.dev !== entry.dev)) fail("source_changed");
        directoryStats.set(parent, entry);
      }
      return true;
    };
    for (const [name, indexed] of initial.files) {
      check();
      const absolute = path.join(root, name);
      const parentExists = await parents(name);
      let before: BigIntStats | null = null;
      if (parentExists) {
        try { before = await lstat(absolute, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (!before) {
        if (!indexed.indexedMode) fail("source_changed");
        deletedFiles++;
        records.push({ path: name, ...indexed, state: "deleted" });
        fileStats.set(absolute, null);
        continue;
      }
      if ((!before.isFile() && !before.isSymbolicLink()) || before.nlink !== 1n) fail("unsupported_file");
      if (before.size > BigInt(limits.fileBytes) || bytes + Number(before.size) > limits.totalBytes) fail("limit_exceeded");
      if (before.isSymbolicLink()) {
        const target = await readlink(absolute, { encoding: "buffer" });
        const targetText = new TextDecoder("utf-8", { fatal: true }).decode(target);
        if (path.isAbsolute(targetText)) fail("unsupported_file");
        if (!targetText || target.length > 4096 || /[\x00-\x1f\x7f\\]/.test(targetText)) fail("unsafe_path");
        const resolved = path.relative(root, path.resolve(path.dirname(absolute), targetText));
        if (resolved === ".." || resolved.startsWith("../") || path.isAbsolute(resolved)) fail("unsafe_path");
        if (!sameFile(before, await lstat(absolute, { bigint: true })) || target.length !== Number(before.size)) fail("source_changed");
        bytes += target.length;
        const content = { path: name, kind: "symlink", mode: "120000", bytes: target.length, sha256: createHash("sha256").update(target).digest("hex") };
        records.push({ ...content, ...indexed });
        contentRecords.push(content);
        fileStats.set(absolute, before);
        continue;
      }
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!sameFile(before, await handle.stat({ bigint: true }))) fail("source_changed");
        if (!await parents(name)) fail("source_changed");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(Math.min(Number(before.size) + 1, 64 * 1024));
        let offset = 0;
        while (true) {
          check();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          if (offset > Number(before.size)) fail("source_changed");
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (offset !== Number(before.size) || !sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await lstat(absolute, { bigint: true }))) fail("source_changed");
        bytes += offset;
        const content = { path: name, kind: "file", mode: (before.mode & 0o100n) !== 0n ? "100755" : "100644", bytes: offset, sha256: hash.digest("hex") };
        records.push({ ...content, ...indexed });
        contentRecords.push(content);
        fileStats.set(absolute, before);
      } finally { await handle.close(); }
    }
    await input.beforeRecheck?.();
    if (JSON.stringify(initial) !== JSON.stringify(await inventory()) || (await git(cwd, ["rev-parse", "--show-toplevel"])).replace(/\n$/, "") !== root || await realpath(input.cwd) !== cwd) fail("source_changed");
    for (const [filename, before] of fileStats) {
      check();
      let after: BigIntStats | null = null;
      try { after = await lstat(filename, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (before ? !after || !sameFile(before, after) : after !== null) fail("source_changed");
    }
    for (const [directory, before] of directoryStats) {
      check();
      const after = await lstat(directory, { bigint: true });
      if (!after.isDirectory() || after.ino !== before.ino || after.dev !== before.dev) fail("source_changed");
    }
    check();
    return { ...base, status: "captured", reasonCode: undefined, repository: initial.repository, manifest: {
      sha256: createHash("sha256").update(JSON.stringify({ scope, repository: initial.repository, records })).digest("hex"),
      contentSha256: createHash("sha256").update(JSON.stringify({ scope, records: contentRecords })).digest("hex"),
      files: records.length, deletedFiles, bytes,
    } };
  } catch (error) {
    return { ...base, reasonCode: error instanceof Unavailable ? error.reason : "read_failed" };
  }
}
