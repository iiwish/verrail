import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { buildDeliveryProofRuntime } from "../../services/delivery-proof-reader-build.js";
import { deliveryObservationHash } from "../../services/delivery-proof-observation.js";
import type { DeliveryProofRecorderConfig } from "../../services/delivery-proof-recorder.js";
import { type Db, verrailConversations, verrailConversationMessages, verrailProviderConversationBindings,
  verrailTargetCreationDrafts, verrailTargetCreationDraftRevisions, verrailTargets, verrailTargetRevisions,
  verrailCommandReceipts, verrailAuditEvents, verrailChannelEvents, verrailChannelTargetReplies } from "@paperclipai/db";
import { loadChannelTargetProofContext } from "../../services/channel-target-proof-context.js";
import { runtimeObservationFailureCode } from "../../services/verrail-runtime-observation.js";

const exec = promisify(execFile);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const repo = path.resolve(import.meta.dirname, "../../../..");
const workflowPath = ".github/workflows/verrail-candidate-verify.yml", helperPath = ".github/scripts/verrail-candidate-proof.mjs";
const checks = ["ts_tests", "ts_typecheck", "ts_build", "go_tests"];
const steps = ["checkout", "source_identity", "setup_pnpm", "setup_node", "setup_go", "install", "proof_tests", ...checks, "source_unchanged"];

export function deliveryRuntimeDiagnosticCodes(output: string) {
  return [...output.matchAll(/^DELIVERY_RUNTIME_CHECKPOINT_FAILED:([^\r\n]*)$/gm)].slice(-4)
    .map(match => runtimeObservationFailureCode(new Error("checkpoint", { cause: match[1] })));
}

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Synthetic processes, real observer transports, real API auth and real Go admission. */
export async function deliveryRuntimeFixture(databaseUrl: string, scope: {
  workspaceId: string; targetId: string; targetRevisionId: string; graphRevisionId: string;
}, executionIdentity: { agentId: string; heartbeatRunId: string }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "verrail-delivery-fixture-"));
  await chmod(directory, 0o700);
  const sessionId = randomUUID(), pluginId = randomUUID(), candidateCommit = "c".repeat(40);
  const connectionId = randomUUID(), bindingId = randomUUID();
  const processes: ChildProcess[] = [];
  const output = new Map<string, string>();
  const apiPort = await freePort();
  let domainPort = await freePort();
  while (domainPort === apiPort) domainPort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`, domainOrigin = `http://127.0.0.1:${domainPort}`;
  const key = generateKeyPairSync("ed25519"), privateKey = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const entry = { ...scope, connectionId, bindingId, authorizedUserIds: ["test"], policy: {
    repository: "test/repo", repositoryId: 1, workflowId: 2,
    workflow: { path: workflowPath, sha: candidateCommit, sha256: hash("trusted workflow") },
    helper: { path: helperPath, sha256: hash("trusted helper") },
    requiredJobs: [{ name: "candidate_verify", steps: [...steps, "capture_results"] },
      { name: "candidate_report", steps: ["checkout", "setup_node", "report", "upload"] }],
    artifactDownloadHosts: ["artifacts.githubusercontent.com"], maxAgeMs: 300_000,
    timeoutMs: 15_000, maxPages: 3, maxResponseBytes: 100_000, maxArchiveBytes: 100_000, maxReportBytes: 50_000,
  } };
  const close = async () => {
    for (const child of processes) child.kill("SIGTERM");
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const executable = await import("node:fs/promises").then(fs => fs.realpath(process.execPath));
    const executableSha256 = hash(await readFile(executable));
    const proxy = path.join(directory, "observer.mjs"), native = path.join(directory, "domain-api");
    await mkdir(path.join(directory, "app"));
    await writeFile(path.join(directory, "package.json"), await readFile(path.join(repo, "server/package.json")));
    await buildDeliveryProofRuntime(proxy);
    await exec("go", ["build", "-o", native, "./cmd/domain-api"], { cwd: path.join(repo, "services/domain-api"), timeout: 60_000 });
    const harness = path.join(directory, "harness");
    await writeFile(path.join(directory, "harness.go"), 'package main\nimport ("io"; "os")\nfunc main() { if _, err := io.Copy(io.Discard, os.Stdin); err != nil { os.Exit(1) } }\n');
    await exec("go", ["build", "-o", harness, path.join(directory, "harness.go")], { timeout: 60_000 });
    // Preserve production authentication and Board authorization; omit presentation and logging.
    await build({ stdin: { contents: `import express from 'express';
import { createDb } from '@paperclipai/db';
import { actorMiddleware } from './src/middleware/auth.ts';
import { errorHandler } from './src/middleware/error-handler.ts';
import { assertBoard } from './src/routes/authz.ts';
const db = createDb(process.env.DATABASE_URL); const app = express();
app.use(actorMiddleware(db, { deploymentMode: 'authenticated', resolveSession: async () => null }));
app.get('/api/agents/me', (req, res) => { if (req.actor.type !== 'agent') return res.sendStatus(401);
res.json({ id: req.actor.agentId, companyId: req.actor.companyId }); });
app.get('/api/workspaces/:workspaceId/delivery-context/codex', (req, res) => { assertBoard(req); res.json({}); });
app.use(errorHandler);
app.listen(Number(process.env.PORT), '127.0.0.1');
// Debugger.pause stops at the next JavaScript statement, not while libuv is idle.
// This fixture-owned tick is part of the hashed source, not inspector-injected code.
setInterval(() => {}, 100).unref();`, resolveDir: path.join(repo, "server"), loader: "ts" },
      outfile: path.join(directory, "app/server.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
      banner: { js: "import { createRequire as __fixtureRequire } from 'node:module'; const require = __fixtureRequire(import.meta.url); globalThis.__zod_globalConfig = { jitless: true };" },
      plugins: [{ name: "fixture-db", setup(builder) {
        builder.onResolve({ filter: /\/logger\.[jt]s$/ }, args => path.resolve(args.resolveDir, args.path) === path.join(repo, "server/src/middleware/logger.js")
          ? { path: "logger", namespace: "fixture-logger" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "fixture-logger" }, () => ({ loader: "js",
          contents: "export const logger = { info(){}, warn(){}, error(){}, debug(){} };" }));
        builder.onResolve({ filter: /^@paperclipai\/db$/ }, () => ({ path: "db", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "ts", resolveDir: repo,
          contents: `export { createDb } from '${repo}/packages/db/src/client.ts'; export * from '${repo}/packages/db/src/schema/index.ts';` }));
      } }],
    });
    await writeFile(path.join(directory, "worker.mjs"), "setInterval(() => {}, 1000); process.on('message', value => process.send?.(value));\n");
    const observerHash = hash(await readFile(proxy));
    const runtimeConfigs = ["server", "domain", "plugin", "harness"].map(component => {
      const env = { PATH: process.env.PATH!, VERRAIL_RUNTIME_SESSION_ID: sessionId };
      if (component === "domain" || component === "harness") return { component: component as "domain" | "harness", engine: "native" as const, config: {
        schemaVersion: 1 as const, root: directory, candidateCommit, executable: component === "domain" ? native : harness, executableSha256: "",
        args: [], env: component === "domain" ? { ...env, DATABASE_URL: databaseUrl, VERRAIL_DOMAIN_API_TOKEN: "fixture-domain-token",
          VERRAIL_DOMAIN_API_LISTEN: `127.0.0.1:${domainPort}`, VERRAIL_DELIVERY_PROOF_TRUST_FILE: path.join(directory, "trust.json") }
          : { ...env, PAPERCLIP_COMPANY_ID: scope.workspaceId, PAPERCLIP_AGENT_ID: executionIdentity.agentId, PAPERCLIP_RUN_ID: executionIdentity.heartbeatRunId } } };
      return { component: component as "server" | "plugin", engine: "node" as const, config: {
        schemaVersion: 1 as const, root: directory, candidateCommit, executable, executableSha256,
        entrypoint: component === "server" ? "app/server.mjs" : "worker.mjs", files: [] as Array<{ path: string; sha256: string }>,
        env: component === "server" ? { ...env, DATABASE_URL: databaseUrl, PORT: String(apiPort),
          PAPERCLIP_INSTANCE_ID: process.env.PAPERCLIP_INSTANCE_ID ?? "default",
          PAPERCLIP_AGENT_JWT_SECRET: "synthetic-native-permission-secret", NODE_ENV: "production" } : env } };
    });
    for (const item of runtimeConfigs) {
      if (item.engine === "native") item.config.executableSha256 = hash(await readFile(item.config.executable));
      else item.config.files = [{ path: item.config.entrypoint, sha256: hash(await readFile(path.join(directory, item.config.entrypoint))) }];
      if (item.engine === "node" && item.component === "server") item.config.files.push({ path: "package.json", sha256: hash(await readFile(path.join(directory, "package.json"))) });
    }
    const manifest = { schemaVersion: 1 as const, candidateCommit, apiOriginSha256: hash(apiOrigin), domainOriginSha256: hash(domainOrigin), pluginId,
      components: runtimeConfigs.map(item => ({ component: item.component,
        configurationSha256: deliveryObservationHash({ engine: item.engine, config: item.config }), verifierBuildSha256: observerHash })) };
    const manifestSha256 = deliveryObservationHash(manifest);
    const trust: DeliveryProofRecorderConfig["trust"] = { schemaVersion: 1,
      ci: { schemaVersion: 1, ...scope, connectionId, bindingId, policySha256: hash(JSON.stringify(entry)),
        repository: entry.policy.repository, repositoryId: 1, workflowId: 2, workflowExecutionSha: candidateCommit,
        workflowSha256: entry.policy.workflow.sha256, helperSha256: entry.policy.helper.sha256, maxAgeMs: entry.policy.maxAgeMs },
      publicKey: key.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
      readerPolicySha256: "a".repeat(64), verifierBuildSha256: "b".repeat(64), runtimeManifestSha256: manifestSha256, maxAgeMs: 300_000 };
    // The reader policy is deterministic for a scope and is set before startup by the caller.
    const start = async (readerPolicySha256: string) => {
      trust.readerPolicySha256 = readerPolicySha256;
      await writeFile(path.join(directory, "trust.json"), JSON.stringify(trust), { mode: 0o600 });
      for (const item of runtimeConfigs) {
        const configPath = path.join(directory, `${item.component}.json`);
        await writeFile(configPath, JSON.stringify({ schemaVersion: 1, component: item.component, sessionId, manifestSha256,
          verifierBuildSha256: observerHash, directory, privateKey, [item.engine]: item.config }), { mode: 0o600 });
        const child = spawn(executable, [proxy, ...(item.component === "plugin" ? [path.join(directory, "worker.mjs")] : [])], {
          env: { PATH: process.env.PATH, VERRAIL_RUNTIME_OBSERVER_CONFIG: configPath }, stdio: ["pipe", "pipe", "pipe"] });
        processes.push(child); let errors = "", tail = Buffer.alloc(0);
        const capture = (chunk: Buffer) => {
          tail = Buffer.concat([tail, chunk]).subarray(-8192);
          errors = tail.toString("utf8"); output.set(item.component, errors);
        };
        child.stdout?.on("data", capture); child.stderr?.on("data", capture);
        const deadline = Date.now() + 20_000;
        while (true) {
          if (child.exitCode !== null) throw new Error(`fixture ${item.component} exited: ${errors}`);
          try { await readFile(path.join(directory, `${sessionId}-${item.component}.ready.json`)); break; } catch {}
          if (Date.now() > deadline) throw new Error(`fixture ${item.component} not ready: ${errors}`);
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      const deadline = Date.now() + 20_000;
      let readiness = "not connected";
      while (true) {
        try { const response = await fetch(`${apiOrigin}/api/agents/me`, { signal: AbortSignal.timeout(1000) });
          readiness = `${response.status} ${await response.text()}`; if (response.status === 401) break;
        } catch (error) { readiness = String(error); }
        if (Date.now() > deadline) {
          throw new Error(`Fixture API did not become ready: ${readiness}; ${output.get("server")}`);
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const finishHarness = async () => {
      processes[3]!.stdin!.end();
      const deadline = Date.now() + 10_000;
      while (true) {
        try { await readFile(path.join(directory, `${sessionId}-harness.witness.json`)); break; } catch {}
        if (Date.now() > deadline) throw new Error(`Fixture harness did not finish: ${output.get("harness")}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const diagnostics = () => runtimeConfigs.map((item, index) => ({
      component: item.component, exitCode: processes[index]?.exitCode ?? null, signalCode: processes[index]?.signalCode ?? null,
      checkpointFailures: deliveryRuntimeDiagnosticCodes(output.get(item.component) ?? ""),
    }));
    return { directory, sessionId, pluginId, apiOrigin, domainOrigin, entry, trust, start, close, finishHarness, diagnostics,
      config: { trust, privateKey, domainOrigin, githubPolicy: JSON.stringify([entry]), githubAuthorization: "Bearer synthetic-github",
        runtime: { directory, publicKey, sessionId, manifest, manifestSha256 } } as DeliveryProofRecorderConfig };
  } catch (error) { await close(); throw error; }
}

export async function githubDeliveryFixture(runtime: Awaited<ReturnType<typeof deliveryRuntimeFixture>>, sourceDir: string) {
  const { policy } = runtime.entry, sha = policy.workflow.sha, time = new Date().toISOString();
  const report = { schemaVersion: 1, kind: "verrail.fixed-ci", repository: policy.repository,
    candidate: { sha, ref: "refs/heads/codex/g2-7-candidate-test" },
    workflow: { path: workflowPath, sha, ref: `test/repo/${workflowPath}@refs/heads/codex/g2-7-candidate-test`, sha256: policy.workflow.sha256 },
    helper: policy.helper, run: { id: "123", attempt: 1 },
    jobs: [{ id: "candidate_verify", result: "success", steps: steps.map(id => ({ id, outcome: "success", conclusion: "success" })) }],
    checks: checks.map(id => ({ id, status: "passed" })),
    unsupportedObligations: ["live_feishu", "live_codex", "live_recovery", "secret_non_persistence", "human_governance", "pr_effect"] };
  await writeFile(path.join(runtime.directory, "verrail-fixed-ci.json"), JSON.stringify(report));
  await exec("zip", ["-q", "report.zip", "verrail-fixed-ci.json"], { cwd: runtime.directory });
  const archive = await readFile(path.join(runtime.directory, "report.zip"));
  const tree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: sourceDir })).stdout.trim();
  const entries = (await exec("git", ["ls-tree", "-z", "HEAD"], { cwd: sourceDir })).stdout.split("\0").filter(Boolean).map(line => {
    const [metadata, name] = line.split("\t"), [mode, type, sha] = metadata!.split(" "); return { path: name, mode, type, sha };
  });
  return async (url: string | URL | Request) => {
    const name = String(url);
    if (name.startsWith("https://artifacts.githubusercontent.com/")) return new Response(archive);
    if (!name.startsWith("https://api.github.com/repos/test/repo/")) throw new Error(`Unexpected fixture request: ${name}`);
    if (name.includes("/contents/")) return Response.json({ encoding: "base64", content: Buffer.from(name.includes("workflows") ? "trusted workflow" : "trusted helper").toString("base64") });
    if (name.includes("/git/commits/")) return Response.json({ sha, tree: { sha: tree } });
    if (name.includes("/git/trees/")) return Response.json({ sha: tree, truncated: false, tree: entries });
    if (name.includes("/jobs?")) return Response.json({ total_count: 2, jobs: policy.requiredJobs.map((job, index) => ({
      id: index + 1, run_id: 123, run_attempt: 1, head_sha: sha, name: job.name, status: "completed", conclusion: "success", completed_at: time,
      steps: job.steps.map((name, index) => ({ name, number: index + 1, status: "completed", conclusion: "success" })) })) });
    if (name.includes("/artifacts?")) return Response.json({ total_count: 1, artifacts: [{ id: 456, name: "verrail-fixed-ci-123-1", expired: false,
      size_in_bytes: archive.length, digest: `sha256:${hash(archive)}`, expires_at: new Date(Date.now() + 60_000).toISOString(),
      workflow_run: { id: 123, head_sha: sha, repository_id: 1, head_repository_id: 1 } }] });
    if (name.endsWith("/456/zip")) return new Response(null, { status: 302, headers: { location: "https://artifacts.githubusercontent.com/fixture" } });
    return Response.json({ id: 123, run_attempt: 1, repository: { id: 1, full_name: policy.repository }, head_repository: { id: 1, full_name: policy.repository },
      workflow_id: 2, path: workflowPath, head_sha: sha, head_branch: "codex/g2-7-candidate-test", event: "push", status: "completed", conclusion: "success", created_at: time, updated_at: time });
  };
}

export async function channelDeliveryFixture(db: Db, workspaceId: string, runtime: { sessionId: string; pluginId: string }) {
  const channelEventId = randomUUID(), conversationId = randomUUID(), messageId = randomUUID(), draftId = randomUUID();
  const draftRevisionId = randomUUID(), createdTargetId = randomUUID(), createdTargetRevisionId = randomUUID();
  const workGraphId = randomUUID(), graphRevisionId = randomUUID(), time = new Date(), contentHash = "a".repeat(64);
  const author = { createdByPrincipalType: "user", createdByPrincipalId: "test" };
  const definition = { collectionId: null, title: "Synthetic delivery", summary: null, goal: "Synthetic goal",
    outcomeOwner: { principalType: "user" as const, principalId: "test" }, constraints: [],
    acceptanceCriteria: [{ title: "Synthetic criterion", description: null }], riskLevel: "low" as const, deadline: null, policySummary: null, resourceRefs: [] };
  const key = `target-draft:${draftId}:v1`, body = "Synthetic explicit target request";
  await db.insert(verrailConversations).values({ id: conversationId, workspaceId, ...author });
  await db.insert(verrailConversationMessages).values({ id: messageId, workspaceId, conversationId, role: "user", status: "complete",
    body, authorPrincipalType: "user", authorPrincipalId: "test", metadata: { channelConnector: "feishu",
      providerEventId: "fixture-event", providerMessageId: "fixture-message", runtimeSessionId: runtime.sessionId } });
  await db.insert(verrailProviderConversationBindings).values({ workspaceId, conversationId, providerKey: "feishu", connectionId: "fixture-connection",
    externalConversationType: "group", externalConversationId: "fixture-chat", ...author });
  await db.insert(verrailTargetCreationDrafts).values({ id: draftId, workspaceId, conversationId, sourceMessageId: messageId,
    initiatedByPrincipalType: "user", initiatedByPrincipalId: "test", status: "converted", activeRevisionId: draftRevisionId,
    activeRevisionNumber: 1, confirmedByPrincipalType: "user", confirmedByPrincipalId: "test", confirmedAt: time,
    conversionIdempotencyKey: key, convertedTargetId: createdTargetId, convertedTargetRevisionId: createdTargetRevisionId });
  await db.insert(verrailTargetCreationDraftRevisions).values({ id: draftRevisionId, workspaceId, draftId, revisionNumber: 1,
    definition, missingFields: [], contentHash, ...author });
  await db.insert(verrailTargets).values({ id: createdTargetId, workspaceId, activeTargetRevisionId: createdTargetRevisionId, createdAt: time, ...author });
  await db.insert(verrailTargetRevisions).values({ id: createdTargetRevisionId, workspaceId, targetId: createdTargetId, revisionNumber: 1,
    title: definition.title, goal: definition.goal, outcomeOwnerPrincipalType: "user", outcomeOwnerPrincipalId: "test", constraints: [],
    acceptanceCriteria: [{ id: randomUUID(), title: "Synthetic criterion", description: null }], riskLevel: "low", resourceRefs: [], contentHash, createdAt: time, ...author });
  await db.insert(verrailCommandReceipts).values({ id: randomUUID(), workspaceId, principalType: "user", principalId: "test", commandType: "target.create.v1",
    idempotencyKey: key, requestHash: contentHash, targetId: createdTargetId, targetRevisionId: createdTargetRevisionId, createdAt: time,
    response: { schemaVersion: 1, targetId: createdTargetId, targetRevisionId: createdTargetRevisionId, workGraphId, graphRevisionId,
      workbenchHref: `/targets/${createdTargetId}/overview`, replayed: false } });
  await db.insert(verrailAuditEvents).values({ id: randomUUID(), workspaceId, principalType: "user", principalId: "test", eventType: "target.created",
    aggregateType: "target", aggregateId: createdTargetId, idempotencyKey: key, occurredAt: time,
    payload: { schemaVersion: 1, targetId: createdTargetId, targetRevisionId: createdTargetRevisionId, workGraphId, graphRevisionId, requestHash: contentHash } });
  await db.insert(verrailChannelEvents).values({ id: channelEventId, workspaceId, connectorKey: "feishu", connectionId: "fixture-connection",
    providerEventId: "fixture-event", providerUserId: "fixture-user", externalConversationType: "group", externalConversationId: "fixture-chat",
    conversationId, messageId, draftId, receivedAt: time });
  const input = { channelEventId, draftRevisionId, createdTargetId, createdTargetRevisionId };
  const context = await loadChannelTargetProofContext(db, { ...input, workspaceId });
  const replyText = `Verrail: Target created.\nhttps://verrail.example/targets/${createdTargetId}/overview\nTargetRevision: ${createdTargetRevisionId}`;
  await db.insert(verrailChannelTargetReplies).values({ workspaceId, draftId, draftRevisionId, channelEventId,
    targetId: createdTargetId, targetRevisionId: createdTargetRevisionId, pluginId: runtime.pluginId, confirmedByPrincipalId: "test",
    configurationSha256: contentHash, contextSha256: context.contextSha256, bodySha256: hash(replyText), idempotencyKey: `vtc:${draftId}`,
    status: "succeeded", providerMessageId: "fixture-reply", startedAt: time, completedAt: time });
  const inbound = { message_id: "fixture-message", msg_type: "text", deleted: false, updated: false, chat_id: "fixture-chat",
    create_time: String(time.getTime()), sender: { id: "fixture-user", id_type: "open_id", sender_type: "user" }, body: { content: JSON.stringify({ text: body }) } };
  const reply = { ...inbound, message_id: "fixture-reply", parent_id: "fixture-message",
    sender: { id: "fixture-app", id_type: "app_id", sender_type: "app" }, body: { content: JSON.stringify({ text: replyText }) } };
  return { input, config: { schemaVersion: 1 as const, workspaceId, connectionId: "fixture-connection", appId: "fixture-app",
    appSecret: "synthetic-secret", publicBaseUrl: "https://verrail.example", authorizedUsers: [{ providerUserId: "fixture-user", userId: "test" }] },
    fetch: async (url: string | URL | Request) => Response.json(String(url).includes("tenant_access_token") ? { code: 0, tenant_access_token: "synthetic-token" }
      : { code: 0, data: { items: [String(url).endsWith("fixture-message") ? inbound : reply] } }) };
}
