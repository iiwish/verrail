import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDirectorInvocationTokens } from "./director-invocation-auth.js";

describe("Director invocation tokens", () => {
  it("binds immutable invocation identity, survives process recreation, and expires", () => {
    let now = 1000;
    const key = "test-signing-key-never-a-provider-key-0123456789";
    const tokens = createDirectorInvocationTokens(key, () => now);
    const invocationId = randomUUID();
    const workspaceId = randomUUID();
    const token = tokens.issue(invocationId, workspaceId);
    expect(createDirectorInvocationTokens(key, () => now).verify(token)).toMatchObject({ invocationId, workspaceId });
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ invocationId, workspaceId: randomUUID(), expires: 121000 })).toString("base64url");
    expect(() => tokens.verify(`${forged}.${signature}`)).toThrow();
    expect(() => tokens.verify(`${token}.extra`)).toThrow();
    expect(() => createDirectorInvocationTokens(`${key}-different`, () => now).verify(token)).toThrow();
    now = 121000;
    expect(() => tokens.verify(token)).toThrow();
  });
});
