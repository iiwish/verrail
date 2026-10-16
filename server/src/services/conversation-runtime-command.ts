import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveCommandForLogs } from "../adapters/utils.js";

export async function resolveConversationRuntimeCommand(
  runtime: "codex" | "claude",
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const configured = env.VERRAIL_CHAT_COMMAND?.trim();
  if (configured) return resolveCommandForLogs(configured, cwd, env);
  const resolved = await resolveCommandForLogs(runtime, cwd, env);
  if (resolved !== runtime || runtime !== "codex" || platform !== "darwin") return resolved;

  // GUI-launched services do not inherit the desktop app's augmented PATH.
  const appRoots = [
    ...(env.HOME ? [join(env.HOME, "Applications")] : []),
    "/Applications",
  ];
  for (const root of appRoots) {
    for (const app of ["Codex.app", "ChatGPT.app"]) {
      const candidate = join(root, app, "Contents/Resources/codex");
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Only executable installations are eligible for discovery.
      }
    }
  }
  return runtime;
}
