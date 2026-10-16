import { describe, expect, it } from "vitest";
import type { Request } from "express";
import path from "node:path";
import { resolveViteCacheDir, shouldServeViteDevHtml } from "../app.js";

describe("resolveViteCacheDir", () => {
  const input = { instanceRoot: "/instances/dev", uiRoot: "/repo/ui", bindHost: "127.0.0.1", serverPort: 3270 };

  it("keeps a stable cache under the owning instance, outside the shared UI optimizer cache", () => {
    const cacheDir = resolveViteCacheDir(input);
    expect(cacheDir).toBe(resolveViteCacheDir(input));
    expect(cacheDir.startsWith(path.join(input.instanceRoot, "cache", "vite") + path.sep)).toBe(true);
    expect(cacheDir.startsWith(path.join(input.uiRoot, "node_modules") + path.sep)).toBe(false);
    expect(cacheDir).toContain(`${path.sep}node_modules${path.sep}`);
  });

  it("isolates different instances, checkouts and listening endpoints", () => {
    const identities = [
      input,
      { ...input, instanceRoot: "/instances/acceptance" },
      { ...input, uiRoot: "/another-worktree/ui" },
      { ...input, serverPort: 49784 },
      { ...input, bindHost: "127.0.0.2" },
    ];
    expect(new Set(identities.map(resolveViteCacheDir)).size).toBe(identities.length);
  });
});

function createRequest(path: string, acceptsResult: string | false): Request {
  return {
    path,
    accepts: () => acceptsResult,
  } as unknown as Request;
}

describe("shouldServeViteDevHtml", () => {
  it("serves HTML shell for document requests", () => {
    expect(shouldServeViteDevHtml(createRequest("/", "html"))).toBe(true);
    expect(shouldServeViteDevHtml(createRequest("/issues/abc", "html"))).toBe(true);
  });

  it("skips public assets even when the client accepts */*", () => {
    expect(shouldServeViteDevHtml(createRequest("/sw.js", "html"))).toBe(false);
    expect(shouldServeViteDevHtml(createRequest("/site.webmanifest", "html"))).toBe(false);
  });

  it("skips vite asset requests", () => {
    expect(shouldServeViteDevHtml(createRequest("/@vite/client", "html"))).toBe(false);
    expect(shouldServeViteDevHtml(createRequest("/src/main.tsx", "html"))).toBe(false);
  });
});
