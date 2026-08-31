import type { CreateTargetInputV1, CreateTargetResponseV1 } from "@paperclipai/shared";
import { HttpError } from "../errors.js";

export interface CreateNativeTargetCommand {
  workspaceId: string;
  principalType: "user";
  principalId: string;
  idempotencyKey: string;
  input: CreateTargetInputV1;
}

export interface VerrailDomainApiClient {
  createTarget(command: CreateNativeTargetCommand): Promise<CreateTargetResponseV1>;
}

type DomainApiErrorPayload = {
  error?: unknown;
  code?: unknown;
  retryable?: unknown;
};

export function createVerrailDomainApiClient(options: {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): VerrailDomainApiClient | null {
  const baseUrl = (options.baseUrl ?? process.env.VERRAIL_DOMAIN_API_URL ?? "").trim().replace(/\/$/, "");
  const token = (options.token ?? process.env.VERRAIL_DOMAIN_API_TOKEN ?? "").trim();
  if (!baseUrl || !token) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    async createTarget(command) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/v1/workspaces/${encodeURIComponent(command.workspaceId)}/targets`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Idempotency-Key": command.idempotencyKey,
              "X-Verrail-Principal-Type": command.principalType,
              "X-Verrail-Principal-Id": command.principalId,
            },
            body: JSON.stringify(command.input),
            signal: controller.signal,
          },
        );
      } catch (error) {
        throw new HttpError(503, "Verrail Domain API is unavailable", {
          code: "TARGET_DOMAIN_API_UNAVAILABLE",
          retryable: true,
          cause: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timer);
      }

      const payload = await response.json().catch(() => ({})) as DomainApiErrorPayload | CreateTargetResponseV1;
      if (!response.ok) {
        const error = payload as DomainApiErrorPayload;
        throw new HttpError(
          response.status,
          typeof error.error === "string" ? error.error : "Target creation failed",
          {
            code: typeof error.code === "string" ? error.code : "TARGET_CREATE_FAILED",
            retryable: error.retryable === true,
          },
        );
      }
      return payload as CreateTargetResponseV1;
    },
  };
}
