import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import detectPort from "detect-port";
import { logger } from "../middleware/logger.js";

export interface VerrailDomainApiRuntime {
  baseUrl: string;
  token: string;
  managed: boolean;
  stop(): Promise<void>;
}

const serviceRoot = fileURLToPath(new URL("../../../services/domain-api", import.meta.url));

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  spawnFailure: () => Error | null,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const failure = spawnFailure();
    if (failure) throw failure;
    if (child.exitCode !== null) {
      throw new Error(`Verrail Domain API exited during startup with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Verrail Domain API did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function stopManagedChild(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }

  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  const exited = child.exitCode === null
    ? new Promise<void>((resolve) => child.once("exit", () => resolve()))
    : Promise.resolve();
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  signalGroup("SIGKILL");
}

export async function startVerrailDomainApiRuntime(input: {
  databaseUrl: string;
  preferredPort: number;
  env?: NodeJS.ProcessEnv;
}): Promise<VerrailDomainApiRuntime | null> {
  const env = input.env ?? process.env;
  const explicitUrl = env.VERRAIL_DOMAIN_API_URL?.trim().replace(/\/$/, "");
  const explicitToken = env.VERRAIL_DOMAIN_API_TOKEN?.trim();
  if (explicitUrl || explicitToken) {
    if (!explicitUrl || !explicitToken) {
      throw new Error("VERRAIL_DOMAIN_API_URL and VERRAIL_DOMAIN_API_TOKEN must be configured together");
    }
    return { baseUrl: explicitUrl, token: explicitToken, managed: false, stop: async () => {} };
  }
  if (env.VERRAIL_DOMAIN_API_AUTOSTART === "false") return null;
  const shouldAutoStart = env.VERRAIL_DOMAIN_API_AUTOSTART === "true"
    || env.PAPERCLIP_UI_DEV_MIDDLEWARE === "true";
  if (!shouldAutoStart) return null;
  if (!existsSync(path.join(serviceRoot, "go.mod"))) {
    logger.warn("Verrail Domain API source is unavailable; native Target commands are disabled");
    return null;
  }

  const port = await detectPort(input.preferredPort);
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString("base64url");
  const child = spawn("go", ["run", "./cmd/domain-api"], {
    cwd: serviceRoot,
    detached: process.platform !== "win32",
    env: {
      ...env,
      DATABASE_URL: input.databaseUrl,
      VERRAIL_DOMAIN_API_TOKEN: token,
      VERRAIL_DOMAIN_API_LISTEN: `127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnFailure: Error | null = null;
  child.once("error", (error) => {
    spawnFailure = error;
  });
  child.stdout?.on("data", (chunk) => logger.info({ output: String(chunk).trim() }, "Verrail Domain API"));
  child.stderr?.on("data", (chunk) => logger.warn({ output: String(chunk).trim() }, "Verrail Domain API stderr"));
  try {
    await waitForHealth(baseUrl, child, () => spawnFailure);
  } catch (error) {
    await stopManagedChild(child);
    if (env.VERRAIL_DOMAIN_API_AUTOSTART === "true") throw error;
    logger.warn(
      { err: error },
      "Managed Verrail Domain API is unavailable; native Target commands are disabled",
    );
    return null;
  }

  env.VERRAIL_DOMAIN_API_URL = baseUrl;
  env.VERRAIL_DOMAIN_API_TOKEN = token;
  logger.info({ baseUrl, pid: child.pid }, "Managed Verrail Domain API ready");
  return {
    baseUrl,
    token,
    managed: true,
    stop: () => stopManagedChild(child),
  };
}
