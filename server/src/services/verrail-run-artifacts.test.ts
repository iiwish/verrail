import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { collectNativeRunArtifacts } from "./verrail-run-artifacts.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";

const workspaceId = "86679997-3f3a-4477-a2fa-d4da812140ae";
const runAttemptId = "1e82be4a-a466-4c28-bee6-eb9609b68401";
describe("native Run artifact collection", () => {
  let cwd: string;
  let output: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "verrail-artifacts-"));
    output = path.join(cwd, ".verrail/run-artifacts", runAttemptId);
    await mkdir(output, { recursive: true });
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
  const manifest = (file = "review.md") => JSON.stringify({ schemaVersion: 1, artifacts: [{ title: "Review candidate", kind: "report", path: file }] });
  const collect = () => collectNativeRunArtifacts({ cwd, workspaceId, runAttemptId, storage: createStorageService(createLocalDiskStorageProvider(path.join(cwd, "storage"))) });

  it("keeps runs without an output manifest compatible", async () => {
    expect(await collect()).toEqual([]);
  });
  it("hashes actual bytes and produces the same stored references on replay", async () => {
    await writeFile(path.join(output, "review.md"), "candidate bytes");
    await writeFile(path.join(output, "manifest.json"), manifest());
    const artifacts = await collect();
    const hash = createHash("sha256").update("candidate bytes").digest("hex");
    expect(artifacts).toEqual([{ title: "Review candidate", kind: "report", contentHash: hash, contentRef: `storage:${workspaceId}/verrail/run-artifacts/sha256/${hash}` }]);
    expect(await collect()).toEqual(artifacts);
  });
  it.each(["../secret", "/etc/passwd", "sub/file", "manifest.json"])("rejects unsafe output path %s", async (file) => {
    await writeFile(path.join(output, "manifest.json"), manifest(file));
    await expect(collect()).rejects.toThrow(/NATIVE_ARTIFACT_INVALID/);
  });
  it.each(["file", "manifest", "directory", "hardlink"])("rejects linked %s", async (mode) => {
    await writeFile(path.join(cwd, "secret"), mode === "manifest" ? manifest() : "secret bytes");
    if (mode === "directory") {
      await rm(output, { recursive: true });
      await symlink(cwd, output);
    } else {
      await writeFile(path.join(output, "manifest.json"), manifest());
      if (mode === "manifest") {
        await rm(path.join(output, "manifest.json"));
        await symlink(path.join(cwd, "secret"), path.join(output, "manifest.json"));
      } else if (mode === "hardlink") {
        await link(path.join(cwd, "secret"), path.join(output, "review.md"));
      } else {
        await symlink(path.join(cwd, "secret"), path.join(output, "review.md"));
      }
    }
    await expect(collect()).rejects.toThrow(/NATIVE_ARTIFACT_INVALID/);
  });
  it("validates all files before storing any and bounds manifest bytes", async () => {
    const putFile = vi.fn();
    await writeFile(path.join(output, "review.md"), "ok");
    await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1, artifacts: [{ title: "valid", kind: "report", path: "review.md" }, { title: "missing", kind: "report", path: "missing.md" }] }));
    await expect(collectNativeRunArtifacts({ cwd, workspaceId, runAttemptId, storage: { putFile } })).rejects.toThrow(/NATIVE_ARTIFACT_INVALID/);
    expect(putFile).not.toHaveBeenCalled();
    await writeFile(path.join(output, "manifest.json"), " ".repeat(65_537));
    await expect(collect()).rejects.toThrow(/NATIVE_ARTIFACT_INVALID/);
  });
});
