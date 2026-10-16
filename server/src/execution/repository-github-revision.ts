import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { loadGitHubCiCollectionContext } from "../services/github-ci-proof-context.js";
import { resolveGithubConnectorCredential, type GithubConnectorCredentialActor } from "../services/secrets.js";

const requestSchema = z.object({
  workspaceId: z.string().uuid(), targetId: z.string().uuid(),
  targetRevisionId: z.string().uuid(), graphRevisionId: z.string().uuid(),
  ref: z.string().min(1).max(256).refine(value => value !== "." && value !== ".." && !/[\x00-\x20\x7f]/.test(value)),
}).strict();

/** Trusted acquisition only; the returned provenance contains no credentials. */
export async function resolveRepositoryGitHubRevision(options: {
  db: Db; input: z.input<typeof requestSchema>; actor: GithubConnectorCredentialActor;
  signal: AbortSignal;
  loadContext?: typeof loadGitHubCiCollectionContext;
  resolveCredential?: typeof resolveGithubConnectorCredential;
  fetch?: typeof globalThis.fetch;
}) {
  const fail = () => new Error("Repository GitHub revision unavailable or authorization changed");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
  try {
    const input = requestSchema.parse(options.input);
    signal.throwIfAborted();
    const load = options.loadContext ?? loadGitHubCiCollectionContext;
    const initial = await load(options.db, input.workspaceId, input.targetId);
    for (const key of ["workspaceId", "targetId", "targetRevisionId", "graphRevisionId"] as const) {
      if (initial[key] !== input[key]) throw fail();
    }
    const parts = initial.repository.split("/");
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]{1,200}$/.test(part) || part === "." || part === "..")) throw fail();
    const recheck = async () => {
      signal.throwIfAborted();
      const current = await load(options.db, input.workspaceId, input.targetId);
      if (JSON.stringify(current) !== JSON.stringify(initial)) throw fail();
      signal.throwIfAborted();
    };
    const credential = await (options.resolveCredential ?? resolveGithubConnectorCredential)(options.db, input.workspaceId, options.actor);
    if (credential.connectionId !== initial.connectionId || credential.authorization.length > 8192
      || !/^(?:Bearer|token) [A-Za-z0-9._~-]+$/.test(credential.authorization)) throw fail();
    await recheck();
    const response = await (options.fetch ?? globalThis.fetch)(
      `https://api.github.com/repos/${initial.repository}/commits/${encodeURIComponent(input.ref)}`,
      { method: "GET", redirect: "error", credentials: "omit", signal,
        headers: { authorization: credential.authorization, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } },
    );
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw fail();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 2 * 1024 * 1024) throw fail();
        chunks.push(chunk.value);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const { sha } = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (/^[0-9a-fA-F]{40}$/.test(input.ref) && sha !== input.ref.toLowerCase()) throw fail();
    await recheck();
    return { schemaVersion: 1 as const, ...input, bindingId: initial.bindingId,
      connectionId: initial.connectionId, repository: initial.repository,
      baseCommit: sha, authorizationContextHash: initial.contextSha256 };
  } catch {
    // Neither provider response bodies nor credential resolver failures may escape.
    throw fail();
  }
}
