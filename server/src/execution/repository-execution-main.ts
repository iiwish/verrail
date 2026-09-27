import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, verrailRunAttempts } from "@paperclipai/db";
import { readRepositoryRecoveryConfig } from "./repository-recovery-config.js";
import { createRepositoryLeaseValidator } from "./repository-lease.js";
import { createStartedRepositoryRunExecutor } from "./repository-run.js";
import { createVerrailDomainApiClient } from "../services/verrail-domain-api-client.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { readMountedJson } from "./repository-mounted-json.js";
import { startOfferedRepositoryAttempt } from "./repository-start.js";
import { buildOfferedRepositoryRequest, repositoryAttemptIdentitySchema } from "./repository-request-builder.js";
import { runRepositoryDispatchWorker } from "./repository-dispatch-worker.js";
import { createRepositoryDispatchHealth } from "./repository-dispatch-health.js";
import { assertRepositoryScratch } from "./repository-scratch.js";
import { createRepositoryContainerCommand, createRepositoryContainerTransport, repositoryContainerConfigSchema } from "./repository-container-command.js";

async function main() {
  if (process.platform !== "linux") throw new Error("REPOSITORY_LINUX_REQUIRED");
  const config = readRepositoryRecoveryConfig(process.env);
  const identity = process.env.VERRAIL_REPOSITORY_REQUEST_FILE
    ? repositoryAttemptIdentitySchema.parse(await readMountedJson(process.env.VERRAIL_REPOSITORY_REQUEST_FILE, 65536)) : null;
  if (identity && !config.workspaceIds.includes(identity.workspaceId)) throw new Error("REPOSITORY_WORKSPACE_NOT_ADMITTED");
  const providers = z.record(z.string().min(1), z.record(z.string(), z.unknown())).parse(
    await readMountedJson(process.env.VERRAIL_REPOSITORY_PROVIDERS_FILE, 65536));
  if (!Object.keys(providers).length) throw new Error("REPOSITORY_PROVIDERS_REQUIRED");
  const version = z.string().regex(/^\d+\.\d+\.\d+$/).parse(process.env.OPENCODE_VERSION);
  const storageRoot = z.string().refine(isAbsolute).parse(process.env.VERRAIL_REPOSITORY_STORAGE_ROOT);
  const checkoutRoot = z.string().refine(isAbsolute).parse(process.env.VERRAIL_REPOSITORY_CHECKOUT_ROOT);
  await assertRepositoryScratch(checkoutRoot);
  const containerConfig = repositoryContainerConfigSchema.parse(
    await readMountedJson(process.env.VERRAIL_REPOSITORY_CONTAINER_CONFIG_FILE, 65536));
  const runCommand = createRepositoryContainerCommand({ checkoutRoot,
    transport: createRepositoryContainerTransport(containerConfig) });
  const controller = new AbortController();
  const health = createRepositoryDispatchHealth();
  const stop = () => { health.stop(); controller.abort(); };
  const healthPort = z.coerce.number().int().min(0).max(65535).parse(process.env.VERRAIL_REPOSITORY_HEALTH_PORT ?? "3214");
  const server = createServer((request, response) => {
    const status = request.url === "/health" && request.method === "GET" ? (health.healthy() ? 200 : 503) : 404;
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ ok: status === 200 }));
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const db = createDb(config.databaseUrl, { maxConnections: 1, idleTimeoutSeconds: 10, connectTimeoutSeconds: 5 });
  try {
    if (!identity) { server.listen(healthPort, "127.0.0.1"); await once(server, "listening"); }
    const domainApi = createVerrailDomainApiClient({ baseUrl: config.domainApiUrl, token: config.domainApiToken });
    if (!domainApi) throw new Error("REPOSITORY_DOMAIN_REQUIRED");
    const storage = createStorageService(createLocalDiskStorageProvider(storageRoot));
    const execute = createStartedRepositoryRunExecutor({ db, domainApi, controllerId: randomUUID(), version,
      runCommand, checkoutRoot, providers, storage, onAuthority: health.authority });
    if (!identity) {
      await runRepositoryDispatchWorker({ db, domainApi, storage, execute, workspaceIds: config.workspaceIds,
        signal: controller.signal, onActive: health.active, onCycle: health.cycle,
        onFailure: failure => process.stderr.write(`${JSON.stringify(failure)}\n`) });
      return;
    }
    const request = await buildOfferedRepositoryRequest({ db, storage, identity, signal: controller.signal,
      timeoutSeconds: 900, output: { maxFiles: 10, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 } });
    const [attempt] = await db.select({ cursor: verrailRunAttempts.lastEventCursor }).from(verrailRunAttempts)
      .where(and(eq(verrailRunAttempts.id, identity.runAttemptId), eq(verrailRunAttempts.runId, identity.runId),
        eq(verrailRunAttempts.workspaceId, identity.workspaceId))).limit(1);
    if (!attempt) throw new Error("REPOSITORY_ATTEMPT_NOT_FOUND");
    const cursor = await startOfferedRepositoryAttempt({ db, domainApi, request, lastEventCursor: attempt.cursor, signal: controller.signal });
    await createRepositoryLeaseValidator(db)(request, controller.signal);
    const result = await execute(request, cursor, controller.signal);
    process.stdout.write(`${JSON.stringify({ status: result.status, runAttemptId: request.runAttemptId })}\n`);
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
  process.stderr.write("Repository execution failed\n");
  process.exitCode = 1;
});
