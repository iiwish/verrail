import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunArtifactInputV1 } from "@paperclipai/shared";
import type { StorageService } from "../storage/types.js";

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  artifacts: z.array(z.object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(["code_change", "document", "report"]),
    path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/)
      .refine((value) => value !== "manifest.json"),
  }).strict()).min(1).max(10),
}).strict().refine((value) => new Set(value.artifacts.map((item) => item.path)).size === value.artifacts.length);

export class NativeRunArtifactError extends Error {
  constructor(cause: unknown) {
    super("NATIVE_ARTIFACT_INVALID: output collection failed", { cause });
  }
}

export function nativeRunArtifactDirectory(runAttemptId: string) {
  z.string().regex(/^[A-Za-z0-9-]{1,64}$/).parse(runAttemptId);
  return `.verrail/run-artifacts/${runAttemptId}`;
}

async function readBoundedFile(filename: string, limit: number, root: string) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit
      || await realpath(path.dirname(filename)) !== root) throw new Error("Invalid file boundary or size");
    const body = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset);
      if (!bytesRead) throw new Error("Artifact changed during collection");
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(filename);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev
      || await realpath(path.dirname(filename)) !== root) throw new Error("Artifact changed during collection");
    return body;
  } finally { await handle.close(); }
}

export async function collectNativeRunArtifacts(input: {
  cwd: string;
  workspaceId: string;
  runAttemptId: string;
  storage: Pick<StorageService, "putFile">;
}): Promise<RunArtifactInputV1[]> {
  const files: Array<{ item: z.infer<typeof manifestSchema>["artifacts"][number]; body: Buffer }> = [];
  try {
    z.string().uuid().parse(input.workspaceId);
    z.string().uuid().parse(input.runAttemptId);
    const cwd = await realpath(input.cwd);
    const relative = nativeRunArtifactDirectory(input.runAttemptId);
    let root = cwd;
    for (const segment of relative.split("/")) {
      root = path.join(root, segment);
      let entry;
      try { entry = await lstat(root); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(root) !== root) throw new Error("Linked output directory");
    }
    const manifestPath = path.join(root, "manifest.json");
    try { await lstat(manifestPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifest = manifestSchema.parse(JSON.parse((await readBoundedFile(manifestPath, 65_536, root)).toString("utf8")));
    let total = 0;
    for (const item of manifest.artifacts) {
      const body = await readBoundedFile(path.join(root, item.path), 32 * 1024 * 1024, root);
      total += body.length;
      if (total > 64 * 1024 * 1024) throw new Error("Artifact total exceeds 64 MiB");
      files.push({ item, body });
    }
  } catch (error) {
    throw new NativeRunArtifactError(error);
  }
  const artifacts: RunArtifactInputV1[] = [];
  for (const { item, body } of files) {
    const stored = await input.storage.putFile({
      companyId: input.workspaceId, namespace: "verrail/run-artifacts", originalFilename: item.path,
      contentType: "application/octet-stream", body, contentAddressed: true,
    });
    artifacts.push({ title: item.title, kind: item.kind, contentHash: stored.sha256, contentRef: `storage:${stored.objectKey}` });
  }
  return artifacts;
}
