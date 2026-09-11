import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunArtifactInputV1 } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";
import { createNativeSourceSnapshot, type NativeSourceSnapshot } from "./verrail-native-source-snapshot.js";
import type { NativeSourceIdentity, NativeSourceObservation } from "./verrail-native-source.js";

const fileSchema = z.object({
  title: z.string().trim().min(1).max(200), kind: z.enum(["code_change", "document", "report"]),
  path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).refine((value) => value !== "manifest.json"),
}).strict();
const manifestSchema = z.union([z.object({
  schemaVersion: z.literal(1),
  artifacts: z.array(fileSchema).min(1).max(10),
}).strict(), z.object({
  schemaVersion: z.literal(2), artifacts: z.array(z.discriminatedUnion("type", [
    fileSchema.extend({ type: z.literal("file") }),
    z.object({ type: z.literal("source_snapshot"), title: z.string().trim().min(1).max(200), format: z.literal("git_bundle"), scopeVersion: z.literal(2) }).strict(),
  ])).min(1).max(10),
}).strict()]).refine((value) => new Set(value.artifacts.map((item, ordinal) => "path" in item ? item.path : `source-${ordinal}.bundle`)).size === value.artifacts.length);

export class NativeRunArtifactError extends Error {
  constructor(cause: unknown) {
    super("NATIVE_ARTIFACT_INVALID: output collection failed", { cause });
  }
}

export function nativeRunArtifactDirectory(runAttemptId: string) {
  z.string().regex(/^[A-Za-z0-9-]{1,64}$/).parse(runAttemptId);
  return `.verrail/run-artifacts/${runAttemptId}`;
}

async function readBoundedFile(filename: string, limit: number, root: string, check: () => void) {
  check();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit
      || await realpath(path.dirname(filename)) !== root) throw new Error("Invalid file boundary or size");
    const body = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < body.length) {
      check();
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (!bytesRead) throw new Error("Artifact changed during collection");
      offset += bytesRead;
    }
    const after = await handle.stat();
    check();
    const current = await lstat(filename);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev
      || await realpath(path.dirname(filename)) !== root) throw new Error("Artifact changed during collection");
    return body;
  } finally { await handle.close(); }
}

export interface NativeArtifactMapping {
  ordinal: number;
  path: string;
  title: string;
  kind: RunArtifactInputV1["kind"];
  bytes: number;
  contentHash: string;
  contentRef: string;
  type?: "file" | "source_snapshot";
  sourceSnapshot?: NativeSourceSnapshot;
}

export async function prepareNativeRunArtifacts(input: {
  cwd: string;
  workspaceId: string;
  runAttemptId: string;
  check?: () => void;
  source?: { identity: NativeSourceIdentity; observation: NativeSourceObservation };
  timeoutMs?: number;
}) {
  const check = input.check ?? (() => {});
  const readStartedAt = new Date().toISOString();
  const files: Array<{ item: z.infer<typeof fileSchema>; body: Buffer; sourceSnapshot?: NativeSourceSnapshot }> = [];
  const deadline = performance.now() + Math.max(0, Math.min(input.timeoutMs ?? 60_000, 60_000));
  let collectionStatus: "collected" | "no_manifest" = "no_manifest";
  const read = async () => {
    try {
      check();
      z.string().uuid().parse(input.workspaceId);
      z.string().uuid().parse(input.runAttemptId);
      const cwd = await realpath(input.cwd);
      const relative = nativeRunArtifactDirectory(input.runAttemptId);
      let root = cwd;
      for (const segment of relative.split("/")) {
        root = path.join(root, segment);
        let entry;
        try { entry = await lstat(root); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(root) !== root) throw new Error("Linked output directory");
      }
      const manifestPath = path.join(root, "manifest.json");
      try { await lstat(manifestPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const manifest = manifestSchema.parse(JSON.parse((await readBoundedFile(manifestPath, 65_536, root, check)).toString("utf8")));
      let total = 0;
      for (const [ordinal, entry] of manifest.artifacts.entries()) {
        const snapshot = "type" in entry && entry.type === "source_snapshot";
        if (snapshot && input.source?.observation.schemaVersion !== 2) throw new Error("Snapshot requires a v2 source observation");
        const generated = snapshot ? await createNativeSourceSnapshot({ cwd, identity: input.source!.identity, source: input.source!.observation,
          check, timeoutMs: Math.max(0, Math.floor(deadline - performance.now())) }) : null;
        const item = "path" in entry ? { title: entry.title, kind: entry.kind, path: entry.path }
          : { title: entry.title, kind: "code_change" as const, path: `source-${ordinal}.bundle` };
        const body = generated?.body ?? await readBoundedFile(path.join(root, item.path), 32 * 1024 * 1024, root, check);
        total += body.length;
        if (total > 64 * 1024 * 1024) throw new Error("Artifact total exceeds 64 MiB");
        files.push({ item, body, ...(generated ? { sourceSnapshot: generated.sourceSnapshot } : {}) });
      }
      collectionStatus = "collected";
    } catch (error) {
      throw new NativeRunArtifactError(error);
    }
  };
  await read();
  const readFinishedAt = new Date().toISOString();
  // Buffers stay private: later source scans and uploads never reread the workspace.
  return { collectionStatus, readStartedAt, readFinishedAt, hasSourceSnapshot: files.some((file) => !!file.sourceSnapshot), async upload(storage?: Pick<StorageService, "putFile">): Promise<NativeArtifactMapping[]> {
    const artifacts: NativeArtifactMapping[] = [];
    for (const { item, body, sourceSnapshot } of files) {
      check();
      if (!storage) throw new NativeRunArtifactError(new Error("Storage unavailable"));
      const contentHash = createHash("sha256").update(body).digest("hex");
      const stored = await storage.putFile({
        companyId: input.workspaceId, namespace: "verrail/run-artifacts", originalFilename: item.path,
        contentType: "application/octet-stream", body, contentAddressed: true,
      });
      check();
      if (stored.sha256 !== contentHash || stored.byteSize !== body.length
        || stored.objectKey !== `${input.workspaceId}/verrail/run-artifacts/sha256/${contentHash}`) {
        throw new NativeRunArtifactError(new Error("Storage metadata mismatch"));
      }
      artifacts.push({ ordinal: artifacts.length, path: item.path, title: item.title, kind: item.kind, bytes: body.length, contentHash, contentRef: `storage:${stored.objectKey}`,
        ...(input.source?.observation.schemaVersion === 2 ? { type: sourceSnapshot ? "source_snapshot" as const : "file" as const } : {}),
        ...(sourceSnapshot ? { sourceSnapshot } : {}),
      });
    }
    return artifacts;
  } };
}

export async function collectNativeRunArtifacts(input: {
  cwd: string; workspaceId: string; runAttemptId: string; storage: Pick<StorageService, "putFile">;
}): Promise<RunArtifactInputV1[]> {
  const prepared = await prepareNativeRunArtifacts(input);
  return (await prepared.upload(input.storage)).map(({ title, kind, contentHash, contentRef }) => ({ title, kind, contentHash, contentRef }));
}
