// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerrailHome } from "./VerrailHome";

const attentionList = vi.hoisted(() => vi.fn());
const liveRunsForCompany = vi.hoisted(() => vi.fn());
const targetsList = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/attention", () => ({ attentionApi: { list: attentionList } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany } }));
vi.mock("../api/targets", () => ({ targetsApi: { list: targetsList } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Delivery Lab", issuePrefix: "LAB" },
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("VerrailHome", () => {
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

  async function renderHome() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <VerrailHome />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return queryClient;
  }

  it("shows attention, run, and server-projected Target read models", async () => {
    attentionList.mockResolvedValue({
      totalCount: 1,
      items: [{
        id: "attention-1",
        sourceKind: "review",
        whyNow: "Review requested",
        activityAt: new Date().toISOString(),
        subject: { title: "Review release evidence", identifier: "LAB-12", href: "/issues/LAB-12" },
      }],
    });
    liveRunsForCompany.mockResolvedValue([{
      id: "run-1",
      agentId: "agent-1",
      agentName: "Release reviewer",
      status: "running",
    }]);
    targetsList.mockResolvedValue({
      schemaVersion: 1,
      readModelPolicyVersion: "native.v1",
      asOf: new Date().toISOString(),
      nextCursor: null,
      items: [{
        targetId: "target-1",
        title: "Delivery platform",
        currentStage: { key: "execute", label: "Execute" },
      }],
    });

    await renderHome();

    expect(container.textContent).toContain("Delivery Lab");
    expect(container.textContent).toContain("Review release evidence");
    expect(container.textContent).toContain("Release reviewer");
    expect(container.textContent).toContain("Delivery platform");
    expect(container.querySelector('a[href="/targets/target-1/overview"]')).not.toBeNull();
    expect(container.querySelector('a[href="/issues/LAB-12"]')).not.toBeNull();
  });

  it("renders explicit empty states for every operational section", async () => {
    attentionList.mockResolvedValue({ totalCount: 0, items: [] });
    liveRunsForCompany.mockResolvedValue([]);
    targetsList.mockResolvedValue({ items: [], nextCursor: null });

    await renderHome();

    expect(container.textContent).toContain("Nothing needs attention.");
    expect(container.textContent).toContain("No agents are running.");
    expect(container.textContent).toContain("No mapped targets yet.");
  });

  it("keeps unavailable summary values distinct from confirmed zero totals", async () => {
    attentionList.mockRejectedValue(new Error("attention unavailable"));
    liveRunsForCompany.mockRejectedValue(new Error("runs unavailable"));
    targetsList.mockRejectedValue(new Error("targets unavailable"));

    await renderHome();

    expect([...container.querySelectorAll("dl dd")].map((node) => node.textContent)).toEqual([
      "--",
      "--",
      "--",
    ]);
  });

  it("does not present cached totals as current after a failed refetch", async () => {
    attentionList.mockResolvedValue({
      totalCount: 2,
      items: [{
        id: "attention-cached",
        sourceKind: "review",
        whyNow: "Cached attention",
        activityAt: new Date().toISOString(),
        subject: { title: "Cached review", identifier: "LAB-20", href: "/issues/LAB-20" },
      }],
    });
    liveRunsForCompany.mockResolvedValue([{
      id: "run-cached",
      agentId: "agent-cached",
      agentName: "Cached runner",
      status: "running",
    }]);
    targetsList.mockResolvedValue({
      items: [{ targetId: "target-cached", title: "Cached target", currentStage: null }],
      nextCursor: null,
    });
    const queryClient = await renderHome();

    expect([...container.querySelectorAll("dl dd")].map((node) => node.textContent)).toEqual([
      "2",
      "1",
      "1",
    ]);

    attentionList.mockRejectedValue(new Error("attention refetch unavailable"));
    liveRunsForCompany.mockRejectedValue(new Error("runs refetch unavailable"));
    targetsList.mockRejectedValue(new Error("targets refetch unavailable"));
    await act(async () => {
      await queryClient.refetchQueries({ type: "active" });
    });
    await flushReact();

    expect([...container.querySelectorAll("dl dd")].map((node) => node.textContent)).toEqual([
      "--",
      "--",
      "--",
    ]);
    expect(container.textContent).not.toContain("Cached review");
    expect(container.textContent).not.toContain("Cached runner");
    expect(container.textContent).not.toContain("Cached target");
  });
});
