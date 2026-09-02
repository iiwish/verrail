// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerrailTargetsSidebar } from "./VerrailTargetsSidebar";

const route = vi.hoisted(() => ({ targetId: "target-1" as string | undefined }));
const targetsApiMock = vi.hoisted(() => ({ list: vi.fn() }));
const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const openNewTarget = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ targetId: route.targetId }),
}));
vi.mock("../api/targets", () => ({ targetsApi: targetsApiMock }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Verrail Workspace" },
    selectedCompanyId: "company-1",
  }),
}));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewTarget }) }));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));
vi.mock("../i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "nav.targets": "Targets",
      "targets.create.submit": "New target",
      "targets.loading": "Loading targets",
      "targets.loadFailed": "Targets failed",
      "targets.empty": "No targets",
      "settings.company.fallbackName": "Workspace",
    } as Record<string, string>)[key] ?? key,
  }),
}));
vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: (props: { to: string; label: string; active?: boolean }) => {
    sidebarNavItemMock(props);
    return <a href={props.to}>{props.label}</a>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("VerrailTargetsSidebar", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    route.targetId = "target-1";
    targetsApiMock.list.mockResolvedValue({
      items: [{
        targetId: "target-1",
        title: "Ship navigation",
        attentionSummary: { total: 1, highestSeverity: "high" },
      }],
    });
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("lists workspace Targets directly and creates without a Project parent", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <VerrailTargetsSidebar />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(targetsApiMock.list).toHaveBeenCalledWith("company-1", { limit: 50 });
      expect(sidebarNavItemMock).toHaveBeenCalledWith(expect.objectContaining({
        to: "/targets/target-1/overview",
        label: "Ship navigation",
        active: true,
      }));
    });
    expect(container.querySelector('[data-testid="verrail-targets-sidebar"]')).not.toBeNull();
    expect(container.querySelector('a[href="/targets"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Projects");

    container.querySelector<HTMLButtonElement>('button[aria-label="New target"]')?.click();
    expect(openNewTarget).toHaveBeenCalledWith();
  });
});
