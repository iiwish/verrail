import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
