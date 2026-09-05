// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTargetDialog } from "./NewTargetDialog";
import type { TargetCreationDraft } from "@paperclipai/shared";
import { ApiError } from "../api/client";

const createConversation = vi.hoisted(() => vi.fn());
const appendStructuredMessage = vi.hoisted(() => vi.fn());
const createTargetDraft = vi.hoisted(() => vi.fn());
const confirmTargetDraft = vi.hoisted(() => vi.fn());
const updateTargetDraft = vi.hoisted(() => vi.fn());
const defaults = vi.hoisted(() => ({ collectionId: "collection-1", draft: undefined as TargetCreationDraft | undefined }));
const closeNewTarget = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock("../api/conversations", () => ({ conversationsApi: {
  create: createConversation,
  appendStructuredMessage,
  createTargetDraft,
  confirmTargetDraft,
  updateTargetDraft,
} }));
vi.mock("../api/collections", () => ({
  collectionsApi: { list: vi.fn().mockResolvedValue([{ id: "collection-1", name: "Control plane" }]) },
}));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/access", () => ({
  accessApi: {
    listUserDirectory: vi.fn().mockResolvedValue({
      users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Owner", email: null, image: null } }],
    }),
  },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "workspace-1",
    selectedCompany: { id: "workspace-1", issuePrefix: "VER" },
  }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newTargetOpen: true,
    newTargetDefaults: defaults,
    closeNewTarget,
  }),
}));
vi.mock("@/lib/router", () => ({ useNavigate: () => navigate }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SelectTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => <div id={id}>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void, attempts = 30) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("NewTargetDialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    createConversation.mockReset();
    appendStructuredMessage.mockReset();
    createTargetDraft.mockReset();
    updateTargetDraft.mockReset();
    defaults.draft = undefined;
    confirmTargetDraft.mockReset();
    closeNewTarget.mockReset();
    navigate.mockReset();
  });

  it.each([false, true])("resumes the original channel draft and fails closed on a stale revision (%s)", async (stale) => {
    defaults.draft = {
      id: "feishu-draft", workspaceId: "workspace-1", conversationId: "feishu-conversation",
      sourceMessageId: "feishu-message", initiatedByPrincipalType: "user", initiatedByPrincipalId: "user-1",
      activeRevisionId: "draft-revision-1", convertedTargetId: null, convertedTargetRevisionId: null,
      confirmedByPrincipalType: null, confirmedByPrincipalId: null, confirmedAt: null, conversionIdempotencyKey: null,
      createdAt: new Date(), updatedAt: new Date(),
      activeRevisionNumber: 1, status: "collecting",
      activeRevision: { id: "draft-revision-1", workspaceId: "workspace-1", draftId: "feishu-draft", revisionNumber: 1,
        missingFields: [], fieldSources: {}, contentHash: "test-hash", createdByPrincipalType: "user", createdByPrincipalId: "user-1", createdAt: new Date(),
        definition: { title: "Feishu outcome", goal: "Preserve the original source.", summary: null,
        outcomeOwner: { principalType: "user", principalId: "user-1" }, collectionId: null,
        constraints: [], acceptanceCriteria: [{ title: "Source identity retained" }], riskLevel: "low",
        resourceRefs: [{ kind: "url", id: "https://example.com/source" }], deadline: null, policySummary: null } },
    };
    const updated = { ...defaults.draft, activeRevisionNumber: 2, status: "ready_for_confirmation" };
    if (stale) updateTargetDraft.mockRejectedValue(new ApiError("Revision changed", 409, {}));
    else updateTargetDraft.mockResolvedValue(updated);
    confirmTargetDraft.mockResolvedValue({ target: { workbenchHref: "/targets/target-1/overview" } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => root.render(<QueryClientProvider client={queryClient}><NewTargetDialog /></QueryClientProvider>));
    await waitFor(() => expect((container.querySelector("#new-target-title") as HTMLInputElement).value).toBe("Feishu outcome"));
    const button = () => Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Review draft")!;
    await waitFor(() => expect(button().disabled).toBe(false));
    await act(async () => button().click());
    await waitFor(() => expect(updateTargetDraft).toHaveBeenCalledWith("workspace-1", "feishu-conversation", "feishu-draft", 1,
      expect.objectContaining({ title: "Feishu outcome", resourceRefs: defaults.draft!.activeRevision.definition.resourceRefs })));
    expect(createConversation).not.toHaveBeenCalled();
    expect(appendStructuredMessage).not.toHaveBeenCalled();
    expect(createTargetDraft).not.toHaveBeenCalled();
    expect(confirmTargetDraft).not.toHaveBeenCalled();
    if (stale) {
      await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Reopen"));
      expect(navigate).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(container.textContent).toContain("Confirm Target"));
      await act(async () => Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Confirm Target")!.click());
      await waitFor(() => expect(confirmTargetDraft).toHaveBeenCalledWith("workspace-1", "feishu-conversation", "feishu-draft", 2));
    }
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("creates a reviewable draft before human confirmation opens the Workbench", async () => {
    createConversation.mockResolvedValue({ id: "conversation-1" });
    appendStructuredMessage.mockResolvedValue({ id: "message-1" });
    createTargetDraft.mockResolvedValue({
      id: "draft-1",
      conversationId: "conversation-1",
      activeRevisionNumber: 1,
      status: "ready_for_confirmation",
      activeRevision: { definition: {} },
    });
    confirmTargetDraft.mockResolvedValue({ target: {
      schemaVersion: 1,
      targetId: "target-1",
      targetRevisionId: "revision-1",
      workGraphId: "graph-1",
      graphRevisionId: "graph-revision-1",
      workbenchHref: "/targets/target-1/overview",
      replayed: false,
    } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => {
      root.render(<QueryClientProvider client={queryClient}><NewTargetDialog /></QueryClientProvider>);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Control plane");
      expect(container.textContent).toContain("Owner");
    });
    act(() => {
      setValue(container.querySelector("#new-target-title") as HTMLInputElement, "Governed Target");
      setValue(container.querySelector("#new-target-goal") as HTMLTextAreaElement, "Deliver a reviewable outcome.");
      setValue(container.querySelector('[aria-label="Criterion 1"]') as HTMLInputElement, "Evidence is attached");
    });
    await flush();

    const submit = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Review draft")!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await waitFor(() => expect(createTargetDraft).toHaveBeenCalledTimes(1));
    expect(confirmTargetDraft).not.toHaveBeenCalled();
    expect(createTargetDraft).toHaveBeenCalledWith(
      "workspace-1",
      "conversation-1",
      "message-1",
      expect.objectContaining({ title: "Governed Target" }),
    );

    await waitFor(() => {
      const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Confirm Target");
      expect(button).toBeTruthy();
    });
    const confirm = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Confirm Target")!;
    await act(async () => confirm.click());
    await waitFor(() => expect(confirmTargetDraft).toHaveBeenCalledWith("workspace-1", "conversation-1", "draft-1", 1));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/targets/target-1/overview"));
    expect(closeNewTarget).toHaveBeenCalled();
  });
});
