import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createOpenCodeHttpClient } from "./http-client.js";

const options = { url: "http://opencode:4096", password: "test-only-password", directory: "/workspaces/run-1", version: "1.2.3" };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("OpenCode HTTP transport", () => {
  const factOptions = { ...options, version: "1.17.13" };
  const now = Date.now();
  const tokens = (input: number, output: number) => ({ total: input + output, input, output, reasoning: 0, cache: { read: 0, write: 0 } });
  const assistant = (id: string, cost: number, steps: { input: number; output: number }[]) => ({
    info: { id, role: "assistant", sessionID: "ses_123", parentID: "msg_user", providerID: "provider", modelID: "model",
      time: { created: now - 50, completed: now - 10 }, finish: id === "msg_final" ? "stop" : "tool-calls", cost },
    parts: steps.flatMap((step, index) => [
      { type: "step-start", id: `prt_${id.replace("_", "")}${index}start`, sessionID: "ses_123", messageID: id },
      { type: "step-finish", id: `prt_${id.replace("_", "")}${index}finish`, sessionID: "ses_123", messageID: id,
        reason: id === "msg_final" ? "stop" : "tool-calls", tokens: tokens(step.input, step.output), cost: cost / steps.length },
    ]),
  });
  const history = () => [
    { info: { id: "msg_user", role: "user", sessionID: "ses_123", time: { created: now - 60 }, model: { providerID: "provider", modelID: "model" } }, parts: [] },
    assistant("msg_tool", 0.04, [{ input: 10, output: 3 }, { input: 20, output: 4 }]),
    assistant("msg_final", 0.03, [{ input: 30, output: 5 }]),
  ];
  const factsClient = async (messages: unknown, headers: HeadersInit = {}) => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.17.13" }))
      .mockResolvedValueOnce(json({ id: "ses_123", time: { created: now - 100 } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(messages), { headers: { "Content-Type": "application/json", ...headers } }));
    const client = createOpenCodeHttpClient({ ...factOptions, fetch }); await client.createSession(); return { client, fetch };
  };

  it("collects all messages and every step, rather than the last assistant usage", async () => {
    const { client, fetch } = await factsClient(history());
    const facts = await client.collectExecutionFacts("ses_123", { model: "provider/model", finalMessageId: "msg_final" });
    expect(facts).toMatchObject({ runtimeVersion: "1.17.13", sessionId: "ses_123", messageId: "msg_final", model: "provider/model",
      usageStatus: "complete", usage: { total: 72, input: 60, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
      costStatus: "unavailable", costBasis: "opencode-estimate", reportedCostUsd: 0.07 });
    expect(facts.messages).toHaveLength(3); expect(facts.messages.flatMap(message => message.steps)).toHaveLength(3);
    expect(facts.fullHistory).toEqual({ sha256: createHash("sha256").update(JSON.stringify(history())).digest("hex"),
      bytes: Buffer.byteLength(JSON.stringify(history())), messageCount: 3, partCount: 6 });
    const url = new URL(String(fetch.mock.calls[2][0])); expect(url.pathname).toBe("/session/ses_123/message"); expect(url.searchParams.has("limit")).toBe(false);
  });

  it("does not present an upstream default zero or absent usage as measured cost or tokens", async () => {
    const messages = history(); const part = messages[1].parts[1] as Record<string, unknown>;
    part.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }; part.cost = 0;
    const { client } = await factsClient(messages);
    const facts = await client.collectExecutionFacts("ses_123", { model: "provider/model", finalMessageId: "msg_final" });
    expect(facts.usageStatus).toBe("unavailable"); expect(facts.usage).toBeNull(); expect(facts.costStatus).toBe("unavailable");
    expect(facts.messages[1].steps[0].tokens.total).toBeNull();
  });

  it.each(["wrong-session", "wrong-model", "duplicate-message", "duplicate-part", "missing-final", "unfinished-step", "unfinished-tool", "missing-completion", "unsafe-usage", "negative-cost", "unknown-parent", "reordered-time", "unfinished-final", "finish-mismatch"])(
    "fails closed on incomplete or inconsistent execution facts: %s", async failure => {
      const messages = history() as Array<{ info: Record<string, any>; parts: Array<Record<string, any>> }>;
      if (failure === "wrong-session") messages[1].info.sessionID = "ses_other";
      if (failure === "wrong-model") messages[1].info.modelID = "different";
      if (failure === "duplicate-message") messages.push(messages[1]);
      if (failure === "duplicate-part") messages[1].parts[1].id = messages[1].parts[0].id;
      if (failure === "missing-final") messages.pop();
      if (failure === "unfinished-step") messages[1].parts.pop();
      if (failure === "unfinished-tool") messages[1].parts.push({ type: "tool", id: "prt_tool", sessionID: "ses_123", messageID: "msg_tool", state: { status: "running" } });
      if (failure === "missing-completion") delete messages[1].info.time.completed;
      if (failure === "unsafe-usage") messages[1].parts[1].tokens.input = Number.MAX_SAFE_INTEGER + 1;
      if (failure === "negative-cost") messages[1].parts[1].cost = -1;
      if (failure === "unknown-parent") messages[1].info.parentID = "msg_missing";
      if (failure === "reordered-time") messages[1].info.time.completed = now - 200;
      if (failure === "unfinished-final") messages[2].info.finish = messages[2].parts[1].reason = "tool-calls";
      if (failure === "finish-mismatch") messages[2].info.finish = "length";
      const { client } = await factsClient(messages);
      await expect(client.collectExecutionFacts("ses_123", { model: "provider/model", finalMessageId: "msg_final" })).rejects.toThrow();
    });

  it.each(["retry", "subtask", "compaction", "unknown-part"])("marks %s accounting incomplete without inventing charges", async type => {
    const messages = history() as Array<{ info: Record<string, any>; parts: Array<Record<string, any>> }>;
    messages[1].parts.push({ type, id: "prt_unaccounted", sessionID: "ses_123", messageID: "msg_tool" });
    const { client } = await factsClient(messages);
    const facts = await client.collectExecutionFacts("ses_123", { model: "provider/model", finalMessageId: "msg_final" });
    expect(facts.usageStatus).toBe("unavailable"); expect(facts.usage).toBeNull(); expect(facts.costStatus).toBe("unavailable");
    expect(facts.messages[1].unaccountedPartTypes).toEqual([type]);
  });

  it("reconciles cached and reasoning tokens while ignoring last-step assistant aggregates", async () => {
    const messages = history() as Array<{ info: Record<string, any>; parts: Array<Record<string, any>> }>;
    messages[1].info.tokens = tokens(9999, 9999);
    messages[1].parts[1].tokens = { total: 13, input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 2 } };
    const { client } = await factsClient(messages);
    const facts = await client.collectExecutionFacts("ses_123", { model: "provider/model", finalMessageId: "msg_final" });
    expect(facts.usage).toEqual({ total: 72, input: 55, output: 11, reasoning: 1, cache: { read: 3, write: 2 } });
  });

  it("rejects excessive message and part counts even within the body limit", async () => {
    for (const messages of [Array.from({ length: 1001 }, () => ({})), [{ ...history()[0], parts: Array.from({ length: 10_001 }, () => ({})) }, history()[2]]]) {
      const { client } = await factsClient(messages);
      await expect(client.collectExecutionFacts("ses_123", { model: "provider/model", finalMessageId: "msg_final" })).rejects.toThrow();
    }
  });

  const runtimeResponses = () => ({
    session: { id: "ses_123", permission: [{ permission: "*", pattern: "*", action: "deny" },
      { permission: "repository_execute_command", pattern: "*", action: "allow" }] },
    config: { model: "provider/model", small_model: "provider/model", share: "disabled", enabled_providers: ["provider"],
      permission: { "*": "deny", repository_execute_command: "allow" }, provider: { provider: { options: { apiKey: "never-persist" } } } },
    paths: { home: options.directory, directory: options.directory, config: `${options.directory}/config/opencode`,
      state: `${options.directory}/state/opencode`, worktree: "/" },
  });
  const witnessClient = async (responses: ReturnType<typeof runtimeResponses>) => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.17.13" }))
      .mockResolvedValueOnce(json({ id: "ses_123" }))
      .mockResolvedValueOnce(json(responses.session)).mockResolvedValueOnce(json(responses.config)).mockResolvedValueOnce(json(responses.paths));
    const client = createOpenCodeHttpClient({ ...factOptions, fetch });
    await client.createSession({ allowedTools: ["repository_execute_command"] }); return { client, fetch };
  };
  it("reads actual session permissions and effective config/paths without persisting secrets or absolute paths", async () => {
    const { client, fetch } = await witnessClient(runtimeResponses());
    const witness = await client.collectRuntimeWitness("ses_123", { model: "provider/model", enabledProviders: ["provider"] });
    expect(witness).toMatchObject({ permissions: { default: "deny", allowedTools: ["repository_execute_command"] },
      configuration: { model: "provider/model", smallModel: "provider/model", share: "disabled", enabledProviders: ["provider"] },
      environment: { homeSha256: createHash("sha256").update(options.directory).digest("hex"), directory: ".",
        config: "config/opencode", state: "state/opencode", worktree: "global" } });
    expect(JSON.stringify(witness)).not.toContain("never-persist"); expect(JSON.stringify(witness)).not.toContain(options.directory);
    expect(fetch.mock.calls.slice(2).map(([url]) => new URL(String(url)).pathname)).toEqual(["/session/ses_123", "/config", "/path"]);
  });
  it.each(["foreign-session", "permission-order", "permission-wildcard", "extra-config-permission", "wrong-model", "extra-provider", "foreign-home", "foreign-state", "foreign-worktree"])(
    "rejects observed runtime witness mismatch: %s", async failure => {
      const responses = runtimeResponses();
      if (failure === "foreign-session") responses.session.id = "ses_foreign";
      if (failure === "permission-order") responses.session.permission.reverse();
      if (failure === "permission-wildcard") responses.session.permission[0].action = "allow";
      if (failure === "extra-config-permission") Object.assign(responses.config.permission, { bash: "allow" });
      if (failure === "wrong-model") responses.config.model = "provider/foreign";
      if (failure === "extra-provider") responses.config.enabled_providers.push("foreign");
      if (failure === "foreign-home") responses.paths.home = "/home/foreign";
      if (failure === "foreign-state") responses.paths.state = `${options.directory}/../foreign`;
      if (failure === "foreign-worktree") responses.paths.worktree = "/other/repository";
      const { client } = await witnessClient(responses);
      await expect(client.collectRuntimeWitness("ses_123", { model: "provider/model", enabledProviders: ["provider"] })).rejects.toThrow();
    });

  it("rejects pagination and oversized full-history responses instead of accepting a truncated total", async () => {
    const { client } = await factsClient(history(), { "X-Next-Cursor": "truncated" });
    await expect(client.collectExecutionFacts("ses_123", { model: "provider/model", finalMessageId: "msg_final" })).rejects.toThrow("pagination");
    const oversized = await factsClient([{ ignored: "x".repeat(2 * 1024 * 1024) }]);
    await expect(oversized.client.collectExecutionFacts("ses_123", { model: "provider/model", finalMessageId: "msg_final" })).rejects.toThrow("limit");
  });

  it.each([undefined, 900_000])("bounds prompt and stream with the configured execution deadline: %s", async executionTimeoutMs => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("deadline")), ms);
      return controller.signal;
    });
    try {
      const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" }))
        .mockResolvedValueOnce(json({ id: "ses_123" }))
        .mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({
          start(controller) { init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true }); },
        }), { headers: { "Content-Type": "text/event-stream" } }))
        .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }));
      const client = createOpenCodeHttpClient({ ...options, executionTimeoutMs, fetch });
      const id = await client.createSession();
      const stream = await client.subscribeText(id, () => {});
      const failedStream = expect(stream.done).rejects.toThrow("deadline");
      const failedPrompt = expect(client.prompt(id, { model: "provider/model", system: "rules", prompt: "hello" })).rejects.toThrow("deadline");
      const signals = [fetch.mock.calls[2][1].signal, fetch.mock.calls[3][1].signal];
      const budget = executionTimeoutMs ?? 120_000;
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(signals.every(signal => !signal.aborted)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await failedStream;
      await failedPrompt;
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([120_000, 120_000, budget, budget]);
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 3_600_001])("rejects invalid execution timeout %s", executionTimeoutMs => {
    expect(() => createOpenCodeHttpClient({ ...options, executionTimeoutMs })).toThrow("timeout");
  });

  it.each(["health", "session"])("cancels during %s setup without waiting for its control timeout", async phase => {
    const controller = new AbortController();
    const fetch = vi.fn(async (url, init) => {
      if (phase === "session" && String(url).includes("/global/health")) return json({ healthy: true, version: "1.2.3" });
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        controller.abort(new Error("run canceled"));
      });
    });
    await expect(createOpenCodeHttpClient({ ...options, fetch }).createSession({}, controller.signal)).rejects.toThrow("run canceled");
    expect(fetch).toHaveBeenCalledTimes(phase === "session" ? 2 : 1);
  });

  it("checks the pinned version and creates a deny-by-default session", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" })).mockResolvedValueOnce(json({ id: "ses_123" }));
    const client = createOpenCodeHttpClient({ ...options, fetch });
    expect(await client.createSession()).toBe("ses_123");
    const [url, request] = fetch.mock.calls[1];
    expect(String(url)).toBe("http://opencode:4096/session?directory=%2Fworkspaces%2Frun-1");
    expect(request.redirect).toBe("error");
    expect(JSON.parse(request.body)).toEqual({ permission: [{ permission: "*", pattern: "*", action: "deny" }] });
    expect(request.headers.Authorization).toMatch(/^Basic /);
  });

  it("rejects an unexpected harness version before creating a session", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ healthy: true, version: "9.9.9" }));
    await expect(createOpenCodeHttpClient({ ...options, fetch }).createSession()).rejects.toThrow("version");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects session IDs not allocated by this client", async () => {
    const fetch = vi.fn();
    const client = createOpenCodeHttpClient({ ...options, fetch });
    await expect(client.abort("ses_other")).rejects.toThrow("session");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not echo upstream error bodies or credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("secret upstream diagnostic", { status: 401 }));
    await expect(createOpenCodeHttpClient({ ...options, fetch }).createSession()).rejects.toThrow("OpenCode HTTP 401");
  });

  it("validates startup configuration", () => {
    for (const overrides of [{ url: "file:///etc/passwd" }, { url: "http://user:secret@host" }, { url: "http://host?token=x" }, { directory: "../escape" }, { password: "" }, { version: "latest" }]) {
      expect(() => createOpenCodeHttpClient({ ...options, ...overrides })).toThrow();
    }
  });

  it("validates session IDs from the untrusted upstream", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" })).mockResolvedValueOnce(json({ id: "../../config" }));
    await expect(createOpenCodeHttpClient({ ...options, fetch }).createSession()).rejects.toThrow("session");
  });

  it("sends the fixed model and distinguishes failed assistant results", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" })).mockResolvedValueOnce(json({ id: "ses_123" })).mockResolvedValueOnce(json({ info: { role: "assistant", error: { name: "ProviderError" } }, parts: [] }));
    const client = createOpenCodeHttpClient({ ...options, fetch });
    const id = await client.createSession();
    await expect(client.prompt(id, { model: "provider/model", system: "rules", prompt: "hello" })).rejects.toThrow("execution failed");
    expect(JSON.parse(fetch.mock.calls[2][1].body).model).toEqual({ providerID: "provider", modelID: "model" });
  });

  it("streams only text deltas for the allocated session", async () => {
    const event = (sessionID: string, delta: string) => `data: ${JSON.stringify({ type: "message.part.delta", properties: { sessionID, messageID: "msg_123", field: "text", delta } })}\n\n`;
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" })).mockResolvedValueOnce(json({ id: "ses_123" }))
      .mockResolvedValueOnce(new Response(event("ses_other", "private") + event("ses_123", "hello"), { headers: { "Content-Type": "text/event-stream" } }));
    const client = createOpenCodeHttpClient({ ...options, fetch });
    const id = await client.createSession();
    const chunks: string[] = [];
    const stream = await client.subscribeText(id, text => { chunks.push(text); });
    await stream.done;
    expect(chunks).toEqual(["hello"]);
    stream.close();
  });

  it("retains message identity when tool rounds produce separate assistant messages", async () => {
    const event = (messageID: string, delta: string) => `data: ${JSON.stringify({ type: "message.part.delta",
      properties: { sessionID: "ses_123", messageID, field: "text", delta } })}\n\n`;
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" }))
      .mockResolvedValueOnce(json({ id: "ses_123" }))
      .mockResolvedValueOnce(new Response(event("msg_tool", "Working") + event("msg_final", "Done"),
        { headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(json({ info: { id: "msg_final", sessionID: "ses_123", role: "assistant" },
        parts: [{ type: "text", text: "Done" }] }));
    const client = createOpenCodeHttpClient({ ...options, fetch });
    const id = await client.createSession();
    const chunks: { text: string; messageId: string }[] = [];
    const stream = await client.subscribeText(id, (text, messageId) => { chunks.push({ text, messageId }); });
    await stream.done;
    expect(chunks).toEqual([{ text: "Working", messageId: "msg_tool" }, { text: "Done", messageId: "msg_final" }]);
    expect(await client.promptMessage(id, { model: "provider/model", system: "rules", prompt: "hello" }))
      .toEqual({ messageId: "msg_final", text: "Done" });
  });

  it.each([{ id: "msg_123", sessionID: "ses_other" }, { id: "../bad", sessionID: "ses_123" }])(
    "rejects a final message outside the allocated identity: %j", async info => {
      const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" }))
        .mockResolvedValueOnce(json({ id: "ses_123" }))
        .mockResolvedValueOnce(json({ info: { ...info, role: "assistant" }, parts: [{ type: "text", text: "unexpected" }] }));
      const client = createOpenCodeHttpClient({ ...options, fetch });
      const id = await client.createSession();
      await expect(client.promptMessage(id, { model: "provider/model", system: "rules", prompt: "hello" })).rejects.toThrow("identity");
    });

  it("rejects non-SSE event responses", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" })).mockResolvedValueOnce(json({ id: "ses_123" })).mockResolvedValueOnce(json({}));
    const client = createOpenCodeHttpClient({ ...options, fetch });
    const id = await client.createSession();
    await expect(client.subscribeText(id, () => {})).rejects.toThrow("event stream");
  });

  it("closes a pending event stream without leaking AbortError from reader cleanup", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ healthy: true, version: "1.2.3" })).mockResolvedValueOnce(json({ id: "ses_123" }))
      .mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({
        start(controller) { init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true }); },
      }), { headers: { "Content-Type": "text/event-stream" } }));
    const client = createOpenCodeHttpClient({ ...options, fetch });
    const id = await client.createSession();
    const stream = await client.subscribeText(id, () => {});
    stream.close();
    await expect(stream.done).resolves.toBeUndefined();
  });
});
