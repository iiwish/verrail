import { describe, expect, it, vi } from "vitest";
import { createOpenCodeHttpClient } from "./http-client.js";

const options = { url: "http://opencode:4096", password: "test-only-password", directory: "/workspaces/run-1", version: "1.2.3" };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("OpenCode HTTP transport", () => {
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
