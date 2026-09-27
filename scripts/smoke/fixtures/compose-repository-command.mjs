// Runs through stdin inside the disposable Compose control-plane container.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "/app/packages/db/dist/index.js";
import { createVerrailDomainApiClient } from "/app/server/dist/services/verrail-domain-api-client.js";
import { registerRepositorySource } from "/app/server/dist/execution/repository-source-registration.js";
import { createStorageService } from "/app/server/dist/storage/service.js";
import { createLocalDiskStorageProvider } from "/app/server/dist/storage/local-disk-provider.js";

const [action, userId, workspaceId, raw] = process.argv.slice(2);
const input = JSON.parse(raw || "{}");
const db = createDb(process.env.DATABASE_URL, { maxConnections: 1 });
const token = process.env.VERRAIL_DOMAIN_API_TOKEN?.trim();
assert.ok(token, "runtime_env must supply the mounted domain credential");
const baseUrl = process.env.VERRAIL_DOMAIN_API_URL;
const storage = createStorageService(createLocalDiskStorageProvider(process.env.PAPERCLIP_STORAGE_LOCAL_DIR));
const command = async (path, body, expected = 201) => {
  const response = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}${path}`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json", "idempotency-key": `compose-repository-${randomUUID()}`,
      "x-verrail-principal-type": "user", "x-verrail-principal-id": userId },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
};
let temp;
try {
  let output;
  if (action === "prepare") {
    const mode = input.mode;
    assert.ok(["success", "cancel", "recovery"].includes(mode));
    const model = input.model ?? "fixture/test";
    assert.ok(["fixture/test", "deepseek_acceptance/deepseek-flash"].includes(model));
    const name = `Compose repository ${mode} ${randomUUID().slice(0, 8)}`;
    const definition = await command("/agent-definitions", { name, description: "Local fixture" });
    const version = await command(`/agent-definitions/${definition.resourceId}/versions`, {
      runtime: "opencode", model, prompt: "Execute the assigned repository task.",
      skills: [], tools: [], outputSchema: {}, capabilityCeiling: [],
      supplyChain: { fixture: true, source: "saved_agent_configuration.v2", mode: "compatibility_executor" },
    });
    const evaluation = await command("/evaluation-runs", { candidateAgentVersionId: version.resourceId,
      status: "passed", qualityScore: 100, costCents: 0, latencyMs: 1, safetyStatus: "passed", summary: "Fixture" });
    const deployment = await command("/deployments", { agentDefinitionId: definition.resourceId,
      agentVersionId: version.resourceId, evaluationRunId: evaluation.resourceId, name,
      isDefault: true, runtimeConfig: { cwd: "/var/lib/verrail-repository/workspaces" } });
    const [revision] = await db.$client`select id from verrail_deployment_revisions where deployment_id=${deployment.resourceId}`;
    const target = await command("/targets", { title: `Compose repository ${mode}`,
      goal: mode === "success" ? "Change hello.txt from before to after, preserving the newline. Submit changes.patch and the required manifest. Do not change other source files." : "fixture-repository-cancel",
      outcomeOwner: { principalType: "user", principalId: userId },
      acceptanceCriteria: [{ title: "Inspect the resulting execution facts" }], riskLevel: "low" });
    const graph = await command(`/targets/${target.targetId}/graph-revisions`, {
      expectedTargetRevisionId: target.targetRevisionId, nodes: [{ nodeKey: "execute", kind: "agent_task", stage: "execute",
        title: mode === "success" ? "Edit hello.txt" : "fixture-repository-cancel",
        responsiblePrincipal: { principalType: "agent", principalId: revision.id },
        dependencyNodeKeys: [], completionDefinition: "Attach an inspectable patch" }],
    });
    await command(`/targets/${target.targetId}/graph-revisions/${graph.graphRevisionId}/activate`, null, 200);
    const [node] = await db.$client`select id from verrail_work_nodes where graph_revision_id=${graph.graphRevisionId}`;
    temp = await mkdtemp("/tmp/compose-repository-source-");
    const source = join(temp, "source");
    await mkdir(source);
    const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: "pipe",
      env: { PATH: process.env.PATH, HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
    git("init", "--template=", "-b", "main");
    await writeFile(join(source, "hello.txt"), "before\n");
    git("add", "hello.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source");
    const baseCommit = git("rev-parse", "HEAD");
    git("bundle", "create", "source.bundle", "HEAD", "main");
    const bundle = await readFile(join(source, "source.bundle"));
    const registered = await registerRepositorySource({ storage, domainApi: createVerrailDomainApiClient({ baseUrl, token }),
      principalId: userId, signal: AbortSignal.timeout(30000), recheck: async () => {},
      source: { bundle, baseCommit, contentHash: createHash("sha256").update(bundle).digest("hex"),
        provenance: { schemaVersion: 1, workspaceId, targetId: target.targetId, targetRevisionId: target.targetRevisionId,
          graphRevisionId: graph.graphRevisionId, bindingId: randomUUID(), connectionId: randomUUID(),
          repository: "fixture/repository", ref: "main", baseCommit, authorizationContextHash: "b".repeat(64) } } });
    output = { workspaceId, targetId: target.targetId, targetRevisionId: target.targetRevisionId,
      graphRevisionId: graph.graphRevisionId, workNodeId: node.id, deploymentRevisionId: revision.id,
      repositorySourceRevisionId: registered.provenanceArtifact.artifactRevisionId, baseCommit, source: registered.source };
  } else if (action === "start") {
    const [node] = await db.$client`select status from verrail_work_nodes where id=${input.workNodeId}`;
    const [{ n }] = await db.$client`select count(*)::int n from verrail_runs where target_id=${input.targetId}`;
    assert.equal(node.status, "ready");
    assert.equal(n, 0, "Scheduling consumed a source-less node");
    output = await command(`/targets/${input.targetId}/graph-revisions/${input.graphRevisionId}/nodes/${input.workNodeId}/runs`, {
      kind: "agent_run", actor: { principalType: "agent", principalId: input.deploymentRevisionId },
      repositorySourceRevisionId: input.repositorySourceRevisionId,
    });
  } else if (action === "cancel") {
    output = await command(`/runs/${input.runId}/cancel`, null, 200);
  } else if (action === "state") {
    const [state] = await db.$client`select run.id, run.status run_status, attempt.id attempt_id,
      attempt.status attempt_status, lease.status lease_status, dispatch.status dispatch_status, dispatch.tool_calls,
      dispatch.error_code, dispatch.input, attempt.result from verrail_runs run
      left join verrail_run_attempts attempt on attempt.run_id=run.id and attempt.attempt_number=run.attempt_count
      left join verrail_execution_leases lease on lease.run_attempt_id=attempt.id
      left join verrail_repository_dispatches dispatch on dispatch.run_attempt_id=attempt.id where run.id=${input.runId}`;
    const events = await db.$client`select event_type from verrail_run_events where run_id=${input.runId} order by cursor`;
    const artifacts = await db.$client`select id,content_ref,content_hash from verrail_artifact_revisions where source_run_id=${input.runId}`;
    const bound = await db.$client`select * from verrail_run_sources where run_id=${input.runId}`;
    output = { state, events, artifacts, bound };
  } else if (action === "verify-output") {
    const rows = await db.$client`select content_ref,content_hash from verrail_artifact_revisions where source_run_id=${input.runId}`;
    assert.equal(rows.length, 1);
    const object = await storage.getObject(workspaceId, rows[0].content_ref.slice("storage:".length));
    const chunks = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), rows[0].content_hash);
    assert.match(bytes.toString(), /-before/);
    assert.match(bytes.toString(), /\+after/);
    output = { artifact: rows[0], bytes: bytes.length, patch: bytes.toString() };
  } else throw new Error("Unknown fixture action");
  process.stdout.write(JSON.stringify(output));
} finally {
  if (temp) await rm(temp, { recursive: true, force: true });
  await db.$client.end();
}
