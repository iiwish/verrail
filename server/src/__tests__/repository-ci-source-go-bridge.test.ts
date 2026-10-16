import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const exec = promisify(execFile);
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const suites = [
  "TestRepositoryCIAdmissionAtomicIntegration",
  "TestRepositoryCIProjectionDatabaseDenialsIntegration",
  "TestRepositoryCICannotSatisfyExistingNativeDeliveryKindsIntegration",
  "TestRepositoryCIOpenCodeDeliveryTransactionIntegration",
  "TestRepositoryRecoveryDeliveryTransactionIntegration",
];

suite("repository source Go admission (synthetic, real PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("verrail-repository-ci-proof-");
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  it.skipIf(process.env.VERRAIL_TEST_CODEX_GO_BRIDGE !== "1")("enforces source bindings, atomic proof admission and native-kind separation", async () => {
    const result = await exec("go", ["test", "-p", "1", "-json", "./internal/target", "-run", `^(${suites.join("|")})$`, "-count=1"], {
      cwd: fileURLToPath(new URL("../../../services/domain-api", import.meta.url)),
      env: { ...process.env, VERRAIL_TEST_DATABASE_URL: database!.connectionString },
      timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    const events = result.stdout.trim().split("\n").map(line => JSON.parse(line) as { Action: string; Test?: string });
    expect(events.filter(event => event.Action === "skip" || event.Action === "fail")).toEqual([]);
    for (const name of suites) expect(events.filter(event => event.Test === name && event.Action === "pass")).toHaveLength(1);
  }, 65_000);
});
