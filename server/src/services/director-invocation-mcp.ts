import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { directorToolExecutor, handleDirectorMcpRequest } from "./director-tools.js";
import { directorInvocationAuthorization, type createDirectorInvocationTokens } from "./director-invocation-auth.js";

export function createDirectorInvocationMcp(db: Db, tokens: ReturnType<typeof createDirectorInvocationTokens>) {
  const authorize = directorInvocationAuthorization(db, tokens);
  const executors = new Map<string, { expires: number; call: ReturnType<typeof directorToolExecutor> }>();
  return async (token: string, body: unknown) => {
    const row = await authorize(token);
    const now = Date.now();
    for (const [id, entry] of executors) if (entry.expires <= now) executors.delete(id);
    let executor = executors.get(row.id);
    if (!executor) {
      if (executors.size >= 1000) throw new HttpError(503, "Director capacity exhausted");
      executor = { expires: tokens.verify(token).expires, call: directorToolExecutor(db, {
        workspaceId: row.workspaceId, conversationId: row.conversationId, sourceMessageId: row.sourceMessageId,
        principalId: row.principalId, agentId: z.string().uuid().parse(row.input.assistantAgentId),
      }) };
      executors.set(row.id, executor);
    }
    return handleDirectorMcpRequest(body, async (name, args) => {
      await authorize(token, name);
      return executor.call(name, args);
    }, true);
  };
}
