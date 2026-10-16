import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createExecutionGatewayApp } from "./gateway-http.js";

describe("private execution gateway HTTP", () => {
  it("authenticates before parsing or dispatch and hides internal failures", async () => {
    const store = { healthy: () => true, submit: vi.fn(), read: vi.fn(), cancel: vi.fn(), drain: vi.fn(), close: vi.fn() };
    const token = "test-private-gateway-token-0123456789";
    const app = createExecutionGatewayApp(store, token);
    expect((await request(app).post("/v1/invocations").send({})).status).toBe(401);
    expect(store.submit).not.toHaveBeenCalled();
    const oversized = await request(app).post("/v1/invocations").set("Authorization", `Bearer ${token}`).send({ prompt: "x".repeat(2 * 1024 * 1024) });
    expect(oversized.status).toBe(413);
    expect(store.submit).not.toHaveBeenCalled();
    const invalid = await request(app).post("/v1/invocations").set("Authorization", `Bearer ${token}`).send({ directorToken: "secret-should-not-appear", command: "sh" });
    expect(invalid.status).toBe(400);
    expect(invalid.text).not.toContain("secret-should-not-appear");
    store.read.mockRejectedValue(new Error("internal secret diagnostic"));
    const failure = await request(app).get(`/v1/invocations/${randomUUID()}?workspaceId=${randomUUID()}`).set("Authorization", `Bearer ${token}`);
    expect(failure.status).toBe(500);
    expect(failure.text).not.toContain("internal secret");
  });
});
