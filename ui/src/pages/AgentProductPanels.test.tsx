// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { AgentProductOverview, AgentWorkRecords, DirectorCapabilities } from "./AgentProductPanels";

const api = vi.hoisted(() => ({ conversations: vi.fn(), director: vi.fn(), skills: vi.fn(), lifecycle: vi.fn() }));
vi.mock("../api/agentLifecycle", () => ({ agentLifecycleApi: { get: api.lifecycle } }));
vi.mock("../api/agents", () => ({ agentsApi: { directorInstructions: api.director, skills: api.skills } }));
vi.mock("../api/conversations", () => ({ conversationsApi: { list: api.conversations } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const director = { id: "director-id", companyId: "workspace-id", name: "Director", urlKey: "director", status: "idle", role: "ceo", adapterType: "claude_local", adapterConfig: { model: "adapter-model-not-chat" }, metadata: { paperclipBuiltInAgent: { key: "director", managed: true } } } as unknown as Agent;

describe("agent product panels", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.conversations.mockResolvedValue([]);
    api.director.mockResolvedValue({ runtime: "codex", available: true });
    api.lifecycle.mockResolvedValue({ definitions: [{ compatibilityAgentId: "director-id", versions: [{ id: "version", runtime: "codex", model: "pinned-model" }], deployments: [{ isPrimary: true, status: "active", activeRevision: { agentVersionId: "version" } }] }] });
    api.skills.mockResolvedValue({ entries: [], desiredSkills: [] });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function render(element: ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
    for (let n = 0; n < 10; n++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  const workProps = { agent: director, runs: [], runsLoading: false, runsError: false, retryRuns: vi.fn() };

  it("shows the actual conversation runtime rather than the execution adapter", async () => {
    await render(<AgentProductOverview {...workProps} />);
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).not.toContain("adapter-model-not-chat");
    expect(container.textContent).not.toContain("CEO");
    expect(container.querySelector('a[href="/agents/director/instructions"]')).toBeNull();
    expect(container.querySelector('a[href="/agents/director/tools"]')).toBeNull();
    expect(container.querySelector('a[href="/agents/director/configuration"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-recent-work"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-work-records"]')).toBeNull();
    expect(api.conversations).not.toHaveBeenCalled();
  });
  it("requests only authored conversations for the current workspace and agent", async () => {
    await render(<AgentWorkRecords {...workProps} />);
    expect(api.conversations).toHaveBeenCalledWith("workspace-id", { agentId: "director-id" });
    expect(api.conversations).toHaveBeenCalledWith("workspace-id", { agentId: "director-id", status: "archived" });
  });
  it("links conversations and execution summaries without exposing raw transcript text", async () => {
    api.conversations.mockImplementation(async (_workspace, options) => options.status === "archived" ? [] : [{ id: "conversation-1", title: "Delivery discussion", status: "active", updatedAt: "2026-09-11T08:00:00Z" }]);
    const run = { id: "run-1", status: "failed", createdAt: "2026-09-11T09:00:00Z", contextSnapshot: { taskTitle: "Build the page" }, error: "Permission denied", stdoutExcerpt: "raw transcript", resultJson: null } as unknown as HeartbeatRun;
    await render(<AgentWorkRecords {...workProps} runs={[run]} />);
    expect(container.querySelector('a[href="/chat/conversation-1"]')).not.toBeNull();
    expect(container.querySelector('a[href="/agents/director/runs/run-1"]')).toBeNull();
    await act(async () => {
      const tab = container.querySelector<HTMLButtonElement>('[role="tab"][data-state="inactive"]')!;
      tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      tab.click();
    });
    expect(container.querySelector('a[href="/chat/conversation-1"]')).toBeNull();
    expect(container.querySelector('a[href="/agents/director/runs/run-1"]')?.textContent).toContain("Permission denied");
    expect(container.textContent).not.toContain("raw transcript");
    expect(container.textContent).toContain("not delivery acceptance");
  });
  it("shows failed reads instead of claiming there is no work", async () => {
    api.conversations.mockRejectedValue(new Error("denied"));
    await render(<AgentWorkRecords {...workProps} />);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No recorded replies");
  });
  it("does not label Claude as having live target tools", async () => {
    api.director.mockResolvedValue({ runtime: "claude", available: true });
    api.lifecycle.mockResolvedValue({ definitions: [{ compatibilityAgentId: "director-id", versions: [{ id: "version", runtime: "claude" }], deployments: [{ isPrimary: true, status: "active", activeRevision: { agentVersionId: "version" } }] }] });
    await render(<DirectorCapabilities agent={director} />);
    const row = Array.from(container.querySelectorAll("h4")).find((heading) => heading.textContent === "Inspect targets")?.parentElement?.parentElement;
    expect(row?.textContent).toContain("Not connected");
  });
  it("shows configured Director skills as not loaded, without a misleading enable toggle", async () => {
    api.skills.mockResolvedValue({ entries: [{ key: "example/skill", desired: true, state: "configured" }] });
    await render(<DirectorCapabilities agent={director} skills />);
    expect(container.textContent).toContain("Not loaded in conversation");
    expect(container.querySelector('[role="switch"], input[type="checkbox"]')).toBeNull();
  });
});
