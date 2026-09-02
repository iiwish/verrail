// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TargetList } from "./TargetList";

const list = vi.hoisted(() => vi.fn());
const listForCollection = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("../api/targets", () => ({ targetsApi: { list, listForCollection } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("TargetList", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderList(collectionId?: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TargetList workspaceId="workspace-1" collectionId={collectionId} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("renders server-issued Target links and attention state", async () => {
    list.mockResolvedValue({
      items: [{
        targetId: "target-1",
        title: "Release Verrail",
        currentStage: { key: "verify", label: "Verify" },
        status: "verifying",
        attentionSummary: { total: 1, highestSeverity: "high" },
        updatedAt: new Date().toISOString(),
      }],
    });
    await renderList();
    expect(container.textContent).toContain("Release Verrail");
    expect(container.textContent).toContain("Verify");
    expect(container.querySelector('a[href="/targets/target-1/overview"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Needs attention"]')).not.toBeNull();
  });

  it("uses the Collection-scoped endpoint and renders an honest empty state", async () => {
    listForCollection.mockResolvedValue({ items: [] });
    await renderList("collection-1");
    expect(listForCollection).toHaveBeenCalledWith("workspace-1", "collection-1", { limit: 50 });
    expect(container.textContent).toContain("No targets are available");
    expect(container.textContent).not.toContain("New Target");
  });
});
