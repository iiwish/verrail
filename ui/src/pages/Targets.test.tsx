// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Targets } from "./Targets";

const listTargets = vi.hoisted(() => vi.fn());
const openNewTarget = vi.hoisted(() => vi.fn());
const setBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("../api/targets", () => ({ targetsApi: { list: listTargets } }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "workspace-1" }),
}));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewTarget }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button type="button" data-value={value}>{children}</button>
  ),
}));
vi.mock("../i18n", () => ({
  getCurrentLocale: () => "en",
  useTranslation: () => ({
    t: (key: string) => ({
      "nav.targets": "Targets",
      "targets.title": "Targets",
      "targets.create.submit": "New target",
      "collections.title": "Collections",
      "targets.list.filterLabel": "Filter targets",
      "targets.list.all": "All",
      "targets.list.open": "Open",
      "targets.list.attention": "Needs attention",
      "targets.list.noMatches": "No targets match",
      "targets.emptyDetail": "Create a target in this workspace.",
      "targets.unknownStage": "Unknown stage",
      "targets.statuses.active": "Active",
      "targets.statuses.accepted": "Accepted",
    } as Record<string, string>)[key] ?? key,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetId: "target-1",
    title: "Ship conversation-first targets",
    summary: "Make Targets workspace-native",
    status: "active",
    currentStage: { key: "execute", label: "Execute" },
    collection: null,
    definition: null,
    attentionSummary: { total: 0, highestSeverity: null },
    updatedAt: "2026-09-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("Targets", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listTargets.mockResolvedValue({
      items: [
        target(),
        target({
          targetId: "target-2",
          title: "Publish release evidence",
          collection: { id: "collection-1", name: "Release work" },
          attentionSummary: { total: 2, highestSeverity: "high" },
        }),
        target({ targetId: "target-3", title: "Accepted target", status: "accepted" }),
      ],
      summary: { total: 3, open: 2, attention: 1, byCollection: {} },
    });
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a workspace-scoped target list without Project grouping", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <Targets />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain("Ship conversation-first targets"));
    expect(listTargets).toHaveBeenCalledWith("workspace-1", { limit: 100 });
    expect(container.querySelector('[data-testid="workspace-target-list"]')).not.toBeNull();
    expect(container.querySelector('a[href="/targets/target-1/overview"]')).not.toBeNull();
    expect(container.textContent).toContain("Release work");
    expect(container.textContent).not.toContain("Accepted target");
    expect(setBreadcrumbs).toHaveBeenLastCalledWith([{ label: "Targets" }]);

    await act(() => container.querySelector<HTMLButtonElement>("button")?.click());
    expect(openNewTarget).toHaveBeenCalledWith();
  });
});
