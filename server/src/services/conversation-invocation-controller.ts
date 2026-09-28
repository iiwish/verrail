import { randomUUID } from "node:crypto";
import { asc, inArray } from "drizzle-orm";
import { z } from "zod";
import { verrailConversationInvocations as invocations, type Db } from "@paperclipai/db";
import { executionGatewayRequestSchema } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import type { createExecutionGatewayClient } from "../execution/gateway-client.js";
import { conversationInvocationService } from "./conversation-invocations.js";
import { assertDirectorMember } from "./director-tools.js";
import type { createDirectorInvocationTokens } from "./director-invocation-auth.js";

const payloadSchema = z.object({
  runtime: z.literal("opencode"), model: z.string(), systemPrompt: z.string(), body: z.string(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), body: z.string() })),
  conversationContext: z.object({ currentTargetId: z.string().uuid().nullable(), contextVersion: z.number().int() }),
});
const serialize = (role: string, body: string) => `<turn role="${role}">\n${body.replace(/<(\/?turn\b)/gi, "&lt;$1")}\n</turn>`;

export function createConversationInvocationController(db: Db, options: {
  gateway: ReturnType<typeof createExecutionGatewayClient>;
  tokens: ReturnType<typeof createDirectorInvocationTokens>;
  onError?: (error: unknown) => void;
}) {
  const service = conversationInvocationService(db);
  const controllerId = `conversation-controller-${randomUUID()}`;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;

  async function reconcile(workspaceId: string, id: string) {
    let row = await service.claim(workspaceId, id, controllerId);
    if (row.finishedAt) return;
    const lease = { workspaceId, invocationId: id, controllerId, fencingToken: row.fencingToken };
    let permitted = true;
    try { await assertDirectorMember(db, row.workspaceId, row.principalId, true); }
    catch (error) { if (error instanceof HttpError && error.status === 403) permitted = false; else throw error; }
    let replay;
    try { replay = await options.gateway.read(workspaceId, id, row.lastEventCursor); }
    catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      if (!permitted || row.status === "cancel_requested") {
        const unknownRuntime = row.lastEventCursor > 0 || await service.wasDispatched(workspaceId, id);
        await service.append(lease, row.lastEventCursor + 1, unknownRuntime
          ? { type: "error", data: { errorCode: "RUNTIME_STATE_LOST" } }
          : { type: "done", data: { status: "canceled" } });
        return;
      }
      // Mark before sending: an ambiguous dispatch is never automatically repeated.
      if (!await service.prepareDispatch(lease)) {
        await service.append(lease, row.lastEventCursor + 1, { type: "error", data: { errorCode: "DISPATCH_UNCONFIRMED" } });
        return;
      }
      const input = payloadSchema.parse(row.input);
      const prompt = `${input.history.map(turn => serialize(turn.role, turn.body)).join("\n")}\n${serialize("user", input.body)}\n<conversation_context>${JSON.stringify(input.conversationContext)}</conversation_context>`;
      await options.gateway.submit(executionGatewayRequestSchema.parse({
        invocationId: id, workspaceId, conversationId: row.conversationId, principalId: row.principalId,
        agentVersionId: row.agentVersionId, deploymentRevisionId: row.deploymentRevisionId, fencingToken: row.fencingToken,
        runtime: input.runtime, model: input.model, systemPrompt: input.systemPrompt, prompt,
        directorToken: options.tokens.issue(id, workspaceId),
      }));
      return;
    }
    if (!permitted || row.status === "cancel_requested") await options.gateway.cancel(workspaceId, id);
    for (const [index, event] of replay.events.entries()) {
      if (index % 20 === 0) row = await service.claim(workspaceId, id, controllerId);
      await service.append({ ...lease, fencingToken: row.fencingToken }, event.cursor, event.event);
    }
  }

  async function tick() {
    const rows = await db.select({ id: invocations.id, workspaceId: invocations.workspaceId }).from(invocations)
      .where(inArray(invocations.status, ["queued", "running", "cancel_requested"])).orderBy(asc(invocations.createdAt)).limit(100);
    for (const row of rows) {
      if (stopped) break;
      try { await reconcile(row.workspaceId, row.id); }
      catch (error) {
        if (!(error instanceof HttpError && error.status === 409)) options.onError?.(error);
      }
    }
  }
  function start() {
    if (stopped || pending || timer) return;
    pending = tick().catch(error => { options.onError?.(error); }).finally(() => {
      pending = undefined;
      if (!stopped) timer = setTimeout(() => { timer = undefined; start(); }, 1000);
    });
  }
  return {
    reconcile,
    start,
    async close() { stopped = true; if (timer) clearTimeout(timer); await pending; },
  };
}
