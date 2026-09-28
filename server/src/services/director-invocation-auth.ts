import { createHmac, timingSafeEqual } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { activityLog, verrailConversationInvocations as invocations, type Db } from "@paperclipai/db";
import { DIRECTOR_GATEWAY_TOOL_NAMES } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { assertDirectorMember } from "./director-tools.js";

const claimsSchema = z.object({ invocationId: z.string().uuid(), workspaceId: z.string().uuid(), expires: z.number().int().positive() }).strict();

export function createDirectorInvocationTokens(secret: string, now = Date.now) {
  if (Buffer.byteLength(secret) < 32) throw new Error("Director signing key is required");
  const signature = (payload: string) => createHmac("sha256", secret).update(`verrail-director-invocation.v1.${payload}`).digest("base64url");
  return {
    issue(invocationId: string, workspaceId: string) {
      const payload = Buffer.from(JSON.stringify(claimsSchema.parse({ invocationId, workspaceId, expires: now() + 120_000 }))).toString("base64url");
      return `${payload}.${signature(payload)}`;
    },
    verify(token: string) {
      try {
        if (token.length > 1024) throw new Error();
        const parts = token.split(".");
        if (parts.length !== 2) throw new Error();
        const actual = Buffer.from(parts[1]);
        const expected = Buffer.from(signature(parts[0]));
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
        if (claims.expires <= now() || claims.expires > now() + 120_000) throw new Error();
        return claims;
      } catch { throw forbidden("Director invocation token is invalid or expired"); }
    },
  };
}

export function directorInvocationAuthorization(db: Db, tokens: ReturnType<typeof createDirectorInvocationTokens>) {
  return async (token: string, tool?: string) => {
    const claims = tokens.verify(token);
    if (tool !== undefined && !DIRECTOR_GATEWAY_TOOL_NAMES.some(name => name === tool)) throw forbidden("Director tool is unavailable");
    return db.transaction(async tx => {
      const [row] = await tx.select().from(invocations).where(and(eq(invocations.id, claims.invocationId), eq(invocations.workspaceId, claims.workspaceId))).for("update");
      if (!row || row.finishedAt || !["queued", "running"].includes(row.status)) throw forbidden("Director invocation is not active");
      // Admission is durable before gateway dispatch; its start event can arrive later.
      await assertDirectorMember(tx, row.workspaceId, row.principalId, true);
      if (tool !== undefined) {
        const [usage] = await tx.select({ count: count() }).from(activityLog).where(and(eq(activityLog.companyId, row.workspaceId), eq(activityLog.entityType, "conversation_invocation"), eq(activityLog.entityId, row.id), eq(activityLog.action, "conversation.director_tool_authorized")));
        if (usage.count >= 20) throw forbidden("Director tool budget exhausted");
        await tx.insert(activityLog).values({ companyId: row.workspaceId, actorType: "user", actorId: row.principalId, action: "conversation.director_tool_authorized", entityType: "conversation_invocation", entityId: row.id, details: { tool, conversationId: row.conversationId, agentVersionId: row.agentVersionId, deploymentRevisionId: row.deploymentRevisionId } });
      }
      return row;
    });
  };
}
