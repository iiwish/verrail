type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid OpenCode response");
  return value as JsonObject;
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
  const sessions = new Set<string>();
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`,
    "Content-Type": "application/json",
  };

  async function call(path: string, method: string, body?: unknown, signal?: AbortSignal, timeoutMs = 120_000) {
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
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
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
      const session = object(await call("/session", "POST", {
        permission: [{ permission: "*", pattern: "*", action: "deny" },
          ...tools.map(name => ({ permission: name, pattern: "*", action: "allow" }))],
      }, signal));
      if (typeof session.id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(session.id)) throw new Error("Invalid OpenCode session ID");
      sessions.add(session.id);
      return session.id;
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
