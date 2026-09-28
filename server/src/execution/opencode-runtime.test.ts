import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DIRECTOR_GATEWAY_TOOL_NAMES } from "@paperclipai/shared";
import { createOpenCodeGatewayRuntime } from "./opencode-runtime.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe.skipIf(process.env.VERRAIL_TEST_OPENCODE_HTTP !== "1")("isolated OpenCode gateway runtime", () => {
  it("runs with scoped MCP credentials and offers only the approved Director tools", async () => {
    const tokens: string[] = [];
    const offeredTools: string[][] = [];
    const director = createServer(async (req, res) => {
      tokens.push(String(req.headers["x-verrail-chat-token"] ?? ""));
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (rpc.id === undefined) { res.writeHead(202).end(); return; }
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : rpc.method === "tools/list"
          ? { tools: [...DIRECTOR_GATEWAY_TOOL_NAMES, "unapproved_tool"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) }
          : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      offeredTools.push((body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "Fixture response" }, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
    const controlPlaneUrl = await listen(director);
    const providerUrl = await listen(provider);
    try {
      const runtime = createOpenCodeGatewayRuntime({
        version: "1.17.13", controlPlaneUrl,
        providers: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `${providerUrl}/v1`, apiKey: "not-a-real-key" }, models: { test: { name: "Test", limit: { context: 32000, output: 1000 } } } } },
      });
      const directorToken = "isolated-invocation-director-token-0123456789";
      const text: string[] = [];
      await runtime({
        invocationId: randomUUID(), workspaceId: randomUUID(), conversationId: randomUUID(),
        principalId: "fixture", agentVersionId: randomUUID(), deploymentRevisionId: randomUUID(),
        fencingToken: 1, runtime: "opencode", model: "fixture/test", systemPrompt: "Reply briefly", prompt: "Hello", directorToken,
      }, { signal: AbortSignal.timeout(45_000), emit: async chunk => { text.push(chunk); } });
      expect(text.join("")).toBe("Fixture response");
      expect(tokens.length).toBeGreaterThan(0);
      expect(new Set(tokens)).toEqual(new Set([directorToken]));
      expect(offeredTools.length).toBeGreaterThan(0);
      const approved = DIRECTOR_GATEWAY_TOOL_NAMES.map(name => `director_${name}`);
      expect(offeredTools.flat()).toContain("director_get_conversation_context");
      expect(offeredTools.flat().every(name => approved.includes(name))).toBe(true);
    } finally { await close(provider); await close(director); }
  }, 60_000);
});
