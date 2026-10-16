import { createDb } from "@paperclipai/db";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRepositoryRecoveryHealth } from "./repository-recovery-health.js";
import { createVerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { readRepositoryRecoveryConfig } from "./repository-recovery-config.js";
import { runRepositoryRecoveryWorker } from "./repository-recovery-worker.js";

async function main() {
  const config = readRepositoryRecoveryConfig(process.env);
  const controller = new AbortController();
  const health = createRepositoryRecoveryHealth();
  const stop = () => { health.stop(); controller.abort(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // This process registers existing results only. It has no model credentials,
  // checkout mount, migration authority or harness execution dependency.
  const db = createDb(config.databaseUrl, { maxConnections: 1, idleTimeoutSeconds: 10, connectTimeoutSeconds: 5 });
  const server = createServer((request, response) => {
    const status = request.url === "/health" && request.method === "GET" ? (health.healthy() ? 200 : 503) : 404;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ ok: status === 200 }));
  });
  try {
    server.listen(config.healthPort, "127.0.0.1");
    await once(server, "listening");
    const domainApi = createVerrailDomainApiClient({ baseUrl: config.domainApiUrl, token: config.domainApiToken });
    if (!domainApi) throw new Error("REPOSITORY_RECOVERY_DOMAIN_UNAVAILABLE");
    await runRepositoryRecoveryWorker({ db, domainApi, workspaceIds: config.workspaceIds, signal: controller.signal,
      onCycle: health.cycle,
      onFailure: failure => process.stderr.write(`${JSON.stringify(failure)}\n`),
    });
  } finally {
    stop();
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await db.$client.end({ timeout: 5 });
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

main().catch(() => {
  process.stderr.write("Repository recovery worker failed\n");
  process.exitCode = 1;
});
