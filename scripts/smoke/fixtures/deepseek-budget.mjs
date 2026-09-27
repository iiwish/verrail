// Opt-in paid acceptance fixture. No application credentials enter the harness.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function admitDeepSeekRequest(input, reserved) {
  if (!Number.isInteger(reserved) || reserved < 0 || reserved >= 10) throw new Error("budget exhausted");
  if (!input || input.model !== "deepseek-flash") throw new Error("model not admitted");
  if (!Array.isArray(input.messages) || Buffer.byteLength(JSON.stringify(input)) > 131072) throw new Error("input limit");
  const fields = new Set(["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options",
    "temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "frequency_penalty", "presence_penalty", "response_format"]);
  if (Object.keys(input).some(key => !fields.has(key))) throw new Error("field not admitted");
  const limit = input.max_tokens ?? input.max_completion_tokens ?? 2048;
  if (!Number.isInteger(limit) || limit < 1 || limit > 2048) throw new Error("output limit");
  const { max_completion_tokens: ignored, ...body } = input;
  return { ...body, max_tokens: limit, thinking: { type: "disabled" },
    ...(input.stream ? { stream_options: { include_usage: true } } : {}) };
}

export function startBudgetProxy({ key, token, ledgerPath, host = "127.0.0.1", port = 0, upstream = fetch, onRefusal = () => {} }) {
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath)) : { version: 1, budgetCny: 10, reservedCny: 0, calls: [] };
  if (!key || !token || ledger.version !== 1 || ledger.budgetCny !== 10 || !Array.isArray(ledger.calls)
    || !Number.isInteger(ledger.reservedCny) || ledger.reservedCny < 0 || ledger.reservedCny > 10
    || ledger.reservedCny !== ledger.calls.length) throw new Error("Invalid budget ledger or credentials");
  let persistenceFailed = false;
  const persist = () => {
    const temporary = `${ledgerPath}.pending`;
    const fd = openSync(temporary, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(ledger, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, ledgerPath);
    const directory = openSync(dirname(ledgerPath), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const server = createServer(async (request, response) => {
    if (request.url === "/health" && request.method === "GET") { response.end('{"ok":true}'); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") { response.writeHead(404).end(); return; }
    let call;
    let shape;
    try {
      if (persistenceFailed) throw new Error("ledger unavailable");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 131072) throw new Error("input limit");
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(raw);
      shape = { fields: Object.keys(parsed), outputLimit: parsed.max_tokens ?? parsed.max_completion_tokens ?? null };
      const body = admitDeepSeekRequest(parsed, ledger.reservedCny);
      // Reserve CNY 1 per <=128 KiB / <=2048-output-token call, without refund.
      // This is deliberately above the official Flash peak-price upper estimate.
      call = { sequence: ledger.calls.length + 1, status: "reserved", at: new Date().toISOString(),
        inputBytes: Buffer.byteLength(raw), inputHash: createHash("sha256").update(raw).digest("hex") };
      ledger.reservedCny += 1;
      ledger.calls.push(call);
      persist();
      const remote = await upstream("https://api.deepseek.com/chat/completions", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body),
      });
      call.httpStatus = remote.status;
      if (!remote.ok) {
        await remote.body?.cancel();
        call.status = "provider_rejected"; persist();
        response.writeHead(502, { "content-type": "application/json" }).end('{"error":{"message":"Provider rejected bounded acceptance request"}}');
        return;
      }
      response.writeHead(200, { "content-type": remote.headers.get("content-type") ?? "application/json" });
      const output = [];
      let outputBytes = 0;
      for await (const chunk of remote.body) {
        outputBytes += chunk.length;
        if (outputBytes > 2 * 1024 * 1024) throw new Error("response limit");
        output.push(Buffer.from(chunk));
        if (!response.destroyed) response.write(chunk);
      }
      const transcript = Buffer.concat(output).toString("utf8");
      const objects = body.stream ? transcript.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
        .flatMap(line => { try { return [JSON.parse(line.slice(6))]; } catch { return []; } }) : [JSON.parse(transcript)];
      const usage = objects.findLast(value => value.usage)?.usage;
      call.usage = usage ? Object.fromEntries(Object.entries(usage).filter(([name, value]) =>
        ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"].includes(name)
        && Number.isSafeInteger(value) && value >= 0)) : null;
      call.status = "completed"; persist();
      response.end();
    } catch (error) {
      const reasons = ["budget exhausted", "model not admitted", "input limit", "field not admitted", "output limit", "ledger unavailable"];
      onRefusal({ code: reasons.includes(error.message) ? error.message : "transport_or_persistence_failed", shape });
      if (call) {
        call.status = "uncertain_charged_reservation";
        try { persist(); } catch { persistenceFailed = true; }
      }
      if (!response.headersSent) response.writeHead(429, { "content-type": "application/json" });
      response.end('{"error":{"message":"Bounded acceptance request refused or interrupted"}}');
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(port, host);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const key = readFileSync(process.env.VERRAIL_DEEPSEEK_KEY_FILE, "utf8").trim();
  const token = readFileSync(process.env.VERRAIL_BUDGET_TOKEN_FILE, "utf8").trim();
  if (!key || !token) throw new Error("Missing private acceptance configuration");
  startBudgetProxy({ key, token, ledgerPath: process.env.VERRAIL_BUDGET_LEDGER,
    host: process.env.VERRAIL_BUDGET_HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 8080),
    onRefusal: value => process.stderr.write(JSON.stringify(value) + "\n") });
}
