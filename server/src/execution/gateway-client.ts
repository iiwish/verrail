import { z } from "zod";
import { conversationInvocationEventSchema, CONVERSATION_INVOCATION_STATUSES, executionGatewayRequestSchema, type ExecutionGatewayRequest } from "@paperclipai/shared";
import { HttpError } from "../errors.js";

const replaySchema = z.object({
  invocationId: z.string().uuid(), status: z.enum(CONVERSATION_INVOCATION_STATUSES), lastEventCursor: z.number().int().nonnegative(),
  events: z.array(z.object({ cursor: z.number().int().positive(), at: z.string().datetime(), event: conversationInvocationEventSchema }).strict()).max(200),
}).strict();

export function createExecutionGatewayClient(options: { url: string; token: string; fetch?: typeof fetch }) {
  const url = new URL(options.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || options.token.length < 32) throw new Error("Invalid gateway configuration");
  async function call(path: string, method = "GET", body?: unknown) {
    const response = await (options.fetch ?? fetch)(new URL(path, url), {
      method, headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(response.status, "Execution gateway request failed");
    }
    if (!response.body) throw new Error("Gateway response is empty");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024 * 1024) throw new Error("Gateway response exceeds limit");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); }
  }
  return {
    async submit(input: ExecutionGatewayRequest) {
      input = executionGatewayRequestSchema.parse(input);
      const result = z.object({ invocationId: z.string().uuid(), replayed: z.boolean() }).strict().parse(await call("/v1/invocations", "POST", input));
      if (result.invocationId !== input.invocationId) throw new Error("Gateway identity mismatch");
      return result;
    },
    async read(workspaceId: string, invocationId: string, after = 0) {
      z.string().uuid().parse(workspaceId);
      z.string().uuid().parse(invocationId);
      z.number().int().nonnegative().parse(after);
      const result = replaySchema.parse(await call(`/v1/invocations/${invocationId}?workspaceId=${workspaceId}&after=${after}`));
      if (result.invocationId !== invocationId || result.events.some((row, index) => row.cursor !== after + index + 1 || row.cursor > result.lastEventCursor)) throw new Error("Gateway replay mismatch");
      return result;
    },
    async cancel(workspaceId: string, invocationId: string) {
      z.string().uuid().parse(workspaceId);
      z.string().uuid().parse(invocationId);
      const result = z.object({ invocationId: z.string().uuid() }).strict().parse(await call(`/v1/invocations/${invocationId}/cancel`, "POST", { workspaceId }));
      if (result.invocationId !== invocationId) throw new Error("Gateway identity mismatch");
    },
  };
}
