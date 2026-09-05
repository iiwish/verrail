// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerrailChat } from "./VerrailChat";

const mocks = vi.hoisted(() => ({ listTargetDrafts: vi.fn(), openNewTarget: vi.fn(), setBreadcrumbs: vi.fn() }));
vi.mock("../api/conversations", () => ({ conversationsApi: {
  get: vi.fn().mockResolvedValue({ title: "Feishu chat", status: "active", messages: [], contextBindings: [] }),
  listTargetDrafts: mocks.listTargetDrafts,
} }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "workspace-1", selectedCompany: { name: "Workspace" } }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewTarget: mocks.openNewTarget }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn(), useParams: () => ({ conversationId: "conversation-1" }) }));
vi.mock("../components/ChatComposer", () => ({ ChatComposer: () => <div /> }));
vi.mock("../components/MarkdownBody", () => ({ MarkdownBody: () => <div /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let client: QueryClient;
afterEach(() => { act(() => root?.unmount()); client?.clear(); container?.remove(); vi.clearAllMocks(); });

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  await act(async () => root.render(<QueryClientProvider client={client}><VerrailChat /></QueryClientProvider>));
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Verrail Chat channel drafts", () => {
  it("opens the original versioned draft and hides canceled or converted draft actions", async () => {
    const draft = { id: "channel-draft", workspaceId: "workspace-1", conversationId: "conversation-1", status: "collecting", activeRevisionNumber: 3, activeRevision: { definition: { title: "Channel outcome" } } };
    mocks.listTargetDrafts.mockResolvedValue([draft, { ...draft, id: "done", status: "converted" }, { ...draft, id: "canceled", status: "canceled" }]);
    await render();
    expect(mocks.listTargetDrafts).toHaveBeenCalledWith("workspace-1", "conversation-1");
    const buttons = Array.from(container.querySelectorAll("button")).filter((button) => button.textContent?.includes("Continue draft"));
    expect(buttons).toHaveLength(1);
    expect(container.textContent).toContain("channel-draft");
    await act(async () => buttons[0]!.click());
    expect(mocks.openNewTarget).toHaveBeenCalledWith({ conversationId: "conversation-1", draft });
  });
  it("surfaces load failure rather than silently hiding existing drafts", async () => {
    mocks.listTargetDrafts.mockRejectedValue(new Error("unavailable"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Target drafts could not be loaded");
    expect(container.querySelector('button[aria-label="Retry"]')).not.toBeNull();
  });
});
