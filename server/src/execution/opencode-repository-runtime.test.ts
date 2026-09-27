import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RepositoryExecutionRequest } from "@paperclipai/shared";
import { createOpenCodeRepositoryRuntime } from "./opencode-repository-runtime.js";

it.skipIf(process.env.VERRAIL_TEST_OPENCODE_HTTP !== "1")("real OpenCode edits repository bytes through its sole scoped MCP tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "verrail-repository-runtime-test-"));
  const launcher = join(root, "fixture-launcher");
  // Process transport fixture only; native Linux policy is tested separately.
  await writeFile(launcher, '#!/bin/sh\ncd "$1" || exit 125\nshift\nexec "$@"\n', { mode: 0o700 });
  await writeFile(join(root, "result.txt"), "before");
  const id = "11111111-1111-4111-8111-111111111111";
  const outputDirectory = `.verrail/run-artifacts/${id}`;
  const manifest = JSON.stringify({ schemaVersion: 1, artifacts: [{ title: "Result", kind: "report", path: "result.txt" }] });
  const command = `printf after > result.txt; mkdir -p ${outputDirectory}; cp result.txt ${outputDirectory}/result.txt; printf '%s' '${manifest}' > ${outputDirectory}/manifest.json; printf command-done`;
  const offered: string[][] = [];
  const toolResults: string[] = [];
  const provider = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      offered.push((body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name));
      const results = body.messages.filter((message: { role: string }) => message.role === "tool");
      toolResults.push(...results.map((message: { content: string }) => message.content));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = results.length ? { role: "assistant", content: "Repository changed" } : {
        role: "assistant", content: "Starting repository command. ", tool_calls: [{ index: 0, id: "repository-call", type: "function",
          function: { name: "repository_execute_command", arguments: JSON.stringify({ command, timeoutSeconds: 10 }) } }],
      };
      for (const [value, finish] of [[delta, null], [{}, results.length ? "stop" : "tool_calls"]]) {
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1,
          model: "test", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const authorize = vi.fn(async () => {});
    const consumeToolCall = vi.fn(async () => {});
    const text: string[] = [];
    const runtime = createOpenCodeRepositoryRuntime({ version: "1.17.13", launcher, authorize, consumeToolCall,
      emit: async (_request, chunk) => { text.push(chunk); },
      providers: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture",
        options: { baseURL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, apiKey: "fixture-only" },
        models: { test: { name: "Test", limit: { context: 32000, output: 1000 } } } } },
    });
    const request: RepositoryExecutionRequest = {
      schemaVersion: 1, kind: "target_repository_execution", workspaceId: id, targetId: id,
      targetRevisionId: id, graphRevisionId: id, workNodeId: id, runId: id, runAttemptId: id,
      leaseId: id, fencingToken: 1, agentVersionId: id, deploymentRevisionId: id,
      source: { artifactId: id, contentHash: "a".repeat(64), baseCommit: "b".repeat(40), format: "git_bundle" },
      runtime: "opencode", model: "fixture/test", instructions: "Update result.txt and submit the report.",
      timeoutSeconds: 45, output: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 },
    };
    expect(await runtime(request, root, AbortSignal.timeout(45_000))).toEqual({ exitCode: 0 });
    expect(await readFile(join(root, "result.txt"), "utf8")).toBe("after");
    expect(await readFile(join(root, outputDirectory, "result.txt"), "utf8")).toBe("after");
    expect(text.join("")).toBe("Starting repository command. Repository changed");
    expect(consumeToolCall).toHaveBeenCalledOnce();
    expect(offered.length).toBeGreaterThanOrEqual(2);
    expect(offered).toContainEqual(["repository_execute_command"]);
    // Auxiliary model requests can omit tools; none may gain another capability.
    for (const tools of offered) {
      expect(tools.filter(name => name !== "repository_execute_command")).toEqual([]);
    }
    expect(toolResults.join("")).toContain("command-done");
  } finally {
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
