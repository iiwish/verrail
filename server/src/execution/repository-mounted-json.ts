import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function readMountedJson(path: string | undefined, maxBytes: number) {
  if (!path || !isAbsolute(path)) throw new Error("REPOSITORY_MOUNT_REQUIRED");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("REPOSITORY_MOUNT_LIMIT_INVALID");
  // Nonblocking open allows rejecting a FIFO without waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o022) !== 0) throw new Error("REPOSITORY_MOUNT_INVALID");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("REPOSITORY_MOUNT_TOO_LARGE");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { await file.close(); }
}
