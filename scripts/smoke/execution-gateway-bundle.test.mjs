import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

test("bundled gateway boots with mounted secrets and shuts down cleanly", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "verrail-gateway-bundle-"));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = "fixture-private-service-token-0123456789";
  const tokenPath = join(root, "token");
  const providersPath = join(root, "providers");
  await writeFile(tokenPath, token, { mode: 0o600 });
  await writeFile(providersPath, JSON.stringify({ fixture: {} }), { mode: 0o600 });
  const proc = spawn(process.execPath, ["dist/execution-gateway/gateway.cjs"], {
    env: {
      PATH: process.env.PATH,
      VERRAIL_GATEWAY_ROOT: join(root, "records"),
      VERRAIL_GATEWAY_HOST: "127.0.0.1", VERRAIL_GATEWAY_PORT: String(port),
      VERRAIL_GATEWAY_TOKEN_FILE: tokenPath, VERRAIL_GATEWAY_PROVIDERS_FILE: providersPath,
      VERRAIL_CONTROL_PLANE_URL: "http://127.0.0.1:1", OPENCODE_VERSION: "1.17.13",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", chunk => { output += chunk; });
  proc.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(proc.exitCode, null, output);
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
        healthy = response.ok && (await response.json()).healthy;
        if (healthy) break;
      } catch {}
      await delay(50);
    }
    assert.equal(healthy, true, output);
    const response = await fetch(`${base}/v1/invocations`, { method: "POST", signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 401);
    await response.body.cancel();
    proc.kill("SIGTERM");
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.equal(output.includes(token), false);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
