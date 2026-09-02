// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerrailProjectsSidebar } from "./VerrailProjectsSidebar";

const route = vi.hoisted(() => ({
  projectId: undefined as string | undefined,
}));
const projectsApiMock = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const sidebarNavItemMock = vi.hoisted(() => vi.fn());
const dialogActionsMock = vi.hoisted(() => ({ openNewProject: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ projectId: route.projectId }),
}));

vi.mock("../api/projects", () => ({ projectsApi: projectsApiMock }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Verrail Workspace" },
    selectedCompanyId: "company-1",
  }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => dialogActionsMock,
}));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));
vi.mock("../hooks/useResourceMemberships", () => ({
  resourceMembershipState: () => "joined",
  useResourceMemberships: () => ({ isSuccess: true, data: {} }),
}));
vi.mock("../i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      "nav.projects": "Projects",
      "nav.targets": "Targets",
      "projects.add": "Add project",
      "projects.all": "All projects",
      "projects.yours": "Your projects",
      "projects.detail.tabs.targets": "Targets",
      "targets.create.submit": "New target",
      "targets.loading": "Loading targets",
      "targets.loadFailed": "Targets failed",
      "targets.empty": "No targets",
      "settings.company.fallbackName": "Workspace",
    } as Record<string, string>)[key] ?? key,
  }),
}));
vi.mock("./ProjectTile", () => ({ ProjectTile: () => <span>Project icon</span> }));
vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: (props: { to: string; label: string; active?: boolean }) => {
    sidebarNavItemMock(props);
    return <a href={props.to}>{props.label}</a>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: "project-1",
  companyId: "company-1",
  urlKey: "launch-project",
  name: "Launch Project",
  color: null,
  icon: null,
  managedByPlugin: { pluginKey: "managed", pluginDisplayName: "Managed", resourceKind: "project" },
};
describe("VerrailProjectsSidebar", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    route.projectId = undefined;
    projectsApiMock.list.mockResolvedValue([project]);
    projectsApiMock.get.mockResolvedValue(project);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function renderSidebar() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <VerrailProjectsSidebar />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("uses the secondary pane as a project switcher", async () => {
    await renderSidebar();

    await vi.waitFor(() => expect(container.textContent).toContain("Launch Project"));
    expect(container.querySelector('[data-testid="verrail-projects-sidebar"]')).not.toBeNull();
    expect(container.textContent).not.toContain("All projects");
    expect(container.textContent).not.toContain("Your projects");
    expect(Array.from(new Set(sidebarNavItemMock.mock.calls.map(([props]) => props.to)))).toEqual([
      "/projects/launch-project/overview",
    ]);
    expect(container.querySelector('a[href="/projects"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Add project"]')).not.toBeNull();
  });

  it("keeps the selected Project as a Project switcher without nesting Targets", async () => {
    route.projectId = "launch-project";
    await renderSidebar();

    await vi.waitFor(() => {
      expect(sidebarNavItemMock.mock.calls.map(([props]) => props.to))
        .toContain("/projects/launch-project/overview");
    });
    const destinations = sidebarNavItemMock.mock.calls.map(([props]) => props.to);
    expect(destinations).toContain("/projects/launch-project/overview");
    expect(destinations).not.toContain("/targets/target-1/overview");
    expect(destinations).not.toContain("/projects/launch-project/configuration");
    expect(destinations).not.toContain("/projects/launch-project/budget");
    expect(container.querySelector('a[href="/projects/launch-project/targets"]')).toBeNull();
    expect(container.textContent).not.toContain("Targets");
    expect(container.querySelector('button[aria-label="New target"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-target-list"]')).toBeNull();
  });

});
