import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { createVerrailDomainApiClient } from "./verrail-domain-api-client.js";

const command = {
  workspaceId: "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0",
  principalType: "user" as const,
  principalId: "user-1",
  idempotencyKey: "target:create:client-test",
  input: {
    projectId: "f52f936d-c5fb-4457-a023-ad062ef667a5",
    title: "Target",
    outcomeOwner: { principalType: "user" as const, principalId: "user-1" },
    goal: "Outcome",
    constraints: [],
    acceptanceCriteria: [{ title: "Accepted" }],
    riskLevel: "medium" as const,
  },
};

describe("Verrail Domain API client", () => {
  it("forwards only the bounded command and trusted Principal context", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      targetId: "b80f266a-87ea-47f0-81bd-c4f04e4d576e",
      targetRevisionId: "0de2d166-850e-4c74-ab63-beb86129b52a",
      workbenchHref: "/targets/b80f266a-87ea-47f0-81bd-c4f04e4d576e/overview",
      replayed: false,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const client = createVerrailDomainApiClient({
      baseUrl: "http://127.0.0.1:3211/",
      token: "secret",
      fetchImpl,
    })!;

    await expect(client.createTarget(command)).resolves.toMatchObject({ replayed: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://127.0.0.1:3211/v1/workspaces/${command.workspaceId}/targets`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "Idempotency-Key": command.idempotencyKey,
          "X-Verrail-Principal-Id": "user-1",
        }),
      }),
    );
  });

  it("preserves stable Domain API conflict details and maps transport failure to retryable 503", async () => {
    const conflictClient = createVerrailDomainApiClient({
      baseUrl: "http://127.0.0.1:3211",
      token: "secret",
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: "Idempotency conflict",
        code: "TARGET_IDEMPOTENCY_CONFLICT",
      }), { status: 409, headers: { "Content-Type": "application/json" } })),
    })!;
    await expect(conflictClient.createTarget(command)).rejects.toMatchObject({
      status: 409,
      details: { code: "TARGET_IDEMPOTENCY_CONFLICT", retryable: false },
    });

    const unavailableClient = createVerrailDomainApiClient({
      baseUrl: "http://127.0.0.1:3211",
      token: "secret",
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
    })!;
    try {
      await unavailableClient.createTarget(command);
      throw new Error("expected unavailable error");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({
        status: 503,
        details: { code: "TARGET_DOMAIN_API_UNAVAILABLE", retryable: true },
      });
    }
  });
});
