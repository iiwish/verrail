import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { createVerrailDomainApiClient } from "./verrail-domain-api-client.js";

const command = {
  workspaceId: "4f9f7195-e5ce-4fd0-b8c7-ed151347e6e0",
  principalType: "user" as const,
  principalId: "user-1",
  idempotencyKey: "target:create:client-test",
  input: {
    collectionId: "f52f936d-c5fb-4457-a023-ad062ef667a5",
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

  it("forwards Agent and Service candidate principals without putting identity in the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      resourceType: "submission",
      resourceId: "b80f266a-87ea-47f0-81bd-c4f04e4d576e",
      replayed: false,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const client = createVerrailDomainApiClient({
      baseUrl: "http://127.0.0.1:3211",
      token: "secret",
      fetchImpl,
    })!;

    await client.createSubmission({
      workspaceId: command.workspaceId,
      principalType: "service",
      principalId: "graph-orchestrator",
      idempotencyKey: "submission:service:create",
      input: {
        targetId: "22222222-2222-4222-8222-222222222222",
        targetRevisionId: "33333333-3333-4333-8333-333333333333",
        artifactRevisionIds: ["44444444-4444-4444-8444-444444444444"],
        verificationResultIds: [],
      },
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({
      "X-Verrail-Principal-Type": "service",
      "X-Verrail-Principal-Id": "graph-orchestrator",
    }));
    expect(JSON.parse(String(init.body))).toEqual({
      targetId: "22222222-2222-4222-8222-222222222222",
      targetRevisionId: "33333333-3333-4333-8333-333333333333",
      artifactRevisionIds: ["44444444-4444-4444-8444-444444444444"],
      verificationResultIds: [],
    });
  });

  it("forwards a Service integration result without putting identity in the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      resourceType: "integration_run",
      resourceId: "b80f266a-87ea-47f0-81bd-c4f04e4d576e",
      replayed: false,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const client = createVerrailDomainApiClient({
      baseUrl: "http://127.0.0.1:3211",
      token: "secret",
      fetchImpl,
    })!;
    const input = {
      targetId: "22222222-2222-4222-8222-222222222222",
      targetRevisionId: "33333333-3333-4333-8333-333333333333",
      graphRevisionId: "44444444-4444-4444-8444-444444444444",
      claimId: "55555555-5555-4555-8555-555555555555",
      workNodeId: "66666666-6666-4666-8666-666666666666",
      connectorVersion: "github.v1",
      connectionId: "77777777-7777-4777-8777-777777777777",
      provider: "github" as const,
      externalRef: "ci:run:1",
      commitRef: "0123456789abcdef",
      criterionKey: "criterion-1",
      environmentRef: "github:owner/repo:main",
      conclusion: "success" as const,
      objectHash: "a".repeat(64),
      reference: "ci:job:1",
      providerReceipt: { runId: 1 },
    };

    await client.recordIntegrationRun({
      workspaceId: command.workspaceId,
      principalType: "service",
      principalId: "github-connector",
      idempotencyKey: "integration:service:record",
      input,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({
      "X-Verrail-Principal-Type": "service",
      "X-Verrail-Principal-Id": "github-connector",
    }));
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("carries a GitHub credential only in the one-shot internal execution headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      resourceType: "effect_receipt",
      resourceId: "99999999-9999-4999-8999-999999999999",
      replayed: false,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const client = createVerrailDomainApiClient({
      baseUrl: "http://127.0.0.1:3211",
      token: "domain-api-secret",
      fetchImpl,
    })!;
    const ephemeralCredential = "Bearer github-ephemeral-sentinel";

    await client.executeAction({
      workspaceId: command.workspaceId,
      principalType: "user",
      principalId: "user-1",
      idempotencyKey: "connector:action:execute",
      actionRequestId: "77777777-7777-4777-8777-777777777777",
      githubConnectionId: "88888888-8888-4888-8888-888888888888",
      githubAuthorization: ephemeralCredential,
      input: { actionRequestId: "77777777-7777-4777-8777-777777777777" },
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer domain-api-secret",
      "X-Verrail-GitHub-Connection-Id": "88888888-8888-4888-8888-888888888888",
      "X-Verrail-Ephemeral-GitHub-Authorization": ephemeralCredential,
    }));
    expect(String(init.body)).not.toContain("github-ephemeral-sentinel");
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
