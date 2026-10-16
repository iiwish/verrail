import {
  githubFixedCiProofCommandSchema, githubFixedCiProofResultSchema, parseGithubFixedCiProofTrustConfig,
  targetIdempotencyKeySchema, type GithubFixedCiProofCommand, type GithubFixedCiProofTrust,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";

function misconfigured(): never {
  throw new Error("GitHub fixed CI proof capability is misconfigured");
}

/** A separate startup capability; it is never added to the ordinary domain client. */
export function createGitHubFixedCiProofClient(options: {
  baseUrl?: string;
  token?: string;
  domainToken?: string;
  trustConfig?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}) {
  const rawTrust = options.trustConfig ?? process.env.VERRAIL_GITHUB_CI_PROOF_TRUST;
  const token = options.token ?? process.env.VERRAIL_GITHUB_CI_PROOF_TOKEN;
  if (!rawTrust && !token) return null;
  let trust: Readonly<GithubFixedCiProofTrust>;
  let origin: string;
  try {
    const domainToken = options.domainToken ?? process.env.VERRAIL_DOMAIN_API_TOKEN;
    if (!token || !/^[\x21-\x7e]{32,4096}$/.test(token) || !domainToken?.trim() || token === domainToken.trim()
      || !rawTrust || Buffer.byteLength(rawTrust) > 16_384) misconfigured();
    trust = Object.freeze(parseGithubFixedCiProofTrustConfig(rawTrust));
    const url = new URL(options.baseUrl ?? process.env.VERRAIL_DOMAIN_API_URL ?? "");
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) misconfigured();
    origin = url.origin;
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) misconfigured();
  } catch { misconfigured(); }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    trust,
    async record(request: { workspaceId: string; idempotencyKey: string; input: GithubFixedCiProofCommand }) {
      if (request.workspaceId !== trust.workspaceId) throw new HttpError(403, "GitHub fixed CI proof workspace is not authorized");
      const input = githubFixedCiProofCommandSchema.safeParse(request.input);
      const key = targetIdempotencyKeySchema.safeParse(request.idempotencyKey);
      if (!input.success || !key.success) throw new HttpError(400, "Invalid GitHub fixed CI proof command");
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let response: Response | undefined;
      let failureStatus: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error()); }, options.timeoutMs ?? 15_000);
      });
      try {
        return await Promise.race([(async () => {
          response = await fetchImpl(`${origin}/v1/workspaces/${encodeURIComponent(request.workspaceId)}/github-fixed-ci-proofs`, {
            method: "POST", redirect: "manual", credentials: "omit", signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key.data },
            body: JSON.stringify(input.data),
          });
          if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error(); }
          // The capability never follows redirects or exposes server-controlled errors.
          if (response.redirected || !response.ok || ![200, 201].includes(response.status)) {
            failureStatus = !response.redirected && [400, 401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 503;
            throw new Error();
          }
          const length = response.headers.get("content-length");
          if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 4096)) throw new Error();
          if (!response.body) throw new Error();
          reader = response.body.getReader();
          const chunks: Buffer[] = [];
          let bytes = 0;
          while (true) {
            const next = await reader.read();
            if (controller.signal.aborted) throw new Error();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > 4096) throw new Error();
            chunks.push(Buffer.from(next.value));
          }
          const result = githubFixedCiProofResultSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!result.success || result.data.replayed !== (response.status === 200)) throw new Error();
          return result.data;
        })(), deadline]);
      } catch {
        if (failureStatus !== undefined) throw new HttpError(failureStatus, "GitHub fixed CI proof could not be recorded", { retryable: failureStatus === 503 });
        throw new HttpError(503, "GitHub fixed CI proof recording is unavailable", { retryable: true });
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        else void response?.body?.cancel().catch(() => {});
      }
    },
  };
}

export type GitHubFixedCiProofClient = NonNullable<ReturnType<typeof createGitHubFixedCiProofClient>>;
