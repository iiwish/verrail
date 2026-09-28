import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate an IPv4 loopback port")));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(address.port));
      });
    });
  });
}

const acceptancePort = process.env.VERRAIL_ACCEPTANCE_PORT ?? (await allocateLoopbackPort());
const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "verrail-acceptance-home-"));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const args = [
  "exec",
  "playwright",
  "test",
  "--config",
  "tests/verrail-acceptance/playwright.config.ts",
  ...process.argv.slice(2),
];

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        PAPERCLIP_HOME: paperclipHome,
        VERRAIL_ACCEPTANCE_PORT: acceptancePort,
      },
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Playwright exited after receiving ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  process.exitCode = exitCode;
} finally {
  await fs.rm(paperclipHome, { recursive: true, force: true });
}
