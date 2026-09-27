import assert from "node:assert/strict";
import { open, rm, symlink } from "node:fs/promises";
import { assertRepositoryScratch } from "../../../server/src/execution/repository-scratch.js";

await assertRepositoryScratch("/scratch");
await assert.rejects(assertRepositoryScratch("/tmp"));
await assert.rejects(assertRepositoryScratch("/"));
await assert.rejects(assertRepositoryScratch("/oversized"));
await symlink("/scratch", "/scratch/link");
await assert.rejects(assertRepositoryScratch("/scratch/link"));
const file = await open("/scratch/fill", "w");
let bytes = 0;
try {
  await assert.rejects(async () => {
    const chunk = Buffer.alloc(1024 * 1024, 1);
    while (bytes < 32 * 1024 * 1024) {
      const result = await file.write(chunk);
      bytes += result.bytesWritten;
    }
  }, { code: "ENOSPC" });
  assert.ok(bytes <= 16 * 1024 * 1024);
} finally {
  await file.close();
  await rm("/scratch/fill");
  await rm("/scratch/link");
}
process.stdout.write("REPOSITORY_SCRATCH_PASS\n");
