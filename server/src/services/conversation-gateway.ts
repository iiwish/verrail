import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Db } from "@paperclipai/db";
import { createExecutionGatewayClient } from "../execution/gateway-client.js";
import { createConversationInvocationController } from "./conversation-invocation-controller.js";
import { createDirectorInvocationTokens } from "./director-invocation-auth.js";
import { createDirectorInvocationMcp } from "./director-invocation-mcp.js";

export async function configureConversationGateway(db: Db, onError: () => void) {
  const url = process.env.VERRAIL_EXECUTION_GATEWAY_URL;
  const tokenFile = process.env.VERRAIL_GATEWAY_TOKEN_FILE;
  const signingFile = process.env.VERRAIL_DIRECTOR_SIGNING_KEY_FILE;
  if (!url && !tokenFile && !signingFile) return null;
  async function secret(path: string | undefined) {
    if (!path || !isAbsolute(path)) throw new Error("Gateway secret mount required");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o007)) throw new Error("Invalid gateway secret mount");
    return (await readFile(path, "utf8")).trim();
  }
  try {
    if (!url) throw new Error();
    const gateway = createExecutionGatewayClient({ url, token: await secret(tokenFile) });
    const tokens = createDirectorInvocationTokens(await secret(signingFile));
    return { controller: createConversationInvocationController(db, { gateway, tokens, onError }), handleMcp: createDirectorInvocationMcp(db, tokens) };
  } catch { throw new Error("Conversation gateway configuration is invalid"); }
}
