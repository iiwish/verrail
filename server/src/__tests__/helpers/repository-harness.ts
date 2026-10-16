import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import { verrailArtifactRevisions, verrailRuns, type Db } from "@paperclipai/db";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import type { VerrailDomainApiClient } from "../../services/verrail-domain-api-client.js";
import { createStorageService } from "../../storage/service.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStartedRepositoryRunExecutor } from "../../execution/repository-run.js";
import { listPendingRepositorySuccesses, reconcileSucceededRepositoryRun } from "../../execution/repository-reconciliation.js";
import { startOfferedRepositoryAttempt } from "../../execution/repository-start.js";
import { registerRepositorySource } from "../../execution/repository-source-registration.js";

export async function verifyRepositoryHarness(options: {
  db: Db; domainApi: VerrailDomainApiClient; principalId: string;
  recovery: { databaseUrl: string; domainApiUrl: string; token: string };
  responseLost?: boolean;
  identity: Pick<RepositoryExecutionRequest, "workspaceId" | "targetId" | "targetRevisionId" | "graphRevisionId" | "workNodeId" |
    "runId" | "runAttemptId" | "leaseId" | "fencingToken" | "agentVersionId" | "deploymentRevisionId">;
}) {
  const root = await mkdtemp(join(tmpdir(), "verrail-full-repository-"));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"] }).trim();
  let modelCalls = 0;
  let recovery: ChildProcess | undefined;
  const directory = `.verrail/run-artifacts/${options.identity.runAttemptId}`;
  const manifest = JSON.stringify({ schemaVersion: 1, artifacts: [{ title: "Repository patch", kind: "code_change", path: "changes.patch" }] });
  const command = `printf 'after\\n' > hello.txt; mkdir -p ${directory}; git diff --binary > ${directory}/changes.patch; printf '%s' '${manifest}' > ${directory}/manifest.json; printf patch-ready`;
  const provider = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      modelCalls++;
      const tools = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
      expect(tools.every((name: string) => name === "repository_execute_command")).toBe(true);
      const hasResult = body.messages.some((message: { role: string }) => message.role === "tool");
      const delta = hasResult || tools.length === 0 ? { role: "assistant", content: "Repository patch complete" } : {
        role: "assistant", tool_calls: [{ index: 0, id: "repository-fixture", type: "function",
          function: { name: "repository_execute_command", arguments: JSON.stringify({ command, timeoutSeconds: 10 }) } }],
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [value, finish] of [[delta, null], [{}, hasResult || tools.length === 0 ? "stop" : "tool_calls"]]) {
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test",
          choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } catch { res.writeHead(500).end(); }
  });
  try {
    git("init", "--template=", "-b", "main");
    await writeFile(join(source, "hello.txt"), "before\n");
    git("add", "hello.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source");
    const baseCommit = git("rev-parse", "HEAD");
    git("bundle", "create", "source.bundle", "HEAD", "main");
    const storage = createStorageService(createLocalDiskStorageProvider(join(root, "objects")));
    const bundle = await readFile(join(source, "source.bundle"));
    const sourceRegistration = { storage, domainApi: options.domainApi, principalId: options.principalId,
      signal: AbortSignal.timeout(30_000), recheck: async () => {},
      source: { bundle, baseCommit, contentHash: createHash("sha256").update(bundle).digest("hex"),
        provenance: { schemaVersion: 1 as const, workspaceId: options.identity.workspaceId, targetId: options.identity.targetId,
          targetRevisionId: options.identity.targetRevisionId, graphRevisionId: options.identity.graphRevisionId,
          bindingId: randomUUID(), connectionId: randomUUID(), repository: "fixture/repository", ref: "main",
          baseCommit, authorizationContextHash: "b".repeat(64) } } };
    const registered = await registerRepositorySource(sourceRegistration);
    expect(await registerRepositorySource(sourceRegistration)).toEqual(registered);
    const launcher = join(root, "fixture-launcher");
    // Transport fixture, not the Linux sandbox launcher.
    await writeFile(launcher, '#!/bin/sh\ncd "$1" || exit 125\nshift\nexec "$@"\n', { mode: 0o700 });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const request: RepositoryExecutionRequest = { ...options.identity, schemaVersion: 1, kind: "target_repository_execution",
      source: { artifactId: registered.source.artifactId, contentHash: registered.source.contentHash, baseCommit, format: "git_bundle" },
      runtime: "opencode", model: "fixture/test", instructions: "Update hello.txt and submit a patch.", timeoutSeconds: 60,
      output: { maxFiles: 1, maxFileBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 } };
    const execute = createStartedRepositoryRunExecutor({ db: options.db, storage, domainApi: {
      ...options.domainApi,
      reportRunEvent: async input => {
        if (input.input.eventType === "succeeded") {
          if (options.responseLost) await options.domainApi.reportRunEvent(input);
          throw new Error("FIXTURE_REGISTRATION_INTERRUPTED");
        }
        return options.domainApi.reportRunEvent(input);
      },
    },
      controllerId: randomUUID(), version: "1.17.13", launcher,
      providers: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture",
        options: { baseURL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, apiKey: "fixture-only" },
        models: { test: { name: "Test", limit: { context: 32000, output: 1000 } } } } },
    });
    const signal = AbortSignal.timeout(60_000);
    const cursor = await startOfferedRepositoryAttempt({ db: options.db, domainApi: options.domainApi,
      request, lastEventCursor: 0, signal });
    expect(cursor).toBe(2);
    await expect(execute(request, cursor, signal)).rejects.toThrow("FIXTURE_REGISTRATION_INTERRUPTED");
    const callsBeforeRecovery = modelCalls;
    const [pending] = await options.db.select().from(verrailRuns).where(eq(verrailRuns.id, request.runId));
    if (options.responseLost) {
      expect(pending.status).toBe("succeeded");
      expect(await listPendingRepositorySuccesses({ db: options.db, workspaceId: request.workspaceId, signal })).toEqual([]);
      const noReplayApi = { reportRunEvent: async () => { throw new Error("RECOVERY_MUST_NOT_RESEND_ACCEPTED_SUCCESS"); } };
      expect(await reconcileSucceededRepositoryRun({ db: options.db, domainApi: noReplayApi,
        workspaceId: request.workspaceId, runAttemptId: request.runAttemptId, signal })).toEqual({ status: "registered" });
    } else {
      expect(pending.status).toBe("running");
      expect(await options.db.select().from(verrailArtifactRevisions).where(eq(verrailArtifactRevisions.sourceRunId, request.runId))).toHaveLength(0);
      recovery = spawn(process.execPath, ["--import", "./server/node_modules/tsx/dist/loader.mjs",
        "server/src/execution/repository-recovery-main.ts"], {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)), stdio: "ignore", env: {
          PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: options.recovery.databaseUrl,
          VERRAIL_DOMAIN_API_URL: options.recovery.domainApiUrl, VERRAIL_DOMAIN_API_TOKEN: options.recovery.token,
          VERRAIL_REPOSITORY_WORKSPACE_IDS: JSON.stringify([request.workspaceId]),
          VERRAIL_REPOSITORY_RECOVERY_HEALTH_PORT: "0",
        },
      });
      await vi.waitFor(async () => {
        const [run] = await options.db.select().from(verrailRuns).where(eq(verrailRuns.id, request.runId));
        expect(run.status).toBe("succeeded");
      }, { timeout: 10_000 });
      const stopped = once(recovery, "exit");
      recovery.kill("SIGTERM");
      expect(await stopped).toEqual([0, null]);
    }
    expect(modelCalls).toBe(callsBeforeRecovery);
    expect(await readFile(join(source, "hello.txt"), "utf8")).toBe("before\n");
    const revisions = await options.db.select().from(verrailArtifactRevisions).where(eq(verrailArtifactRevisions.sourceRunId, request.runId));
    expect(revisions).toHaveLength(1);
    const object = await storage.getObject(request.workspaceId, revisions[0].contentRef.slice("storage:".length));
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
    const patch = Buffer.concat(chunks).toString();
    expect(patch).toContain("-before");
    expect(patch).toContain("+after");
    const [run] = await options.db.select().from(verrailRuns).where(eq(verrailRuns.id, request.runId));
    expect(run.status).toBe("succeeded");
    const calls = modelCalls;
    expect(await reconcileSucceededRepositoryRun({ db: options.db, domainApi: options.domainApi,
      workspaceId: request.workspaceId, runAttemptId: request.runAttemptId, signal })).toEqual({ status: "registered" });
    expect(modelCalls).toBe(calls);
  } finally {
    if (recovery && recovery.exitCode === null && recovery.signalCode === null) {
      const exited = once(recovery, "exit");
      recovery.kill("SIGKILL");
      await exited;
    }
    provider.closeAllConnections();
    if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
