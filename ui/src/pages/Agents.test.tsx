// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { Agents } from "./Agents";

const state = vi.hoisted(() => ({ companyId: "workspace", pathname: "/agents", navigate: vi.fn(), create: vi.fn() }));
const api = vi.hoisted(() => ({ list: vi.fn(), builtIns: vi.fn(), settings: vi.fn(), live: vi.fn() }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => state.navigate,
  useLocation: () => ({ pathname: state.pathname }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewAgent: state.create }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: api.list } }));
vi.mock("../api/builtInAgents", () => ({ builtInAgentsApi: { list: api.builtIns } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { get: api.settings } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: api.live } }));
vi.mock("../hooks/useSharedPolling", () => ({ useSharedPollingQuery: () => ({ enabled: true, refetchInterval: false }), usePublishSharedQueryData: vi.fn() }));
vi.mock("../hooks/useResourceMemberships", () => ({ useResourceMemberships: () => ({ data: {} }), useResourceMembershipMutation: () => ({ mutate: vi.fn(), isPending: false }), isStarred: () => false }));
vi.mock("../adapters/adapter-display-registry", () => ({ getAdapterLabel: (type: string) => type }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent", companyId: "workspace", name: "Alpha", urlKey: "alpha", role: "engineer", title: null,
    icon: null, status: "active", reportsTo: null, capabilities: "Review delivery evidence", adapterType: "codex_local",
    adapterConfig: { model: "fixture-model" }, runtimeConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0,
    pauseReason: null, pausedAt: null, permissions: { canCreateAgents: false }, lastHeartbeatAt: null, metadata: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

describe("product agent roster", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  beforeEach(async () => {
    vi.clearAllMocks(); await i18n.changeLanguage("en");
    state.companyId = "workspace"; state.pathname = "/agents";
    api.list.mockResolvedValue([agent()]); api.builtIns.mockResolvedValue([]);
    api.settings.mockResolvedValue({ experimental: { enableBuiltInAgents: false } }); api.live.mockResolvedValue([]);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function flush() { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); }
  async function render() { await act(async () => root.render(<QueryClientProvider client={client}><Agents /></QueryClientProvider>)); await flush(); }
  function rows() { return [...container.querySelectorAll('[data-testid="agent-roster-row"]')]; }

  it("shows purpose, runtime, model and detail navigation without the retired org controls", async () => {
    await render(); expect(api.list).toHaveBeenCalledWith("workspace");
    const row = rows()[0]!;
    expect(row.textContent).toContain("Alpha"); expect(row.textContent).toContain("Review delivery evidence");
    expect(row.textContent).toContain("codex_local"); expect(row.textContent).toContain("fixture-model");
    expect(row.querySelector('a[href="/agents/alpha"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Group agents"]')).toBeNull();
  });
  it("keeps the mobile identity full-width and trailing actions at stable widths", async () => {
    await render(); const row = rows()[0]!;
    expect(row.querySelector("a")?.classList.contains("basis-full")).toBe(true);
    expect(row.querySelector(".w-16.shrink-0")).not.toBeNull();
  });
  it("opens the creation dialog from the roster", async () => {
    await render(); const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(i18n.t("agents.newAction")));
    expect(button).toBeDefined(); await act(async () => button!.click()); expect(state.create).toHaveBeenCalledOnce();
  });
  it("uses route state to filter paused agents", async () => {
    state.pathname = "/agents/paused"; api.list.mockResolvedValue([agent(), agent({ id: "paused", name: "Paused worker", status: "paused" })]);
    await render(); expect(rows()).toHaveLength(1); expect(rows()[0]!.textContent).toContain("Paused worker");
  });
  it("keeps Director in the built-in filter without enabling optional built-in agents", async () => {
    state.pathname = "/agents/builtin";
    api.list.mockResolvedValue([agent(), agent({ id: "director", name: "Director", metadata: { paperclipBuiltInAgent: { key: "director", managed: true } } })]);
    await render(); expect(rows()).toHaveLength(1); expect(rows()[0]!.textContent).toContain("Director");
    expect(rows()[0]!.querySelector('a[href="/chat"]')).not.toBeNull(); expect(api.builtIns).not.toHaveBeenCalled();
  });
  it("includes enabled optional built-in agents in the built-in filter", async () => {
    state.pathname = "/agents/builtin"; api.settings.mockResolvedValue({ experimental: { enableBuiltInAgents: true } });
    api.builtIns.mockResolvedValue([{ agentId: "agent", status: "ready" }]);
    await render(); expect(api.builtIns).toHaveBeenCalledWith("workspace"); expect(rows()).toHaveLength(1);
  });
  it("links active work to its run", async () => {
    api.live.mockResolvedValue([{ id: "run", agentId: "agent", status: "running", currentStatusMessage: "Checking evidence" }]);
    await render(); expect(container.querySelector('a[href="/agents/alpha/runs/run"]')?.textContent).toBe("Checking evidence");
  });
  it("surfaces roster failures with a retry instead of an empty success", async () => {
    api.list.mockRejectedValue(new Error("offline")); await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(rows()).toHaveLength(0);
    api.list.mockResolvedValue([agent()]);
    const retry = container.querySelector('[role="alert"] button') as HTMLButtonElement;
    await act(async () => retry.click()); await flush(); expect(rows()).toHaveLength(1);
  });
  it("keeps error-state agents visible in the attention filter", async () => {
    state.pathname = "/agents/error"; api.list.mockResolvedValue([agent(), agent({ id: "error", name: "Needs recovery", status: "error" })]);
    await render(); expect(rows()).toHaveLength(1); expect(rows()[0]!.textContent).toContain("Needs recovery");
    expect(rows()[0]!.querySelector('[aria-label="Needs attention"]')).not.toBeNull();
  });
  it("does not query a roster without a selected workspace", async () => {
    state.companyId = ""; await render(); expect(api.list).not.toHaveBeenCalled(); expect(rows()).toHaveLength(0);
  });
});
