import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export async function verifyRepositoryScheduling(options: {
  databaseUrl: string; workspaceId: string; targetId: string; targetRevisionId: string;
  graphRevisionId: string; cycle: number; runId?: string;
}) {
  const root = fileURLToPath(new URL("../../../../services/domain-api/", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "verrail-scheduler-bridge-"));
  try {
    const overlay = join(directory, "overlay.json");
    await writeFile(overlay, JSON.stringify({ Replace: {
      [join(root, "internal/orchestration/repository_admission_bridge_test.go")]:
        fileURLToPath(new URL("./repository-scheduler-probe.go", import.meta.url)),
    } }));
    const { databaseUrl, runId, ...input } = options;
    await promisify(execFile)("go", ["test", "-overlay", overlay, "-count=1", "-run", "^TestRepositorySchedulingAdmissionBridge$", "./internal/orchestration"], {
      cwd: root, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(),
        VERRAIL_TEST_DATABASE_URL: databaseUrl, VERRAIL_TEST_REPOSITORY_GRAPH: JSON.stringify({ schemaVersion: 1, ...input }),
        VERRAIL_TEST_REPOSITORY_RUN: runId ?? "" },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
