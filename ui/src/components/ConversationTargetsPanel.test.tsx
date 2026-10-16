// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail } from "@paperclipai/shared";
import { ConversationTargetsPanel } from "./ConversationTargetsPanel";

const mocks = vi.hoisted(() => ({ switchContext: vi.fn(), list: vi.fn(), getWorkspace: vi.fn(), create: vi.fn() }));
vi.mock("../api/conversations", () => ({ conversationsApi: { switchContext: mocks.switchContext } }));
vi.mock("../api/targets", () => ({ targetsApi: { list: mocks.list, getWorkspace: mocks.getWorkspace } }));
vi.mock("../lib/router", () => ({ Link: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const conversation = { id: "conversation", workspaceId: "workspace", status: "active", currentTargetId: "a", contextVersion: 3,
  contextBindings: [{ id: "binding", contextType: "target", contextId: "a", label: "Target A" }], messages: [] } as unknown as ConversationDetail;
let root: ReturnType<typeof createRoot>, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  mocks.list.mockResolvedValue({ items: [{ targetId: "b", title: "Target B" }], nextCursor: null });
  mocks.switchContext.mockResolvedValue({});
  mocks.getWorkspace.mockResolvedValue({ outcome: { state: "blocked" }, generatedAt: "2026-09-14T00:00:00Z", work: [{ id: "node", title: "Run CI", status: "blocked", completionDefinition: "Tests pass" }], attention: [{ id: "attention", kind: "blocked_node", detail: "Missing environment" }] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });
async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
async function render(value = conversation) { await act(async () => root.render(<QueryClientProvider client={client}><ConversationTargetsPanel conversation={value} onCreateTarget={mocks.create} /></QueryClientProvider>)); await flush(); }
function button(label: string) { return [...document.querySelectorAll("button")].find(b => b.textContent === label || b.getAttribute("aria-label") === label)!; }
async function click(label: string) { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()); await flush(); }
describe("conversation target management", () => {
  it("reads progress only when opened and links without changing focus", async () => {
    await render(); expect(mocks.getWorkspace).not.toHaveBeenCalled();
    await click("Targets · 1");
    expect(document.body.textContent).toContain("0/1 nodes completed");
    expect(document.body.textContent).toContain("Run CI");
    expect(document.body.textContent).toContain("Missing environment");
    await click("Link existing target"); await click("Link existing target Target B");
    expect(mocks.switchContext).toHaveBeenCalledWith("workspace", "conversation", { operation: "link", targetId: "b", expectedContextVersion: 3, idempotencyKey: expect.any(String) });
  });
  it("requires confirmation before unlinking and leaves conflicts visible", async () => {
    mocks.switchContext.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));
    await render(); await click("Targets · 1"); await click("Unlink target Target A");
    await render({ ...conversation, contextVersion: 4 });
    expect(mocks.switchContext).not.toHaveBeenCalled(); await click("Confirm");
    expect(mocks.switchContext).toHaveBeenCalledWith("workspace", "conversation", expect.objectContaining({ operation: "unlink", targetId: "a", expectedContextVersion: 3 }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Context changed");
  });
  it("allows archived conversations to read but not modify associations", async () => {
    await render({ ...conversation, status: "archived" }); await click("Targets · 1");
    expect(button("Unlink target Target A").disabled).toBe(true);
    expect(button("Link existing target").disabled).toBe(true);
    expect(mocks.getWorkspace).toHaveBeenCalledWith("workspace", "a");
  });
  it("shows unavailable progress instead of stale success", async () => {
    mocks.getWorkspace.mockRejectedValue(new Error("forbidden"));
    await render(); await click("Targets · 1");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Target progress is unavailable");
    expect(document.body.textContent).not.toContain("nodes completed");
  });
  it("starts explicit target creation from an empty association list", async () => {
    await render({ ...conversation, currentTargetId: null, contextBindings: [] }); await click("Targets · 0");
    expect(document.body.textContent).toContain("No related targets");
    const createButton = button("New Target");
    expect(createButton).toBeTruthy();
    await act(async () => createButton!.click()); expect(mocks.create).toHaveBeenCalledOnce();
  });
});
