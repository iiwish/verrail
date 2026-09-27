import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitDeepSeekRequest, startBudgetProxy } from "./fixtures/deepseek-budget.mjs";

test("paid smoke pins Flash, bounds input and output, and reserves budget before calling", () => {
  const request = admitDeepSeekRequest({ model: "deepseek-flash", messages: [{ role: "user", content: "hello" }], stream: true }, 0);
  assert.equal(request.model, "deepseek-flash");
  assert.equal(request.max_tokens, 2048);
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.equal(request.stream_options.include_usage, true);
  assert.throws(() => admitDeepSeekRequest({ model: "deepseek-v4-pro", messages: [] }, 0), /model/);
  assert.throws(() => admitDeepSeekRequest({ model: "deepseek-flash", messages: [] }, 10), /budget/);
  assert.throws(() => admitDeepSeekRequest({ model: "deepseek-flash", messages: [{ role: "user", content: "a".repeat(131073) }] }, 0), /input/);
  assert.throws(() => admitDeepSeekRequest({ model: "deepseek-flash", messages: [], max_tokens: 100000 }, 0), /output/);
  assert.throws(() => admitDeepSeekRequest({ model: "deepseek-flash", messages: [], max_tokens: -1 }, 0), /output/);
  assert.throws(() => admitDeepSeekRequest({ model: "deepseek-flash", messages: [], base_url: "https://example.test" }, 0), /field/);
});

test("proxy authenticates, persists before spend, retains reservations across restart, and excludes content", async t => {
  const directory = mkdtempSync(join(tmpdir(), "verrail-budget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "ledger.json");
  let requests = 0;
  const options = { key: "provider-test-secret", token: "runtime-test-secret", ledgerPath, upstream: async (url, init) => {
    requests++;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(init.headers.authorization, "Bearer provider-test-secret");
    assert.equal(JSON.parse(readFileSync(ledgerPath)).reservedCny, requests);
    return new Response(JSON.stringify({ choices: [{ message: { content: "private model content" } }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, sensitive: "not retained" } }));
  } };
  let server = startBudgetProxy(options);
  t.after(() => server.close());
  await once(server, "listening");
  const send = (token = options.token) => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "private prompt content" }] }),
  });
  assert.equal((await send("wrong")).status, 401);
  assert.equal(requests, 0);
  for (let i = 0; i < 10; i++) assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);
  await new Promise(resolve => server.close(resolve));
  server = startBudgetProxy(options);
  await once(server, "listening");
  assert.equal((await send()).status, 429);
  assert.equal(requests, 10);
  const stored = readFileSync(ledgerPath, "utf8");
  assert.doesNotMatch(stored, /secret|private|sensitive/);
  assert.deepEqual(JSON.parse(stored).calls[0].usage, { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 });
});

test("a failed durable reservation cannot reach the provider", async t => {
  const directory = mkdtempSync(join(tmpdir(), "verrail-budget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ version: 1, budgetCny: 10, reservedCny: -1, calls: [] }));
  assert.throws(() => startBudgetProxy({ key: "x", token: "y", ledgerPath }), /Invalid/);
  rmSync(ledgerPath);
  let calls = 0;
  const server = startBudgetProxy({ key: "x", token: "y", ledgerPath, upstream: () => { calls++; throw new Error("must not run"); } });
  t.after(() => server.close());
  await once(server, "listening");
  rmSync(directory, { recursive: true });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer y" }, body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
    });
    assert.equal(response.status, 429);
  }
  assert.equal(calls, 0);
});
