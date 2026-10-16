import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { repositoryCommandSchema } from "./repository-command.js";

export type RepositoryCommandRunner = (options: {
  cwd: string; input: z.infer<typeof repositoryCommandSchema>; signal: AbortSignal;
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const replySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running") }).strict(),
  z.object({ status: z.literal("stopped") }).strict(),
  z.object({ status: z.literal("finished"), exitCode: z.number().int(),
    stdout: z.string().max(1_048_576), stderr: z.string().max(1_048_576),
    error: z.enum(["timeout", "output_limit", "execution_failed"]).optional() }).strict(),
]);

export const repositoryContainerConfigSchema = z.object({
  destination: z.string().regex(/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/),
  port: z.number().int().min(1).max(65535).default(22),
  identityFile: z.string().refine(isAbsolute),
  knownHostsFile: z.string().refine(isAbsolute),
}).strict();

type Packet = { version: 1; operation: "start" | "poll" | "stop"; commandId: string;
  workspace?: string; command?: string; timeoutSeconds?: number };
export type RepositoryContainerTransport = (packet: Packet, signal: AbortSignal) => Promise<unknown>;

export function createRepositoryContainerTransport(raw: z.input<typeof repositoryContainerConfigSchema>): RepositoryContainerTransport {
  const config = repositoryContainerConfigSchema.parse(raw);
  return (packet, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn("ssh", ["-F", "/dev/null", "-T", "-p", String(config.port),
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ClearAllForwardings=yes",
      "-o", "ProxyCommand=none", "-o", "PermitLocalCommand=no", "-o", "ConnectTimeout=5",
      "-o", "LogLevel=ERROR", "-o", `UserKnownHostsFile=${config.knownHostsFile}`,
      "-i", config.identityFile, config.destination, "verrail-container-v1"], {
      stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, 20_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) stop();
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => { failed = true; });
    child.on("error", () => { failed = true; });
    child.once("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || code !== 0) return reject(new Error("REPOSITORY_CONTAINER_TRANSPORT_FAILED"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("REPOSITORY_CONTAINER_PROTOCOL_FAILED")); }
    });
    child.stdin.end(JSON.stringify(packet));
  });
}

export function createRepositoryContainerCommand(options: {
  checkoutRoot: string; transport: RepositoryContainerTransport;
}): RepositoryCommandRunner {
  if (!isAbsolute(options.checkoutRoot)) throw new Error("REPOSITORY_CONTAINER_CONFIG_INVALID");
  return async ({ cwd, input: raw, signal }) => {
    const input = repositoryCommandSchema.parse(raw);
    const workspace = relative(options.checkoutRoot, cwd);
    if (!isAbsolute(cwd) || !/^verrail-repository-[A-Za-z0-9_-]+\/checkout$/.test(workspace)
      || Buffer.byteLength(input.command) > 80_000) throw new Error("REPOSITORY_CONTAINER_INPUT_INVALID");
    signal.throwIfAborted();
    const commandId = randomUUID();
    const deadline = AbortSignal.timeout((input.timeoutSeconds + 30) * 1000);
    const lifetime = AbortSignal.any([signal, deadline]);
    const packet = (operation: Packet["operation"]): Packet => ({ version: 1, operation, commandId });
    try {
      let reply = replySchema.parse(await options.transport({ ...packet("start"), workspace, ...input }, lifetime));
      while (reply.status === "running") {
        await delay(250, undefined, { signal: lifetime });
        reply = replySchema.parse(await options.transport(packet("poll"), lifetime));
      }
      lifetime.throwIfAborted();
      if (reply.status !== "finished") throw new Error("REPOSITORY_COMMAND_FAILED");
      if (reply.error) throw new Error({ timeout: "REPOSITORY_COMMAND_TIMEOUT",
        output_limit: "REPOSITORY_COMMAND_OUTPUT_LIMIT", execution_failed: "REPOSITORY_COMMAND_FAILED" }[reply.error]);
      if (Buffer.byteLength(reply.stdout) + Buffer.byteLength(reply.stderr) > 1_048_576) {
        throw new Error("REPOSITORY_COMMAND_OUTPUT_LIMIT");
      }
      return { exitCode: reply.exitCode, stdout: reply.stdout, stderr: reply.stderr };
    } finally {
      // A lost start reply can hide a live container. Stop uses the same identity
      // and an independent deadline; the gateway tombstones even unseen starts.
      try {
        const stopped = replySchema.parse(await options.transport(packet("stop"), AbortSignal.timeout(20_000)));
        if (stopped.status !== "stopped") throw new Error("stop not acknowledged");
      } catch { throw new Error("REPOSITORY_COMMAND_CLEANUP_FAILED"); }
    }
  };
}
