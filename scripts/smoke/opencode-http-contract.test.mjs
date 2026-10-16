import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createOpenCodeHttpClient } from "../../packages/adapters/opencode-local/src/server/http-client.ts";

test("pinned OpenCode HTTP contract with a local fake model provider", {
  skip: process.env.VERRAIL_TEST_OPENCODE_HTTP !== "1",
  timeout: 60_000,
}, async () => {
  const expectedVersion = "1.17.13";
  const home = await mkdtemp(join(tmpdir(), "verrail-opencode-contract-"));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const password = randomBytes(32).toString("hex");
  const providerRequests = [];
  const provider = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    providerRequests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(frame({ role: "assistant", content: "Fixture response" }));
    res.write(frame({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = provider.address().port;
  const proc = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { "*": "deny" }, share: "disabled", enabled_providers: ["fixture"],
        model: "fixture/test", small_model: "fixture/test",
        provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Local contract fixture",
          options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "fixture-not-a-real-key" },
          models: { test: { name: "Test", limit: { context: 32000, output: 1000 } } },
        } },
      }),
    },
    stdio: "ignore",
    detached: process.platform !== "win32",
  });
  let spawnError;
  proc.on("error", error => { spawnError = error; });
  const closed = new Promise(resolve => proc.once("close", resolve));
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "Content-Type": "application/json" };
  const request = (path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers, redirect: "error", signal: AbortSignal.timeout(5000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (proc.exitCode !== null) throw new Error("OpenCode exited before ready");
      try {
        const response = await request("/global/health");
        if (response.ok) { health = await response.json(); break; }
      } catch { /* The process has not bound its socket yet. */ }
      await delay(200);
    }
    assert.deepEqual(health, { healthy: true, version: expectedVersion });
    const unauthenticated = await fetch(`${base}/session`, { signal: AbortSignal.timeout(5000) });
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.body?.cancel();
    const response = await request("/session", "POST", { permission: [{ permission: "*", pattern: "*", action: "deny" }] });
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.match(session.id, /^ses_[A-Za-z0-9]+$/);
    assert.deepEqual(session.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
    const read = await request(`/session/${session.id}`);
    assert.deepEqual((await read.json()).permission, session.permission);
    const otherDirectory = join(home, "other-workspace");
    await mkdir(otherDirectory);
    const crossDirectory = await request(`/session/${session.id}?directory=${encodeURIComponent(otherDirectory)}`);
    assert.equal(crossDirectory.status, 200, "Directory selection is not an authorization boundary");
    assert.equal((await crossDirectory.json()).id, session.id);
    const eventAbort = new AbortController();
    const eventsResponse = await fetch(`${base}/event`, { headers, signal: eventAbort.signal });
    assert.equal(eventsResponse.status, 200);
    const events = [];
    const consumeEvents = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of eventsResponse.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
        }
      } catch (error) { if (!eventAbort.signal.aborted) throw error; }
    })();
    try {
    const completion = await request(`/session/${session.id}/message`, "POST", {
      model: { providerID: "fixture", modelID: "test" },
      system: "Reply using the configured fixture model only.",
      parts: [{ type: "text", text: "Hello" }],
    });
    assert.equal(completion.status, 200);
    const message = await completion.json();
    assert.equal(message.info.role, "assistant");
    assert.equal(message.info.error, undefined);
    assert.equal(message.parts.filter(part => part.type === "text").map(part => part.text).join(""), "Fixture response");
    assert.ok(providerRequests.length > 0);
    assert.ok(providerRequests.every(body => !(body.tools ?? []).some(tool => ["bash", "edit", "write"].includes(tool.function?.name))), "Denied tools must not be offered to the model");
    for (let attempt = 0; attempt < 20 && !events.some(event => event.type === "message.part.delta"); attempt++) await delay(25);
    const deltas = events.filter(event => event.type === "message.part.delta" && event.properties.sessionID === session.id && event.properties.field === "text");
    assert.equal(deltas.map(event => event.properties.delta).join(""), "Fixture response");
    } finally {
      eventAbort.abort();
      await consumeEvents;
    }
    const abort = await request(`/session/${session.id}/abort`, "POST");
    assert.equal(await abort.json(), true);
    const deletion = await request(`/session/${session.id}`, "DELETE");
    assert.equal(await deletion.json(), true);
    const client = createOpenCodeHttpClient({ url: base, password, directory: home, version: expectedVersion });
    const clientSession = await client.createSession();
    const clientDeltas = [];
    const subscription = await client.subscribeText(clientSession, text => { clientDeltas.push(text); });
    try {
      const reply = await client.prompt(clientSession, { model: "fixture/test", system: "Fixture only", prompt: "Hello" });
      assert.equal(reply, "Fixture response");
      for (let attempt = 0; attempt < 20 && clientDeltas.join("") !== reply; attempt++) await delay(25);
      assert.equal(clientDeltas.join(""), reply);
      await client.abort(clientSession);
    } finally {
      subscription.close();
      await subscription.done;
      await request(`/session/${clientSession}`, "DELETE");
    }
  } finally {
    if (proc.pid) {
      try { process.kill(process.platform === "win32" ? proc.pid : -proc.pid, "SIGTERM"); } catch {}
      const timer = setTimeout(() => {
        try { process.kill(process.platform === "win32" ? proc.pid : -proc.pid, "SIGKILL"); } catch {}
      }, 2000);
      await closed;
      clearTimeout(timer);
    }
    await rm(home, { recursive: true, force: true });
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  }
});
