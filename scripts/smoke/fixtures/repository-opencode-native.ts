import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { RepositoryExecutionRequest } from "../../../packages/shared/src/repository-execution.js";
import { createOpenCodeRepositoryRuntime } from "../../../server/src/execution/opencode-repository-runtime.js";

const id = "11111111-1111-4111-8111-111111111111";
const directory = `.verrail/run-artifacts/${id}`;
const manifest = JSON.stringify({ schemaVersion: 1, artifacts: [{ title: "Result", kind: "report", path: "result.txt" }] });
const command = `printf after > result.txt; mkdir -p ${directory}; cp result.txt ${directory}/result.txt; printf '%s' '${manifest}' > ${directory}/manifest.json; if cat /etc/passwd 2>/dev/null; then exit 91; fi; printf sandbox-command-done`;
let admissions = 0;
let toolOffered = false;
const outputs: string[] = [];
const provider = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const tools = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
    assert.ok(tools.every((name: string) => name === "repository_execute_command"));
    toolOffered ||= tools.length > 0;
    const results = body.messages.filter((message: { role: string }) => message.role === "tool");
    outputs.push(...results.map((message: { content: string }) => message.content));
    const done = results.length > 0 || tools.length === 0;
    const delta = done ? { role: "assistant", content: "Repository changed" } : {
      role: "assistant", tool_calls: [{ index: 0, id: "repository-call", type: "function",
        function: { name: "repository_execute_command", arguments: JSON.stringify({ command, timeoutSeconds: 10 }) } }],
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [value, finish] of [[delta, null], [{}, done ? "stop" : "tool_calls"]]) {
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
        model: "test", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  } catch { res.writeHead(500).end(); }
});
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
try {
  await writeFile("/work/result.txt", "before");
  const runtime = createOpenCodeRepositoryRuntime({ version: "1.17.13", launcher: "/usr/local/bin/repository-sandbox",
    authorize: async () => {}, consumeToolCall: async () => { admissions++; }, emit: async () => {},
    providers: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture",
      options: { baseURL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, apiKey: "fixture-only" },
      models: { test: { name: "Test", limit: { context: 32000, output: 1000 } } } } },
  });
  const request: RepositoryExecutionRequest = { schemaVersion: 1, kind: "target_repository_execution",
    workspaceId: id, targetId: id, targetRevisionId: id, graphRevisionId: id, workNodeId: id,
    runId: id, runAttemptId: id, leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id,
    source: { artifactId: id, contentHash: "a".repeat(64), baseCommit: "b".repeat(40), format: "git_bundle" },
    runtime: "opencode", model: "fixture/test", instructions: "Update result.txt and submit the report.",
    timeoutSeconds: 45, output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 } };
  assert.deepEqual(await runtime(request, "/work", AbortSignal.timeout(45_000)), { exitCode: 0 });
  assert.equal(await readFile("/work/result.txt", "utf8"), "after");
  assert.equal(await readFile(`/work/${directory}/result.txt`, "utf8"), "after");
  assert.equal(admissions, 1);
  assert.ok(toolOffered);
  assert.ok(outputs.join("").includes("sandbox-command-done"));
  console.log("REPOSITORY_NATIVE_OPENCODE_PASS");
} finally {
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
}
