// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactPreview } from "./ArtifactPreview";

let root: Root;
let container: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

async function preview(bytes: Uint8Array, ok = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.fn().mockResolvedValue({ ok, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
  vi.stubGlobal("fetch", fetch);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ArtifactPreview workspaceId="workspace-1" revisionId="revision-1" />));
  await act(async () => container.querySelector("button")!.click());
  return fetch;
}

describe("artifact text preview", () => {
  it("renders stored content as text, never as executable markup", async () => {
    const fetch = await preview(new TextEncoder().encode('<img src=x onerror="alert(1)">'));
    expect(fetch).toHaveBeenCalledWith("/api/workspaces/workspace-1/artifact-revisions/revision-1/content");
    expect(container.querySelector("pre")?.textContent).toContain("<img");
    expect(container.querySelector("img")).toBeNull();
  });
  it("does not render a partial artifact beyond the preview budget", async () => {
    await preview(new Uint8Array(256 * 1024 + 1));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });
  it("keeps binary content out of text preview", async () => {
    await preview(new Uint8Array([0, 1, 2]));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
  it("surfaces failed reads without exposing response content", async () => {
    await preview(new TextEncoder().encode("private error"), false);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("private error");
  });
});
