import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { sampleConnections } from "./fixtures/sample-connections.mjs";

test("release Compose starts privately with disabled signup and a bootstrapped operator", {
  skip: process.env.VERRAIL_TEST_MACO_COMPOSE !== "1",
  timeout: 360_000,
}, async t => {
  const docker = (args, options = {}) => spawnSync("docker", args, {
    encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
  const checked = (args, options) => {
    const result = docker(args, options);
    assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT, "Do not override the local Docker context");
  const context = JSON.parse(checked(["context", "inspect"]));
  assert.match(context[0].Endpoints.docker.Host, /^unix:\/\//);
  const name = `verrail-compose-fixture-${randomUUID().slice(0, 8)}`;
  const directory = mkdtempSync(path.join(os.tmpdir(), name));
  const password = randomUUID();
  const images = {
    VERRAIL_CONTROL_IMAGE: process.env.VERRAIL_TEST_CONTROL_IMAGE ?? "verrail-control-plane:local-check",
    VERRAIL_DOMAIN_IMAGE: process.env.VERRAIL_TEST_DOMAIN_IMAGE ?? "verrail-domain:local-check",
    VERRAIL_GATEWAY_IMAGE: process.env.VERRAIL_TEST_GATEWAY_IMAGE ?? "verrail-gateway:local-check",
    VERRAIL_TEMPORAL_IMAGE: process.env.VERRAIL_TEST_TEMPORAL_IMAGE ?? "verrail-temporal:local-check",
  };
  const postgres = process.env.VERRAIL_TEST_POSTGRES_IMAGE ?? "postgres:17-alpine";
  for (const image of [...Object.values(images), postgres]) checked(["image", "inspect", image]);
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ...images, VERRAIL_PUBLIC_URL: origin,
    VERRAIL_ALLOWED_HOSTNAMES: "127.0.0.1", VERRAIL_PRIVATE_PORT: String(port), VERRAIL_CHAT_MODEL: "fixture/test" };
  const file = path.join(directory, "compose.json");
  const bootstrapFile = path.join(directory, "bootstrap.json");
  const compose = (...args) => ["compose", "-p", name, "-f", file, ...args];
  const provision = (command) => checked(["run", "--rm", "--pull", "never", "--network", "none",
    "--read-only", "--user", "0:0", "--entrypoint", "python3", "--mount",
    `type=bind,source=${directory},target=/fixture`, images.VERRAIL_CONTROL_IMAGE, "-c", command]);
  try {
    const normalized = JSON.parse(checked(["compose", "-f", "docker/maco/compose.yaml", "config", "--format", "json"], { env }));
    const bootstrap = JSON.parse(checked(["compose", "-f", "docker/maco/compose.yaml", "-f",
      "docker/maco/bootstrap.compose.yaml", "config", "--format", "json"], { env }));
    const sources = new Map();
    for (const service of Object.values(normalized.services)) {
      for (const volume of service.volumes ?? []) {
        const source = volume.source;
        if (!sources.has(source)) {
          assert.match(source, /^\/opt\/(maco-ops\/secrets|maco-apps)\/verrail\/test\//);
          const target = path.join(directory, `mount-${sources.size}`);
          sources.set(source, target);
          if (source.includes("/data/")) mkdirSync(target, { mode: 0o700 });
          else {
            let content = randomUUID();
            if (source.endsWith(".env")) content = `PGHOST=postgresql\nPGPORT=5432\nPGDATABASE=verrail_test\nPGUSER=verrail_test_${source.includes("migration/") ? "migrator" : "app"}\nPGPASSWORD=${password}\n`;
            if (source.endsWith("providers.json")) content = JSON.stringify({ fixture: {
              npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: "http://fixture-provider:8080/v1", apiKey: "fixture-only" },
              models: { test: { name: "Test", limit: { context: 32000, output: 1000 } } },
            } });
            writeFileSync(target, content, { mode: 0o600 });
          }
        }
      }
    }
    for (const config of [normalized, bootstrap]) {
      config.name = name;
      config.networks.runtime = { ...config.networks.runtime, name: `${name}-runtime` };
      config.networks["1panel-network"] = { name: `${name}-db`, external: true };
      for (const service of Object.values(config.services)) {
        for (const volume of service.volumes ?? []) volume.source = sources.get(volume.source);
      }
    }
    writeFileSync(file, JSON.stringify(normalized), { mode: 0o600 });
    writeFileSync(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
    // Change ownership only inside this fresh fixture, never a project/server path.
    provision("import os\nfor n in os.listdir('/fixture'):\n if n.startswith('mount-'): os.chown('/fixture/'+n,1000,1000)");
    checked(["network", "create", "--internal", `${name}-db`]);
    checked(["run", "-d", "--pull", "never", "--name", `${name}-postgres`, "--network", `${name}-db`,
      "--network-alias", "postgresql", "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_PASSWORD", postgres], {
      env: { ...process.env, POSTGRES_PASSWORD: password },
    });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (docker(["exec", `${name}-postgres`, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).status === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, "Fixture PostgreSQL did not start");
    checked(["exec", "-i", `${name}-postgres`, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], {
      input: `CREATE ROLE verrail_test_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE verrail_test_app LOGIN PASSWORD '${password}' CONNECTION LIMIT 20;
        CREATE DATABASE verrail_test OWNER verrail_test_migrator;
        REVOKE ALL ON DATABASE verrail_test FROM PUBLIC;
        GRANT CONNECT ON DATABASE verrail_test TO verrail_test_app;`,
    });
    checked(compose("run", "--rm", "--no-deps", "-T", "migrate"), { timeout: 90_000 });
    const input = JSON.stringify({ name: "Fixture Operator", email: "operator@example.test", password });
    const created = JSON.parse(checked(["compose", "-p", name, "-f", bootstrapFile,
      "run", "--rm", "--no-deps", "-T", "migrate"], { input }));
    assert.equal(created.status, "created");
    checked(compose("up", "-d", "--pull", "never", "--wait", "--wait-timeout", "150"), { timeout: 180_000 });
    checked(["run", "-d", "--pull", "never", "--name", `${name}-provider`, "--network", `${name}-runtime`,
      "--network-alias", "fixture-provider", "--read-only", "--user", "1000:1000", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--entrypoint", "node", "--mount",
      `type=bind,source=${path.resolve("scripts/smoke/fixtures/compose-provider.mjs")},target=/fixture.mjs,readonly`,
      images.VERRAIL_CONTROL_IMAGE, "/fixture.mjs"]);
    const states = checked(compose("ps", "--all", "--format", "json")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.equal(states.filter(state => state.Health === "healthy").length, 5);
    const request = async (url, options = {}) => {
      try {
        return await fetch(`${origin}${url}`, { signal: AbortSignal.timeout(10_000), ...options,
          headers: { connection: "close", ...options.headers } });
      } catch (error) { throw new Error(`HTTP ${options.method ?? "GET"} ${url} failed`, { cause: error }); }
    };
    // Desktop Docker's host port forward can lag behind in-container health.
    let hostReady = false;
    for (let i = 0; i < 20; i++) {
      try { if ((await request("/api/health")).ok) { hostReady = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(hostReady, `Published endpoint unavailable: ${checked(compose("port", "control-plane", "3100"))}`);
    assert.equal((await request("/api/health")).status, 200);
    const anonymous = await request("/api/companies");
    assert.equal(anonymous.status, 403);
    assert.deepEqual(await anonymous.json(), { error: "Board access required" });
    const post = body => ({ method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    assert.equal((await request("/api/auth/sign-up/email", post({ name: "Rejected", email: "signup@example.test", password }))).status, 400);
    const login = await request("/api/auth/sign-in/email", post({ email: "operator@example.test", password }));
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie().map(cookie => cookie.split(";", 1)[0]).join("; ");
    assert.ok(cookies);
    assert.equal((await login.json()).user.id, created.userId);
    assert.equal((await request("/api/companies", { headers: { cookie: cookies } })).status, 200);
    const identity = JSON.parse(checked(compose("exec", "-T", "control-plane", "python3", "/usr/local/lib/verrail/runtime_env.py",
      "node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "--input-type=module", "-", created.userId), {
      input: readFileSync("scripts/smoke/fixtures/compose-conversation-seed.mjs", "utf8"),
    }));
    const invocationUrl = `/api/workspaces/${identity.workspaceId}/conversations/${identity.conversationId}/invocations`;
    const authPost = body => ({ ...post(body), headers: { ...post(body).headers, cookie: cookies } });
    const startInput = { body: "Read my context", idempotencyKey: "compose-context-turn" };
    const start = await request(invocationUrl, authPost(startInput));
    assert.equal(start.status, 202, await start.clone().text());
    const { invocation } = await start.json();
    assert.equal(invocation.agentVersionId, identity.versionId);
    const stream = await request(`${invocationUrl}/${invocation.id}/events`, {
      headers: { cookie: cookies }, signal: AbortSignal.timeout(60_000),
    });
    const transcript = await stream.text();
    assert.match(transcript, /event: chunk/);
    assert.match(transcript, /"status":"succeeded"/);
    const completed = await (await request(`${invocationUrl}/${invocation.id}`, { headers: { cookie: cookies } })).json();
    assert.equal(completed.output, "Context verified");
    const observations = JSON.parse(checked(["exec", `${name}-provider`, "node", "-e",
      "fetch('http://127.0.0.1:8080/observations').then(r=>r.text()).then(t=>process.stdout.write(t))"]));
    assert.match(JSON.stringify(observations.results), /contextVersion/);
    assert.match(JSON.stringify(observations.results), /17/);
    assert.deepEqual([...new Set(observations.tools)].sort(), ["get_conversation_context", "switch_current_target", "list_targets",
      "get_target", "propose_create_target", "propose_target_change"].map(tool => `director_${tool}`).sort());
    const readInvocation = async id => {
      const response = await request(`${invocationUrl}/${id}`, { headers: { cookie: cookies } });
      assert.equal(response.status, 200);
      return response.json();
    };
    const until = async (id, predicate) => {
      const deadline = Date.now() + 45_000;
      let state;
      do {
        state = await readInvocation(id);
        if (predicate(state)) return state;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      assert.fail(`Invocation did not reach expected state: ${JSON.stringify(state)}`);
    };
    const startHold = async key => {
      const response = await request(invocationUrl, authPost({ body: "fixture-hold", idempotencyKey: key }));
      assert.equal(response.status, 202, await response.clone().text());
      const { invocation: held } = await response.json();
      await until(held.id, state => state.output.includes("Working"));
      return held.id;
    };
    const cancelId = await startHold("compose-cancel");
    const disconnect = new AbortController();
    const live = await request(`${invocationUrl}/${cancelId}/events`, { headers: { cookie: cookies }, signal: disconnect.signal });
    await live.body.getReader().read();
    disconnect.abort();
    assert.equal((await readInvocation(cancelId)).status, "running");
    assert.equal((await request(`${invocationUrl}/${cancelId}/cancel`, authPost({}))).status, 202);
    assert.ok((await until(cancelId, state => state.status === "canceled")).finishedAt);

    const interruptedId = await startHold("compose-interrupt");
    checked(compose("kill", "-s", "SIGKILL", "execution-gateway"));
    checked(compose("up", "-d", "--no-deps", "--pull", "never", "--wait", "--wait-timeout", "60", "execution-gateway"), { timeout: 90_000 });
    const interrupted = await until(interruptedId, state => state.status === "failed");
    assert.equal(interrupted.errorCode, "GATEWAY_RESTARTED");
    const recoveringId = await startHold("compose-controller-recovery");
    const providerRequests = () => JSON.parse(checked(["exec", `${name}-provider`, "node", "-e",
      "fetch('http://127.0.0.1:8080/observations').then(r=>r.text()).then(t=>process.stdout.write(t))"])).requests;
    const requestsBeforeRestart = providerRequests();
    checked(compose("exec", "-T", "control-plane", "node", "-e",
      "require('node:fs').writeFileSync('/var/lib/verrail/fixture-persistence','fixture',{mode:0o600})"));
    checked(compose("kill", "-s", "SIGKILL", "control-plane"));
    checked(compose("up", "-d", "--pull", "never", "--wait", "--wait-timeout", "90"), { timeout: 120_000 });
    assert.equal(checked(compose("exec", "-T", "control-plane", "node", "-e",
      "process.stdout.write(require('node:fs').readFileSync('/var/lib/verrail/fixture-persistence','utf8'))")), "fixture");
    assert.equal((await request("/api/companies", { headers: { cookie: cookies } })).status, 200,
      "The original authenticated session must survive a control-plane restart");
    const recoveringReplay = await request(invocationUrl, authPost({ body: "fixture-hold", idempotencyKey: "compose-controller-recovery" }));
    assert.equal(recoveringReplay.status, 200);
    assert.equal((await recoveringReplay.json()).invocation.id, recoveringId);
    assert.equal((await readInvocation(recoveringId)).status, "running");
    assert.equal(providerRequests(), requestsBeforeRestart, "Controller restart must not repeat the model request");
    assert.equal((await request(`${invocationUrl}/${recoveringId}/cancel`, authPost({}))).status, 202);
    assert.ok((await until(recoveringId, state => state.status === "canceled")).finishedAt);
    assert.equal(providerRequests(), requestsBeforeRestart);
    const replay = await request(invocationUrl, authPost(startInput));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).invocation.id, invocation.id);
    assert.equal((await (await request(`${invocationUrl}/${invocation.id}`, { headers: { cookie: cookies } })).json()).output,
      "Context verified");
    const cursorReplay = await request(`${invocationUrl}/${invocation.id}/events`, {
      headers: { cookie: cookies, "Last-Event-ID": String(completed.lastEventCursor) },
    });
    assert.equal(cursorReplay.status, 200);
    assert.equal(await cursorReplay.text(), "", "A fully consumed terminal stream must not resend events after restart");
    const capacity = await sampleConnections(`${name}-postgres`, async () => {
      const urls = identity.capacityConversationIds.map(id => `/api/workspaces/${identity.workspaceId}/conversations/${id}/invocations`);
      const admitted = await Promise.all(urls.slice(0, 3).map(async (url, index) => {
        const response = await request(url, authPost({ body: "fixture-hold", idempotencyKey: `capacity-${index}` }));
        assert.equal(response.status, 202, await response.clone().text());
        return { url, invocation: (await response.json()).invocation };
      }));
      const overflow = await request(urls[3], authPost({ body: "fixture-hold", idempotencyKey: "capacity-overflow" }));
      assert.equal(overflow.status, 409);
      const deadline = Date.now() + 30_000;
      for (const entry of admitted) {
        let state;
        do {
          state = await (await request(`${entry.url}/${entry.invocation.id}`, { headers: { cookie: cookies } })).json();
          if (state.output.includes("Working")) break;
          assert.ok(Date.now() < deadline, `Concurrent execution failed: ${JSON.stringify(state)}`);
          await new Promise(resolve => setTimeout(resolve, 250));
        } while (true);
        assert.equal(state.status, "running");
      }
      await Promise.all(Array.from({ length: 60 }, async () => {
        const response = await request("/api/companies", { headers: { cookie: cookies } });
        assert.equal(response.status, 200);
        await response.json();
      }));
      for (const entry of admitted) {
        assert.equal((await request(`${entry.url}/${entry.invocation.id}/cancel`, authPost({}))).status, 202);
      }
      for (const entry of admitted) {
        const deadline = Date.now() + 15_000;
        let state;
        do {
          state = await (await request(`${entry.url}/${entry.invocation.id}`, { headers: { cookie: cookies } })).json();
          if (state.status === "canceled") break;
          assert.ok(Date.now() < deadline, "Concurrent cancellation did not complete");
          await new Promise(resolve => setTimeout(resolve, 250));
        } while (true);
      }
    });
    assert.equal(capacity.samples, 900);
    assert.ok(capacity.peak > 0 && capacity.peak <= 20, `Aggregate runtime allocation exceeded: ${JSON.stringify(capacity)}`);
    t.diagnostic(`Conversation capacity fixture: ${JSON.stringify(capacity)}`);
  } catch (error) {
    // Fixture-only logs contain no real user/provider credentials.
    const logs = docker(compose("logs", "--no-color", "--tail", "35", "control-plane", "execution-gateway", "domain-api", "orchestration-worker"));
    throw new Error(`${error.message}\n${(logs.stdout ?? "").replaceAll(password, "[redacted]")}`, { cause: error });
  } finally {
    docker(["rm", "-f", `${name}-provider`]);
    docker(compose("down", "--timeout", "10"));
    docker(["rm", "-f", `${name}-postgres`]);
    docker(["network", "rm", `${name}-db`]);
    provision(`import os\nfor root,ds,fs in os.walk('/fixture'):\n for n in ds+fs: os.chown(os.path.join(root,n),${process.getuid()},${process.getgid()})`);
    rmSync(directory, { recursive: true, force: true });
  }
});
