// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TargetWorkbench } from "./TargetWorkbench";

const get = vi.hoisted(() => vi.fn());
const getRevision = vi.hoisted(() => vi.fn());
const setBreadcrumbs = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ targetId: "target-1", tab: "overview", targetRevisionId: undefined as string | undefined }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => route,
}));
vi.mock("../api/targets", () => ({ targetsApi: { get, getRevision } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "workspace-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: string }> }) => (
    <div>{items.map((item) => <span key={item.value}>{item.label}</span>)}</div>
  ),
}));
vi.mock("@/components/ui/tabs", () => ({ Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function targetModel() {
  return {
    schemaVersion: 1,
    projectionPolicyVersion: "g1.v1",
    targetId: "target-1",
    activeTargetRevisionId: "revision-1",
    workspaceId: "workspace-1",
    authority: { kind: "compatibility", writer: "typescript-compatibility" },
    project: { id: "project-1", name: "Verrail" },
    source: {
      type: "issue",
      id: "issue-1",
      identifier: "VER-1",
      href: "/VER/issues/VER-1",
      updatedAt: "2026-08-26T10:00:00.000Z",
      revisionKey: "2026-08-26T10:00:00.000Z",
    },
    title: "Release Verrail",
    summary: "A reviewable delivery",
    status: "awaiting_acceptance",
    outcomeOwner: { principalType: "user", principalId: "owner-1", displayName: "Owner" },
    currentStage: { key: "accept", label: "Accept" },
    risk: { level: "high" },
    attentionSummary: { total: 1, highestSeverity: "high" },
    artifactSummary: { count: 0, latestRevisionId: null },
    evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" },
    runSummary: { active: 0, failed: 0, latestRunId: null, latestRunAt: null },
    definition: null,
    compatibility: {
      readOnly: true,
      completionUnverified: true,
      missingFields: ["acceptanceCriteria"],
      warnings: ["projection_stale", "projection_schema_upgraded"],
    },
    createdAt: "2026-08-26T09:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
    projectedAt: "2026-08-26T10:00:01.000Z",
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("TargetWorkbench", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    route.targetId = "target-1";
    route.tab = "overview";
    route.targetRevisionId = undefined;
    get.mockResolvedValue(targetModel());
    getRevision.mockResolvedValue(targetModel());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderWorkbench() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TargetWorkbench />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("shows the responsibility snapshot, stale warning, and compatibility source", async () => {
    await renderWorkbench();
    expect(container.textContent).toContain("Release Verrail");
    expect(container.textContent).toContain("Owner");
    expect(container.textContent).toContain("The source changed after this projection");
    expect(container.textContent).toContain("legacy snapshot was normalized");
    expect(container.textContent).toContain("no version-bound Acceptance exists");
    expect(container.querySelector('a[href="/VER/issues/VER-1"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Accepted");
    expect(setBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Projects", href: "/projects" },
      { label: "Verrail", href: "/projects/project-1/overview" },
      { label: "Release Verrail" },
    ]);
  });

  it("loads immutable revisions through the revision endpoint", async () => {
    route.targetRevisionId = "revision-1";
    await renderWorkbench();
    expect(getRevision).toHaveBeenCalledWith("workspace-1", "target-1", "revision-1");
    expect(container.textContent).toContain("Immutable revision");
    expect(container.querySelector('a[href="/targets/target-1/overview"]')).not.toBeNull();
  });

  it("keeps a missing historical source inspectable without publishing a dead link", async () => {
    route.targetRevisionId = "revision-1";
    getRevision.mockResolvedValue({
      ...targetModel(),
      compatibility: {
        ...targetModel().compatibility,
        completionUnverified: false,
        warnings: ["source_missing"],
      },
    });

    await renderWorkbench();

    expect(container.textContent).toContain("The source is no longer available");
    expect(container.textContent).toContain("Source unavailable");
    expect(container.querySelector('a[href="/VER/issues/VER-1"]')).toBeNull();
  });

  it("distinguishes a retryable projection outage from a missing Target", async () => {
    const { ApiError } = await import("../api/client");
    get.mockRejectedValue(new ApiError("Target projection unavailable", 503, {
      code: "TARGET_PROJECTION_UNAVAILABLE",
    }));

    await renderWorkbench();

    expect(container.textContent).toContain("temporarily unavailable");
    expect(container.textContent).not.toContain("outside your access boundary");
  });
});
