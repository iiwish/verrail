// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerrailChat } from "./VerrailChat";

const mocks = vi.hoisted(() => ({ listTargetDrafts: vi.fn(), openNewTarget: vi.fn(), setBreadcrumbs: vi.fn(), get: vi.fn(), confirmTargetProposal: vi.fn() }));
vi.mock("../api/conversations", () => ({ conversationsApi: {
  runtime: vi.fn().mockResolvedValue({ mode: "local_compatibility" }),
  get: mocks.get.mockResolvedValue({ title: "Feishu chat", status: "active", messages: [], contextBindings: [] }),
  confirmTargetProposal: mocks.confirmTargetProposal,
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
  it.each(["archive", "restore"])("requires human confirmation for %s and explains execution is unchanged", async (operation) => {
    mocks.listTargetDrafts.mockResolvedValue([]);
    const message = { id: "archive-proposal", role: "tool", body: "Target", metadata: { kind: "director_target_proposal", targetId: "00000000-0000-4000-8000-000000000001", targetTitle: "Target", initiatedByPrincipalId: "owner", sourceMessageId: "00000000-0000-4000-8000-000000000002", before: { title: "Target", summary: null, goal: "Goal" }, input: { operation, expectedTargetRevisionId: "00000000-0000-4000-8000-000000000003", expectedArchiveVersion: 0 } } };
    mocks.get.mockResolvedValueOnce({ title: "Archive review", status: "active", contextBindings: [], messages: [{ ...message, workspaceId: "workspace-1", conversationId: "conversation-1" }] });
    mocks.confirmTargetProposal.mockResolvedValue({});
    await render();
    expect(container.textContent).toContain(operation === "archive" ? "Archiving does not stop running work" : "it does not restart work");
    expect(mocks.confirmTargetProposal).not.toHaveBeenCalled();
    const confirm = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Confirm change"));
    expect(confirm).toBeTruthy();
    await act(async () => confirm!.click());
    expect(mocks.confirmTargetProposal).toHaveBeenCalledWith("workspace-1", "conversation-1", "archive-proposal");
  });
  it("shows definition differences and requires an explicit click before mutation", async () => {
    mocks.listTargetDrafts.mockResolvedValue([]);
    const message = { id: "proposal", workspaceId: "workspace-1", conversationId: "conversation-1", role: "tool", body: "Original", metadata: { kind: "director_target_proposal", targetId: "00000000-0000-4000-8000-000000000001", targetTitle: "Original", initiatedByPrincipalId: "owner", sourceMessageId: "00000000-0000-4000-8000-000000000002", before: { title: "Original", summary: null, goal: "Goal" }, input: { operation: "update", expectedTargetRevisionId: "00000000-0000-4000-8000-000000000003", title: "Revised" } } };
    mocks.get.mockResolvedValueOnce({ title: "Review", status: "active", contextBindings: [], messages: [message] });
    mocks.confirmTargetProposal.mockResolvedValue({});
    await render();
    expect(container.querySelector("del")?.textContent).toBe("Original");
    expect(container.querySelector('header button[aria-label="Switch current Target"]')).not.toBeNull();
    expect(container.querySelector("header")?.textContent).not.toContain("New Target");
    expect(container.querySelector("ins")?.textContent).toBe("Revised");
    expect(mocks.confirmTargetProposal).not.toHaveBeenCalled();
    const confirm = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Confirm change"));
    expect(confirm).toBeTruthy();
    await act(async () => confirm!.click());
    expect(mocks.confirmTargetProposal).toHaveBeenCalledWith("workspace-1", "conversation-1", "proposal");
  });
  it("opens the original versioned draft and hides canceled or converted draft actions", async () => {
    const draft = { id: "channel-draft", workspaceId: "workspace-1", conversationId: "conversation-1", status: "collecting", activeRevisionNumber: 3, activeRevision: { definition: { title: "Channel outcome" } } };
    const converted = { ...draft, id: "done", status: "converted", convertedTargetId: "target-1" };
    mocks.listTargetDrafts.mockResolvedValue([draft, converted, { ...draft, id: "canceled", status: "canceled" }]);
    await render();
    expect(mocks.listTargetDrafts).toHaveBeenCalledWith("workspace-1", "conversation-1");
    const buttons = Array.from(container.querySelectorAll("button")).filter((button) => button.textContent?.includes("Continue draft"));
    expect(buttons).toHaveLength(1);
    expect(container.textContent).toContain("channel-draft");
    await act(async () => buttons[0]!.click());
    expect(mocks.openNewTarget).toHaveBeenCalledWith({ conversationId: "conversation-1", draft });
    const reply = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Channel reply");
    expect(reply).toBeTruthy();
    await act(async () => reply!.click());
    expect(mocks.openNewTarget).toHaveBeenCalledWith({ conversationId: "conversation-1", draft: converted });
  });
  it("surfaces load failure rather than silently hiding existing drafts", async () => {
    mocks.listTargetDrafts.mockRejectedValue(new Error("unavailable"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Target drafts could not be loaded");
    expect(container.querySelector('button[aria-label="Retry"]')).not.toBeNull();
  });
});
