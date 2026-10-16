// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { TargetConversations } from "./TargetConversations";
const list = vi.hoisted(() => vi.fn());
vi.mock("../../api/conversations", () => ({ conversationsApi: { list } }));
vi.mock("../../lib/router", () => ({ Link: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>, container: HTMLDivElement, client: QueryClient;
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });
it("returns to active and archived related conversations without creating another", async () => {
  list.mockImplementation(async (_workspace, options) => [{ id: options.status, title: `${options.status} discussion`, status: options.status, targetRelation: options.status === "active" ? "source" : "related" }]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); client = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}><TargetConversations workspaceId="workspace" targetId="target" /></QueryClientProvider>));
  expect(list).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(list).toHaveBeenCalledWith("workspace", { targetId: "target", status: "active" });
  expect(list).toHaveBeenCalledWith("workspace", { targetId: "target", status: "archived" });
  expect(document.querySelector('a[href="/chat/active"]')?.textContent).toContain("active discussion");
  expect(document.querySelector('a[href="/chat/active"]')?.textContent).toContain("Source");
  expect(document.querySelector('a[href="/chat/archived"] [aria-label="Archived"]')).not.toBeNull();
});
