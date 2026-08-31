// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerrailManagementSidebar } from "./VerrailManagementSidebar";

const sidebarNavItemMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "company-1", name: "Verrail Workspace" } }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewAgent: vi.fn() }),
}));

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: ({ appearance }: { appearance: string }) => (
    <div data-testid="agent-list">Agent list: {appearance}</div>
  ),
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "nav.infrastructure": "Infrastructure",
        "nav.governance": "Governance",
        "nav.agents": "Agents",
        "agentNav.all": "All agents",
        "agentNav.definitions": "Definitions",
        "agentNav.deployments": "Deployments",
        "agentNav.yours": "Your agents",
        "sidebarAgents.newAgent": "New agent",
        "nav.decisions": "Decisions",
        "nav.activity": "Activity",
        "nav.costs": "Costs",
        "settingsNav.environments": "Environments",
        "settingsNav.secrets": "Secrets",
        "settingsNav.adapters": "Adapters",
        "settingsNav.plugins": "Plugins",
        "approvals.title": "Approvals",
        "settings.company.fallbackName": "Workspace",
      })[key] ?? key,
  }),
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: (props: { to: string; label: string; end?: boolean }) => {
    sidebarNavItemMock(props);
    return <a href={props.to}>{props.label}</a>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function renderSidebar(container: HTMLElement, section: "agents" | "infrastructure" | "governance") {
  const root = createRoot(container);
  root.render(<VerrailManagementSidebar section={section} />);
  await vi.waitFor(() => expect(container.textContent).toContain("Verrail Workspace"));
  return root;
}

describe("VerrailManagementSidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("exposes real infrastructure capabilities as contextual navigation", async () => {
    const root = await renderSidebar(container, "infrastructure");

    expect(container.querySelector('[data-testid="verrail-infrastructure-sidebar"]')).not.toBeNull();
    expect(container.querySelector('a[href="/home"]')).not.toBeNull();
    expect(container.querySelector('a[href="/infrastructure"]')).not.toBeNull();
    expect(sidebarNavItemMock.mock.calls.map(([props]) => props.to)).toEqual([
      "/infrastructure/secrets",
      "/infrastructure/environments",
      "/infrastructure/adapters",
      "/infrastructure/plugins",
    ]);

    root.unmount();
  });

  it("organizes agents by definitions and deployment operations", async () => {
    const root = await renderSidebar(container, "agents");

    expect(container.querySelector('[data-testid="verrail-agents-sidebar"]')).not.toBeNull();
    expect(container.querySelector('a[href="/agents"]')).not.toBeNull();
    expect(sidebarNavItemMock.mock.calls.map(([props]) => props.to)).toEqual([
      "/agents/definitions",
      "/agents/deployments",
    ]);
    expect(container.querySelector('[data-testid="agent-list"]')?.textContent).toContain("list");

    root.unmount();
  });

  it("exposes governance work queues without placeholder pages", async () => {
    const root = await renderSidebar(container, "governance");

    expect(container.querySelector('[data-testid="verrail-governance-sidebar"]')).not.toBeNull();
    expect(container.querySelector('a[href="/governance"]')).not.toBeNull();
    expect(sidebarNavItemMock.mock.calls.map(([props]) => props.to)).toEqual([
      "/governance/attention",
      "/governance/approvals",
      "/governance/audit",
      "/governance/costs",
    ]);

    root.unmount();
  });
});
