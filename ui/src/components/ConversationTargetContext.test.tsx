// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationMessage } from "@paperclipai/shared";
import { ConversationTargetContext, ConversationContextChange, FocusCreatedTarget } from "./ConversationTargetContext";

const mocks = vi.hoisted(() => ({ switchContext: vi.fn(), list: vi.fn() }));
vi.mock("../api/conversations", () => ({ conversationsApi: { switchContext: mocks.switchContext } }));
vi.mock("../api/targets", () => ({ targetsApi: { list: mocks.list } }));
vi.mock("../lib/router", () => ({ Link: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>, container: HTMLDivElement, client: QueryClient;
const conversation = { id: "conversation", workspaceId: "workspace", status: "active", currentTargetId: "target-a", contextVersion: 3, currentTarget: { targetId: "target-a", title: "Target A", archivedAt: null }, contextBindings: [], messages: [] } as unknown as ConversationDetail;
async function render(element: React.ReactNode) {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => { act(() => root?.unmount()); client?.clear(); container?.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe("Conversation Target context", () => {
  it("clears focus with the displayed context version, without deleting the Target", async () => {
    mocks.switchContext.mockResolvedValue({});
    await render(<ConversationTargetContext conversation={conversation} />);
    expect(container.textContent).toContain("Target A");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Clear current Target"]')).toBeNull();
    expect(document.querySelector('[cmdk-item]')).toBeNull();
    await act(async () => (container.querySelector('button[aria-label="Switch current Target"]') as HTMLButtonElement).click());
    const clear = document.querySelector('[cmdk-item][data-value="clear-current-target"]') as HTMLElement;
    expect(clear.textContent).toContain("Clear current Target");
    await act(async () => clear.click());
    expect(mocks.switchContext).toHaveBeenCalledWith("workspace", "conversation", { targetId: null, expectedContextVersion: 3, idempotencyKey: expect.any(String) });
    expect(document.querySelector('[cmdk-item]')).toBeNull();
  });
  it("offers version-bound undo only for the still-current change", async () => {
    mocks.switchContext.mockResolvedValue({});
    const message = { metadata: { kind: "conversation_context_changed", previousTargetId: "target-b", currentTargetId: "target-a", contextVersion: 3, targetTitle: "Target A" } } as unknown as ConversationMessage;
    await render(<ConversationContextChange conversation={conversation} message={message} />);
    await act(async () => (container.querySelector('button[aria-label="Restore previous context"]') as HTMLButtonElement).click());
    expect(mocks.switchContext).toHaveBeenCalledWith("workspace", "conversation", { targetId: "target-b", expectedContextVersion: 3, idempotencyKey: expect.any(String) });
    await act(async () => root.render(<QueryClientProvider client={client}><ConversationContextChange conversation={{ ...conversation, contextVersion: 4 }} message={message} /></QueryClientProvider>));
    expect(container.querySelector("button")).toBeNull();
  });
  it("surfaces conflicts and does not silently retry using a newer version", async () => {
    mocks.switchContext.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));
    await render(<FocusCreatedTarget conversation={conversation} targetId="target-b" />);
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Context changed");
    expect(mocks.switchContext).toHaveBeenCalledTimes(1);
  });
  it("shows archived focus without replacing it and disables switching in archived conversations", async () => {
    await render(<ConversationTargetContext conversation={{ ...conversation, status: "archived", currentTarget: { ...conversation.currentTarget!, archivedAt: "2026-09-11T00:00:00Z" } }} />);
    expect(container.querySelector('[aria-label="Archived"]')).not.toBeNull();
    expect((container.querySelector('button[aria-label="Switch current Target"]') as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.switchContext).not.toHaveBeenCalled();
  });
});
