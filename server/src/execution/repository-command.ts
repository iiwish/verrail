import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const repositoryCommandSchema = z.object({
  command: z.string().min(1).max(80_000),
  timeoutSeconds: z.number().int().min(1).max(120),
}).strict();

// The configured launcher is mandatory. Never fall back to an unsandboxed shell.
export async function runRepositoryCommand(options: {
  launcher: string; cwd: string; input: z.infer<typeof repositoryCommandSchema>;
  signal: AbortSignal;
}) {
  const input = repositoryCommandSchema.parse(options.input);
  if (!isAbsolute(options.launcher) || !isAbsolute(options.cwd)) throw new Error("REPOSITORY_COMMAND_CONFIG_INVALID");
  options.signal.throwIfAborted();
  const child = spawn(options.launcher, [options.cwd, "/bin/sh", "-c", input.command], {
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let failure: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = "REPOSITORY_COMMAND_CLEANUP_FAILED";
      }
    }
  };
  const stop = (reason: string) => {
    if (killTimer) return;
    failure ??= reason;
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
  };
  const canceled = () => stop("REPOSITORY_COMMAND_CANCELED");
  const timer = setTimeout(() => stop("REPOSITORY_COMMAND_TIMEOUT"), input.timeoutSeconds * 1000);
  const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { stop("REPOSITORY_COMMAND_OUTPUT_LIMIT"); return; }
    (stream === "stdout" ? stdout : stderr).push(chunk);
  };
  child.stdout.on("data", chunk => collect(chunk, "stdout"));
  child.stderr.on("data", chunk => collect(chunk, "stderr"));
  child.on("error", () => { failure = "REPOSITORY_COMMAND_START_FAILED"; });
  child.once("exit", () => kill("SIGKILL"));
  const closed = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
  options.signal.addEventListener("abort", canceled, { once: true });
  if (options.signal.aborted) canceled();
  try {
    const exitCode = await closed;
    kill("SIGKILL");
    if (child.pid && process.platform !== "win32") {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(-child.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          throw new Error("REPOSITORY_COMMAND_CLEANUP_FAILED");
        }
        if (attempt === 99) throw new Error("REPOSITORY_COMMAND_CLEANUP_FAILED");
        await delay(20);
      }
    }
    if (failure) throw new Error(failure);
    if (exitCode === null || exitCode === 125) throw new Error("REPOSITORY_COMMAND_FAILED");
    return { exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    options.signal.removeEventListener("abort", canceled);
  }
}
