import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type OpenCodeUsage = { total: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } };
type ObservedUsage = { total: number | null; input: number | null; output: number | null; reasoning: number | null;
  cache: { read: number | null; write: number | null } };
export type OpenCodeStepFacts = { startPartId: string; finishPartId: string; reason: string; tokens: ObservedUsage; reportedCostUsd: number | null };
export type OpenCodeMessageFacts = { messageId: string; role: "user" | "assistant"; parentMessageId: string | null;
  providerId: string; modelId: string; createdAt: string; completedAt: string | null; finishReason: string | null;
  steps: OpenCodeStepFacts[]; unaccountedPartTypes: string[];
  tools: { partId: string; status: "completed" | "error" }[] };
export type OpenCodeExecutionFacts = { runtimeVersion: string; healthVerifiedAt: string; sessionId: string; sessionCreatedAt: string;
  messageId: string; model: string; providerId: string; modelId: string; messages: OpenCodeMessageFacts[];
  usageStatus: "complete" | "unavailable"; usageScope: "session-step-finish"; usage: OpenCodeUsage | null;
  costStatus: "unavailable"; costBasis: "opencode-estimate"; reportedCostUsd: number | null };
export type OpenCodeRuntimeWitness = {
  checkedAt: string;
  permissions: { default: "deny"; allowedTools: string[]; sessionRulesSha256: string; configRulesSha256: string };
  configuration: { share: "disabled"; model: string; smallModel: string; enabledProviders: string[] };
  environment: { homeSha256: string; directory: "."; config: "config/opencode"; state: "state/opencode"; worktree: "global" | "isolated-home" };
};

function sha256(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }

function runtimeWitness(session: JsonObject, config: JsonObject, paths: JsonObject, sessionId: string, home: string,
  expected: { model: string; enabledProviders: readonly string[] }, allowedTools: readonly string[]): OpenCodeRuntimeWitness {
  if (session.id !== sessionId || !Array.isArray(session.permission) || session.permission.length !== allowedTools.length + 1) throw new Error("OpenCode session permission mismatch");
  const rules = session.permission.map((value, index) => {
    const rule = object(value);
    if (Object.keys(rule).sort().join(",") !== "action,pattern,permission" || rule.pattern !== "*"
      || rule.permission !== (index === 0 ? "*" : allowedTools[index - 1]) || rule.action !== (index === 0 ? "deny" : "allow")) {
      throw new Error("OpenCode session permission mismatch");
    }
    return { permission: rule.permission as string, pattern: rule.pattern, action: rule.action as string };
  });
  const permissions = object(config.permission); const keys = Object.keys(permissions).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["*", ...allowedTools].sort())
    || keys.some(key => permissions[key] !== (key === "*" ? "deny" : "allow"))) throw new Error("OpenCode effective permission mismatch");
  if (config.model !== expected.model || config.small_model !== expected.model || config.share !== "disabled"
    || !Array.isArray(config.enabled_providers) || config.enabled_providers.some(value => typeof value !== "string")
    || JSON.stringify([...config.enabled_providers].sort()) !== JSON.stringify([...expected.enabledProviders].sort())) {
    throw new Error("OpenCode effective configuration mismatch");
  }
  if (paths.home !== home || paths.directory !== home || paths.config !== `${home}/config/opencode`
    || paths.state !== `${home}/state/opencode` || (paths.worktree !== "/" && paths.worktree !== home)) throw new Error("OpenCode isolated path mismatch");
  return { checkedAt: new Date().toISOString(), permissions: { default: rules[0]!.action as "deny",
    allowedTools: rules.slice(1).map(rule => rule.permission), sessionRulesSha256: sha256(JSON.stringify(rules)),
    configRulesSha256: sha256(JSON.stringify(keys.map(key => [key, permissions[key]]))) },
  configuration: { share: config.share, model: config.model as string, smallModel: config.small_model as string,
    enabledProviders: [...config.enabled_providers as string[]].sort() },
  // Paths are actual server readbacks, represented relative to the isolated home (never host absolute paths).
  environment: { homeSha256: sha256(paths.home as string), directory: ".", config: "config/opencode", state: "state/opencode",
    worktree: paths.worktree === "/" ? "global" : "isolated-home" } };
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OpenCode response");
  return value as JsonObject;
}

function identity(value: unknown, prefix: "msg" | "prt") {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value)) throw new Error("Invalid OpenCode fact identity");
  return value;
}

function timestamp(value: unknown, earliest: number, latest: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < earliest || value > latest) throw new Error("Invalid OpenCode fact timestamp");
  return value;
}

function numeric(value: unknown, integer: boolean): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error("Invalid OpenCode usage or cost fact");
  }
  return value;
}

function usage(value: unknown): ObservedUsage {
  const tokens = value === undefined ? {} : object(value);
  const cache = tokens.cache === undefined ? {} : object(tokens.cache);
  return { total: numeric(tokens.total, true), input: numeric(tokens.input, true), output: numeric(tokens.output, true),
    reasoning: numeric(tokens.reasoning, true), cache: { read: numeric(cache.read, true), write: numeric(cache.write, true) } };
}

// OpenCode 1.17.13 overwrites assistant.tokens per step. Only all step-finish parts cover tool rounds.
export function deriveOpenCodeExecutionFacts(raw: unknown, input: { model: string; finalMessageId: string }, sessionId: string, session: JsonObject,
  health: { version: string; verifiedAt: string }): OpenCodeExecutionFacts {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 1000) throw new Error("Invalid OpenCode full message collection");
  const separator = input.model.indexOf("/");
  if (separator < 1 || separator === input.model.length - 1) throw new Error("OpenCode requires provider/model");
  const providerId = input.model.slice(0, separator); const modelId = input.model.slice(separator + 1);
  const now = Date.now(); const created = timestamp(object(session.time).created, 1, now);
  const ids = new Set<string>(); const partIds = new Set<string>(); const userIds = new Set<string>();
  const messages: OpenCodeMessageFacts[] = []; let previousCreated = created; let lastAssistant: string | undefined;
  let complete = true; let reportedCostUsd: number | null = 0; let partsCount = 0;
  const total: OpenCodeUsage = { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  for (const value of raw) {
    const message = object(value); const info = object(message.info); const messageId = identity(info.id, "msg");
    if (ids.has(messageId) || info.sessionID !== sessionId || !["user", "assistant"].includes(String(info.role)) || info.error) throw new Error("Invalid OpenCode message facts");
    ids.add(messageId);
    const time = object(info.time); const started = timestamp(time.created, previousCreated, now); previousCreated = started;
    const assistant = info.role === "assistant"; const model = assistant ? info : object(info.model);
    if (model.providerID !== providerId || model.modelID !== modelId) throw new Error("OpenCode observed model mismatch");
    const completed = assistant ? timestamp(time.completed, started, now) : null;
    const parent = assistant ? identity(info.parentID, "msg") : null;
    if (assistant && !userIds.has(parent!)) throw new Error("Invalid OpenCode parent message");
    if (!assistant) userIds.add(messageId);
    if (!Array.isArray(message.parts) || (partsCount += message.parts.length) > 10_000) throw new Error("OpenCode part collection exceeds limit");
    const steps: OpenCodeStepFacts[] = []; const tools: OpenCodeMessageFacts["tools"] = [];
    const unaccountedPartTypes = new Set<string>(); let opened: string | undefined;
    for (const rawPart of message.parts) {
      const part = object(rawPart); const partId = identity(part.id, "prt");
      if (partIds.has(partId) || part.sessionID !== sessionId || part.messageID !== messageId
        || typeof part.type !== "string" || !part.type) throw new Error("Invalid OpenCode part identity");
      partIds.add(partId);
      if (part.type === "step-start") {
        if (!assistant || opened) throw new Error("Invalid OpenCode step pairing"); opened = partId;
      } else if (part.type === "step-finish") {
        if (!assistant || !opened || typeof part.reason !== "string" || !part.reason) throw new Error("Invalid OpenCode step pairing");
        const tokens = usage(part.tokens); const cost = numeric(part.cost, false);
        steps.push({ startPartId: opened, finishPartId: partId, reason: part.reason, tokens, reportedCostUsd: cost }); opened = undefined;
        const components = [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write];
        const valid = components.every(value => value !== null) && tokens.total !== null && tokens.total > 0
          && components.reduce<number>((sum, value) => sum + (value ?? 0), 0) === tokens.total;
        if (!valid) complete = false;
        if (valid) {
          for (const key of ["total", "input", "output", "reasoning"] as const) total[key] += tokens[key]!;
          for (const key of ["read", "write"] as const) total.cache[key] += tokens.cache[key]!;
          if (![total.total, total.input, total.output, total.reasoning, total.cache.read, total.cache.write].every(Number.isSafeInteger)) throw new Error("OpenCode usage total exceeds limit");
        }
        reportedCostUsd = cost === null || reportedCostUsd === null ? null : reportedCostUsd + cost;
        if (reportedCostUsd !== null && !Number.isFinite(reportedCostUsd)) throw new Error("OpenCode cost total exceeds limit");
      } else if (part.type === "tool") {
        const state = object(part.state);
        if (!assistant || (state.status !== "completed" && state.status !== "error")) throw new Error("OpenCode tool is not terminal");
        tools.push({ partId, status: state.status });
      } else if (!["text", "reasoning", "patch", "snapshot", "file", "agent"].includes(part.type)) {
        // Retry, subtask, compaction and unknown parts can include unaccounted provider attempts.
        complete = false; unaccountedPartTypes.add(part.type);
      }
    }
    if (opened || (assistant && !steps.length)) throw new Error("Incomplete OpenCode step collection");
    const finishReason = assistant ? steps.at(-1)!.reason : null;
    if (assistant && (info.finish !== finishReason || (messageId === input.finalMessageId && ["tool-calls", "unknown"].includes(finishReason!)))) {
      throw new Error("Invalid OpenCode message finish");
    }
    if (assistant) lastAssistant = messageId;
    messages.push({ messageId, role: assistant ? "assistant" : "user", parentMessageId: parent, providerId, modelId,
      createdAt: new Date(started).toISOString(), completedAt: completed === null ? null : new Date(completed).toISOString(),
      finishReason, steps, tools, unaccountedPartTypes: [...unaccountedPartTypes] });
  }
  if (lastAssistant !== input.finalMessageId || messages.at(-1)?.messageId !== input.finalMessageId) throw new Error("OpenCode final message is missing or not final");
  return { runtimeVersion: health.version, healthVerifiedAt: health.verifiedAt, sessionId, sessionCreatedAt: new Date(created).toISOString(),
    messageId: input.finalMessageId, model: input.model, providerId, modelId, messages, usageStatus: complete ? "complete" : "unavailable",
    usageScope: "session-step-finish", usage: complete ? total : null,
    // Upstream substitutes zero when pricing is absent. A reported estimate is not a verified charge.
    costStatus: "unavailable", costBasis: "opencode-estimate", reportedCostUsd };
}

/** Internal transport only; callers still enforce principal and workspace authorization. */
export function createOpenCodeHttpClient(options: {
  url: string;
  password: string;
  directory: string;
  version: string;
  executionTimeoutMs?: number;
  fetch?: typeof fetch;
}) {
  const base = new URL(options.url);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Invalid OpenCode service URL");
  }
  if (!options.password || !/^\d+\.\d+\.\d+$/.test(options.version)
    || !options.directory.startsWith("/") || options.directory.split("/").includes("..") || options.directory.includes("\0")) {
    throw new Error("Invalid OpenCode runtime configuration");
  }
  const request = options.fetch ?? fetch;
  const executionTimeoutMs = options.executionTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 1 || executionTimeoutMs > 3_600_000) {
    throw new Error("Invalid OpenCode execution timeout");
  }
  const sessions = new Map<string, { session: JsonObject; health: { version: string; verifiedAt: string }; allowedTools: string[] }>();
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`,
    "Content-Type": "application/json",
  };

  async function call(path: string, method: string, body?: unknown, signal?: AbortSignal, timeoutMs = 120_000,
    fullCollection = false, onBody?: (body: Uint8Array) => void) {
    const url = new URL(path, base);
    url.searchParams.set("directory", options.directory);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await request(url, {
      method, headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenCode HTTP ${response.status}`);
    }
    if (fullCollection && (response.headers.has("x-next-cursor") || /rel=["']?next/.test(response.headers.get("link") ?? ""))) {
      await response.body?.cancel(); throw new Error("Unexpected OpenCode pagination");
    }
    if (!response.body) throw new Error("Empty OpenCode response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error("OpenCode response exceeds limit");
        chunks.push(chunk.value);
      }
      const raw = Buffer.concat(chunks); onBody?.(raw);
      try { return JSON.parse(raw.toString("utf8")) as unknown; }
      catch { throw new Error("Invalid OpenCode JSON response"); }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }

  function sessionPath(id: string) {
    if (!sessions.has(id)) throw new Error("Unknown OpenCode session");
    return `/session/${encodeURIComponent(id)}`;
  }

  async function promptMessage(id: string, input: { model: string; system: string; prompt: string }, signal?: AbortSignal) {
    const path = sessionPath(id);
    const separator = input.model.indexOf("/");
    if (separator < 1 || separator === input.model.length - 1) throw new Error("OpenCode requires provider/model");
    const result = object(await call(`${path}/message`, "POST", {
      model: { providerID: input.model.slice(0, separator), modelID: input.model.slice(separator + 1) },
      system: input.system, parts: [{ type: "text", text: input.prompt }],
    }, signal, executionTimeoutMs));
    const info = object(result.info);
    if (info.role !== "assistant" || info.error) throw new Error("OpenCode execution failed");
    if (info.sessionID !== id || typeof info.id !== "string" || !/^msg_[A-Za-z0-9]+$/.test(info.id)) {
      throw new Error("Invalid OpenCode message identity");
    }
    if (!Array.isArray(result.parts)) throw new Error("Invalid OpenCode message parts");
    return { messageId: info.id,
      text: result.parts.map(object).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text as string).join("") };
  }

  return {
    async createSession(sessionOptions: { allowedTools?: readonly string[] } = {}, signal?: AbortSignal) {
      const tools = sessionOptions.allowedTools ?? [];
      if (tools.length > 20 || tools.some(name => !/^[a-z][a-z0-9_]{0,99}$/.test(name))) throw new Error("Invalid OpenCode tool allowlist");
      const health = object(await call("/global/health", "GET", undefined, signal));
      if (health.healthy !== true || health.version !== options.version) throw new Error("OpenCode health or version mismatch");
      const verifiedAt = new Date().toISOString();
      const session = object(await call("/session", "POST", {
        permission: [{ permission: "*", pattern: "*", action: "deny" },
          ...tools.map(name => ({ permission: name, pattern: "*", action: "allow" }))],
      }, signal));
      if (typeof session.id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(session.id)) throw new Error("Invalid OpenCode session ID");
      sessions.set(session.id, { session, health: { version: health.version as string, verifiedAt }, allowedTools: [...tools] });
      return session.id;
    },
    async collectRuntimeWitness(id: string, expected: { model: string; enabledProviders: readonly string[] }, signal?: AbortSignal) {
      const path = sessionPath(id);
      if (options.version !== "1.17.13") throw new Error("Unsupported OpenCode execution fact contract");
      const session = object(await call(path, "GET", undefined, signal, executionTimeoutMs));
      const config = object(await call("/config", "GET", undefined, signal, executionTimeoutMs));
      const paths = object(await call("/path", "GET", undefined, signal, executionTimeoutMs));
      return runtimeWitness(session, config, paths, id, options.directory, expected, sessions.get(id)!.allowedTools);
    },
    async collectExecutionFacts(id: string, input: { model: string; finalMessageId: string }, signal?: AbortSignal) {
      const path = sessionPath(id);
      if (options.version !== "1.17.13") throw new Error("Unsupported OpenCode execution fact contract");
      const allocation = sessions.get(id)!;
      // The pinned endpoint returns every page when limit is absent; byte/message bounds reject excess, never truncate it.
      let fullHistoryBody!: Uint8Array;
      const messages = await call(`${path}/message`, "GET", undefined, signal, executionTimeoutMs, true, body => { fullHistoryBody = body; });
      const facts = deriveOpenCodeExecutionFacts(messages, input, id, allocation.session, allocation.health);
      return { ...facts, fullHistory: { sha256: sha256(fullHistoryBody), bytes: fullHistoryBody.byteLength,
        messageCount: facts.messages.length, partCount: (messages as { parts: unknown[] }[]).reduce((sum, message) => sum + message.parts.length, 0) },
      // Private transport bytes: the repository owner persists these separately, never in the public receipt or JSON facts.
      fullHistoryBody };
    },
    async prompt(id: string, input: { model: string; system: string; prompt: string }, signal?: AbortSignal) {
      return (await promptMessage(id, input, signal)).text;
    },
    promptMessage,
    async abort(id: string) {
      // Aborting an HTTP request does not stop the harness. Require an explicit acknowledgement.
      if (await call(`${sessionPath(id)}/abort`, "POST") !== true) throw new Error("OpenCode abort was not acknowledged");
    },
    async subscribeText(id: string, onText: (text: string, messageId: string) => void | Promise<void>, signal?: AbortSignal) {
      sessionPath(id);
      const stop = new AbortController();
      const timeout = AbortSignal.timeout(executionTimeoutMs);
      const combined = AbortSignal.any([stop.signal, timeout, ...(signal ? [signal] : [])]);
      const url = new URL("/event", base);
      url.searchParams.set("directory", options.directory);
      const response = await request(url, { headers, redirect: "error", signal: combined });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        await response.body?.cancel();
        throw new Error("Invalid OpenCode event stream");
      }
      const reader = response.body.getReader();
      const done = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        let data: string[] = [];
        let frameSize = 0;
        let outputSize = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 1024 * 1024) throw new Error("OpenCode event exceeds limit");
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const raw of lines) {
              const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
              if (line.startsWith("data:")) {
                const value = line.slice(5).replace(/^ /, "");
                frameSize += value.length;
                if (frameSize > 1024 * 1024) throw new Error("OpenCode event exceeds limit");
                data.push(value);
              } else if (!line && data.length) {
                let event: JsonObject;
                try { event = object(JSON.parse(data.join("\n"))); }
                catch { throw new Error("Invalid OpenCode event"); }
                data = [];
                frameSize = 0;
                if (event.type !== "message.part.delta") continue;
                const properties = object(event.properties);
                if (properties.sessionID !== id || properties.field !== "text" || typeof properties.delta !== "string") continue;
                if (typeof properties.messageID !== "string" || !/^msg_[A-Za-z0-9]+$/.test(properties.messageID)) {
                  throw new Error("Invalid OpenCode event message identity");
                }
                outputSize += Buffer.byteLength(properties.delta);
                if (outputSize > 2 * 1024 * 1024) throw new Error("OpenCode output exceeds limit");
                await onText(properties.delta, properties.messageID);
              }
            }
          }
        } catch (error) {
          if (!stop.signal.aborted && !signal?.aborted) throw error;
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })();
      // Preserve rejection for the owner to await without an early unhandled rejection.
      void done.catch(() => {});
      return { done, close: () => { stop.abort(); } };
    },
  };
}
