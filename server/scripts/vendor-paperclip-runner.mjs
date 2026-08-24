import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const serverRoot = resolve(import.meta.dirname, "..");
const runnerDist = resolve(
  process.env.PAPERCLIP_RUNNER_DIST ??
    resolve(serverRoot, "../packages/paperclip-runner/dist"),
);
const serverDist = resolve(
  process.env.PAPERCLIP_SERVER_DIST ?? resolve(serverRoot, "dist"),
);
const vendorRoot = resolve(serverDist, "vendor");
const vendorDist = resolve(vendorRoot, "paperclip-runner");

await access(resolve(runnerDist, "index.js")).catch(() => {
  throw new Error(
    "paperclip-runner build output is missing. Run pnpm --filter @paperclipai/paperclip-runner build:typescript first.",
  );
});

await rm(vendorDist, { recursive: true, force: true });
await mkdir(vendorRoot, { recursive: true });
await cp(runnerDist, vendorDist, { recursive: true });

process.stdout.write(
  "Vendored paperclip-runner JavaScript into the server distribution.\n",
);
