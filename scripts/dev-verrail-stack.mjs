#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repoRoot, "docker", "docker-compose.verrail-dev.yml");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function parsePort(value, name, fallback) {
  const port = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

export function buildStackConfig(input = process.env) {
  const postgresPort = parsePort(input.VERRAIL_DEV_POSTGRES_PORT, "VERRAIL_DEV_POSTGRES_PORT", 55_432);
  const temporalGrpcPort = parsePort(
    input.VERRAIL_DEV_TEMPORAL_GRPC_PORT,
    "VERRAIL_DEV_TEMPORAL_GRPC_PORT",
    57_233,
  );
  const temporalUiPort = parsePort(input.VERRAIL_DEV_TEMPORAL_UI_PORT, "VERRAIL_DEV_TEMPORAL_UI_PORT", 58_233);
  const appPort = parsePort(input.PORT, "PORT", 3_100);
  const projectName = input.VERRAIL_DEV_COMPOSE_PROJECT?.trim() || "verrail-dev";
  const databaseUrl = input.VERRAIL_DEV_DATABASE_URL?.trim()
    || `postgres://verrail:verrail@127.0.0.1:${postgresPort}/verrail`;
  const temporalAddress = input.TEMPORAL_ADDRESS?.trim() || `127.0.0.1:${temporalGrpcPort}`;

  const composeEnv = {
    ...input,
    VERRAIL_DEV_POSTGRES_PORT: String(postgresPort),
    VERRAIL_DEV_TEMPORAL_GRPC_PORT: String(temporalGrpcPort),
    VERRAIL_DEV_TEMPORAL_UI_PORT: String(temporalUiPort),
  };
  const runtimeEnv = {
    ...composeEnv,
    PORT: String(appPort),
    DATABASE_URL: databaseUrl,
    DATABASE_MIGRATION_URL: input.DATABASE_MIGRATION_URL?.trim() || databaseUrl,
    TEMPORAL_ADDRESS: temporalAddress,
    TEMPORAL_NAMESPACE: input.TEMPORAL_NAMESPACE?.trim() || "default",
    VERRAIL_TEMPORAL_TASK_QUEUE: input.VERRAIL_TEMPORAL_TASK_QUEUE?.trim() || "verrail-target-v1",
    VERRAIL_DOMAIN_API_AUTOSTART: "true",
    PAPERCLIP_HOME: input.PAPERCLIP_HOME?.trim() || path.join(repoRoot, ".paperclip", "verrail-dev"),
    PAPERCLIP_INSTANCE_ID: input.PAPERCLIP_INSTANCE_ID?.trim() || "verrail-dev",
    PAPERCLIP_MIGRATION_PROMPT: "never",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
  };

  return {
    appPort,
    composeEnv,
    databaseUrl,
    keepInfra: input.VERRAIL_DEV_KEEP_INFRA === "true",
    projectName,
    runtimeEnv,
    temporalAddress,
    temporalUiPort,
  };
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`);
  }
}

function composeArgs(projectName, ...args) {
  return ["compose", "-f", composeFile, "-p", projectName, ...args];
}

function prefix(name, data) {
  const label = `[${name}] `;
  return label + String(data).replace(/\n(?!$)/g, `\n${label}`);
}

function signalProcessGroup(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function main() {
  const config = buildStackConfig();
  const children = [];
  let stopping = false;

  const stopAll = async (code) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) signalProcessGroup(child, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 750));
    for (const child of children) signalProcessGroup(child, "SIGKILL");
    if (!config.keepInfra) {
      try {
        runChecked("docker", composeArgs(config.projectName, "down"), { env: config.composeEnv });
      } catch (error) {
        console.error(`[stack] failed to stop local infrastructure: ${error.message}`);
        code = code || 1;
      }
    }
    process.exit(code);
  };

  try {
    runChecked("docker", composeArgs(config.projectName, "up", "-d", "--wait"), { env: config.composeEnv });
    runChecked(pnpmBin, ["run", "db:migrate"], { env: config.runtimeEnv });
  } catch (error) {
    console.error(`[stack] startup failed: ${error.message}`);
    if (!config.keepInfra) {
      spawnSync("docker", composeArgs(config.projectName, "down"), {
        cwd: repoRoot,
        env: config.composeEnv,
        stdio: "inherit",
      });
    }
    process.exit(1);
  }

  const jobs = [
    { name: "server", args: ["run", "dev"] },
    { name: "worker", args: ["run", "dev:orchestration-worker"] },
  ];
  for (const job of jobs) {
    const child = spawn(pnpmBin, job.args, {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: config.runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => process.stdout.write(prefix(job.name, data)));
    child.stderr.on("data", (data) => process.stderr.write(prefix(job.name, data)));
    child.on("error", (error) => {
      console.error(prefix(job.name, `failed to start: ${error.message}\n`));
      void stopAll(1);
    });
    child.on("exit", (code, signal) => {
      if (!stopping) {
        console.error(prefix(job.name, `exited (code=${code} signal=${signal})\n`));
        void stopAll(code ?? 1);
      }
    });
    children.push(child);
  }

  console.log(`[stack] Verrail: http://127.0.0.1:${config.appPort}`);
  console.log(`[stack] Temporal UI: http://127.0.0.1:${config.temporalUiPort}`);
  console.log(`[stack] PostgreSQL and Temporal data use persistent Docker volumes; Ctrl-C stops processes and containers.`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => void stopAll(0));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
