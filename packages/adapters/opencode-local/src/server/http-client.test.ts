import { describe, expect, it, vi } from "vitest";
import { createOpenCodeHttpClient } from "./http-client.js";

const options = { url: "http://opencode:4096", password: "test-only-password", directory: "/workspaces/run-1", version: "1.2.3" };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("OpenCode HTTP transport", () => {
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
    const event = (sessionID: string, delta: string) => `data: ${JSON.stringify({ type: "message.part.delta", properties: { sessionID, field: "text", delta } })}\n\n`;
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
