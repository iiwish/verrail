import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { StorageService } from "../storage/types.js";

const limits = { "run-artifacts": 32 * 1024 * 1024, "repository-execution-observations": 64 * 1024,
  "repository-execution-logs": 2 * 1024 * 1024 } as const;
const unavailable = () => new Error("PROOF_STORAGE_READ_UNAVAILABLE");

/** A reader capability, not a product storage service: no writes or arbitrary keys. */
export function createDeliveryProofStorageReader(root: string, workspaceId: string): Pick<StorageService, "getObject"> {
  z.string().uuid().parse(workspaceId);
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw unavailable();
  return { async getObject(companyId, objectKey, options) {
    if (companyId !== workspaceId || options?.range) throw unavailable();
    const match = /^([a-f0-9-]+)\/verrail\/(run-artifacts|repository-execution-observations|repository-execution-logs)\/sha256\/([a-f0-9]{64})$/.exec(objectKey);
    if (!match || match[1] !== workspaceId) throw unavailable();
    const maximum = limits[match[2] as keyof typeof limits];
    const filename = path.join(root, objectKey);
    const segments = filename.slice(path.parse(filename).root.length).split(path.sep);
    const parents: { name: string; dev: number; ino: number }[] = [];
    let current = path.parse(filename).root;
    for (const part of segments.slice(0, -1)) {
      current = path.join(current, part);
      const value = await lstat(current);
      if (!value.isDirectory() || value.isSymbolicLink()) throw unavailable();
      parents.push({ name: current, dev: value.dev, ino: value.ino });
    }
    if (await realpath(root) !== root) throw unavailable();
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw unavailable();
      const body = Buffer.alloc(before.size);
      let size = 0;
      while (size < body.length) {
        const read = await handle.read(body, size, body.length - size, size);
        if (!read.bytesRead) throw unavailable();
        size += read.bytesRead;
      }
      const after = await handle.stat(), named = await lstat(filename);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || after.nlink !== 1 || !named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino
        || createHash("sha256").update(body).digest("hex") !== match[3]) throw unavailable();
      for (const parent of parents) {
        const value = await lstat(parent.name);
        if (!value.isDirectory() || value.isSymbolicLink() || value.dev !== parent.dev || value.ino !== parent.ino) throw unavailable();
      }
      return { stream: Readable.from([body]), contentLength: body.length, lastModified: after.mtime };
    } finally { await handle.close(); }
  } };
}

export async function readExecutionProofObject(storage: Pick<StorageService, "getObject">, workspaceId: string,
  reference: { contentHash: string; contentRef: string; bytes: number }, namespace: "repository-execution-observations" | "repository-execution-logs") {
  const key = `${workspaceId}/verrail/${namespace}/sha256/${reference.contentHash}`;
  if (!/^[a-f0-9]{64}$/.test(reference.contentHash) || reference.contentRef !== `storage:${key}`
    || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > limits[namespace]) throw unavailable();
  const signal = AbortSignal.timeout(15_000);
  const pending = storage.getObject(workspaceId, key);
  const object = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
    const abort = () => reject(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    pending.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { value.stream.destroy(); return; }
      resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
  const abort = () => object.stream.destroy(unavailable());
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    if (object.contentLength !== undefined && object.contentLength !== reference.bytes) throw unavailable();
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of object.stream) {
      signal.throwIfAborted(); const value = Buffer.from(chunk); length += value.length;
      if (length > reference.bytes) throw unavailable();
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    if (body.length !== reference.bytes || createHash("sha256").update(body).digest("hex") !== reference.contentHash) throw unavailable();
    return body;
  } finally { signal.removeEventListener("abort", abort); object.stream.destroy(); }
}
