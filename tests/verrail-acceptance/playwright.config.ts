import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.VERRAIL_ACCEPTANCE_PORT ?? 3203);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PAPERCLIP_HOME = process.env.PAPERCLIP_HOME;
if (!PAPERCLIP_HOME) {
  throw new Error("Run this suite through `pnpm test:e2e:verrail-acceptance`.");
}
const PAPERCLIP_INSTANCE_ID = "verrail-frontend-acceptance";
const PAPERCLIP_CONFIG = path.join(PAPERCLIP_HOME, "instances", PAPERCLIP_INSTANCE_ID, "config.json");
const DELIVERY_OUTPUT_ROOT = process.env.VERRAIL_ACCEPTANCE_OUTPUT_ROOT;
const OUTPUT_ROOT = path.resolve(DELIVERY_OUTPUT_ROOT ?? "tests/verrail-acceptance");
const RESULTS_DIRECTORY = DELIVERY_OUTPUT_ROOT ? "playwright-results" : "test-results";
const PLAYWRIGHT_CHANNEL = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;

process.env.PAPERCLIP_HOME = PAPERCLIP_HOME;
process.env.PAPERCLIP_CONFIG = PAPERCLIP_CONFIG;
process.env.PAPERCLIP_INSTANCE_ID = PAPERCLIP_INSTANCE_ID;
process.env.VERRAIL_ACCEPTANCE_SCREENSHOT_DIR = path.join(OUTPUT_ROOT, "screenshots");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-1440",
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "narrow-desktop-1024",
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
        viewport: { width: 1024, height: 768 },
      },
    },
  ],
  webServer: {
    command: "pnpm paperclipai onboard --yes --run",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      PAPERCLIP_HOME,
      PAPERCLIP_INSTANCE_ID,
      PAPERCLIP_CONFIG,
      PAPERCLIP_AGENT_JWT_SECRET: "verrail-acceptance-agent-jwt-secret",
      PAPERCLIP_DECISION_SIGNING_SECRET: "verrail-acceptance-decision-signing-secret",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "verrail-acceptance-tool-action-signing-secret",
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: path.join(OUTPUT_ROOT, RESULTS_DIRECTORY),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(OUTPUT_ROOT, "playwright-report") }],
  ],
});
