import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createExecutionGatewayClient } from "./gateway-client.js";

describe("execution gateway client", () => {
  it("authenticates and rejects foreign or discontinuous replay", async () => {
    const id = randomUUID();
    const workspace = randomUUID();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const token = "fixture-private-gateway-token-0123456789";
    const client = createExecutionGatewayClient({ url: "http://gateway:4096", token, fetch });
    const replay = { invocationId: id, status: "running", lastEventCursor: 1, events: [{ cursor: 1, at: new Date().toISOString(), event: { type: "start", data: {} } }] };
    fetch.mockResolvedValueOnce(Response.json(replay));
    expect((await client.read(workspace, id)).events).toHaveLength(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: `Bearer ${token}` } });
    fetch.mockResolvedValueOnce(Response.json({ ...replay, invocationId: randomUUID() }));
    await expect(client.read(workspace, id)).rejects.toThrow("mismatch");
    fetch.mockResolvedValueOnce(Response.json(replay));
    await expect(client.read(workspace, id, 1)).rejects.toThrow("mismatch");
    fetch.mockResolvedValueOnce(new Response("private internal diagnostic", { status: 503 }));
    await expect(client.read(workspace, id)).rejects.toMatchObject({ status: 503, message: "Execution gateway request failed" });
  });
});
