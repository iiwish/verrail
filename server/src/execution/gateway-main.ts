import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createExecutionGatewayApp } from "./gateway-http.js";
import { createExecutionGatewayStore } from "./gateway-store.js";
import { createOpenCodeGatewayRuntime } from "./opencode-runtime.js";

async function readMountedFile(name: string) {
  const path = process.env[name];
  if (!path || !isAbsolute(path)) throw new Error("Missing mounted configuration");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o007)) throw new Error("Invalid mounted configuration");
  return readFile(path, "utf8");
}

async function main() {
  // The container entrypoint holds flock on this root for the whole process tree.
  const root = process.env.VERRAIL_GATEWAY_ROOT;
  const version = process.env.OPENCODE_VERSION;
  const controlPlaneUrl = process.env.VERRAIL_CONTROL_PLANE_URL;
  if (!root || !version || !controlPlaneUrl) throw new Error("Missing gateway configuration");
  const token = (await readMountedFile("VERRAIL_GATEWAY_TOKEN_FILE")).trim();
  const providers = z.record(z.string().min(1), z.record(z.string(), z.unknown())).parse(
    JSON.parse(await readMountedFile("VERRAIL_GATEWAY_PROVIDERS_FILE")),
  );
  if (!Object.keys(providers).length) throw new Error("No providers configured");
  const store = await createExecutionGatewayStore({
    root,
    runtime: createOpenCodeGatewayRuntime({ version, controlPlaneUrl, providers }),
  });
  const app = createExecutionGatewayApp(store, token);
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.VERRAIL_GATEWAY_PORT ?? 4096);
  const host = z.enum(["127.0.0.1", "0.0.0.0"]).parse(process.env.VERRAIL_GATEWAY_HOST ?? "0.0.0.0");
  const server = app.listen(port, host);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
    server.closeAllConnections();
    await closed;
  };
  process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once("SIGINT", () => { void stop().catch(() => { process.exitCode = 1; }); });
  server.once("error", () => { void stop().finally(() => { process.exitCode = 1; }); });
}

main().catch(() => {
  // Configuration may contain provider credentials. Never print its diagnostics.
  process.stderr.write("Execution gateway failed to start\n");
  process.exitCode = 1;
});
