import { z } from "zod";
import { repositoryCommandSchema, runRepositoryCommand } from "./repository-command.js";
import type { RepositoryCommandRunner } from "./repository-container-command.js";

const rpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(),
  method: z.string(), params: z.unknown().optional() }).strict();

export function createRepositoryMcp(options: {
  launcher?: string;
  runCommand?: RepositoryCommandRunner;
  cwd: string;
  signal: AbortSignal;
  authorize: () => Promise<void>;
  consumeToolCall: () => Promise<void>;
  invalidate: (error: Error) => void;
}) {
  let busy = false;
  return async (raw: unknown) => {
    options.signal.throwIfAborted();
    await options.authorize();
    const request = rpcSchema.parse(raw);
    const respond = (result: unknown) => ({ jsonrpc: "2.0", id: request.id ?? null, result });
    if (request.method === "notifications/initialized") return null;
    if (request.method === "initialize") return respond({ protocolVersion: "2025-03-26",
      capabilities: { tools: {} }, serverInfo: { name: "verrail-repository", version: "1.0.0" } });
    if (request.method === "tools/list") return respond({ tools: [{ name: "execute_command",
      description: "Run an offline shell command in this Run's isolated repository to inspect, modify or test files. No network access.",
      inputSchema: z.toJSONSchema(repositoryCommandSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }] });
    if (request.method !== "tools/call") return { jsonrpc: "2.0", id: request.id ?? null,
      error: { code: -32601, message: "Method not found" } };
    if (busy) return respond({ isError: true, content: [{ type: "text", text: "Repository command already running" }] });
    busy = true;
    try {
      const call = z.object({ name: z.literal("execute_command"), arguments: repositoryCommandSchema,
        _meta: z.record(z.string(), z.unknown()).optional() }).strict().parse(request.params);
      await options.consumeToolCall();
      options.signal.throwIfAborted();
      await options.authorize();
      const command = { cwd: options.cwd, input: call.arguments, signal: options.signal };
      const result = options.runCommand ? await options.runCommand(command)
        : await runRepositoryCommand({ ...command, launcher: options.launcher ?? "" });
      await options.authorize();
      options.signal.throwIfAborted();
      return respond({ content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (error) {
      if (error instanceof Error && ["REPOSITORY_COMMAND_CLEANUP_FAILED", "REPOSITORY_COMMAND_START_FAILED",
        "REPOSITORY_COMMAND_FAILED"].includes(error.message)) options.invalidate(error);
      return respond({ isError: true, content: [{ type: "text", text: "Repository command failed or authorization expired" }] });
    } finally { busy = false; }
  };
}
