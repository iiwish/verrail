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
const getTargetDraftChannelReply = vi.hoisted(() => vi.fn());
const reconcileTargetDraftChannelReply = vi.hoisted(() => vi.fn());
const defaults = vi.hoisted(() => ({ collectionId: "collection-1", draft: undefined as TargetCreationDraft | undefined }));
const dialogState = vi.hoisted(() => ({ open: true }));
const closeNewTarget = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const pushToast = vi.hoisted(() => vi.fn());
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast }) }));

vi.mock("../api/conversations", () => ({ conversationsApi: {
  create: createConversation,
  appendStructuredMessage,
  createTargetDraft,
  confirmTargetDraft,
  updateTargetDraft,
  getTargetDraftChannelReply,
  reconcileTargetDraftChannelReply,
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
    newTargetOpen: dialogState.open,
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
    getTargetDraftChannelReply.mockReset();
    reconcileTargetDraftChannelReply.mockReset();
    defaults.draft = undefined;
    dialogState.open = true;
    confirmTargetDraft.mockReset();
    closeNewTarget.mockReset();
    navigate.mockReset();
    pushToast.mockReset();
  });

  function convertedDraft(workspaceId = "workspace-1"): TargetCreationDraft {
    return {
      id: "converted-draft", workspaceId, conversationId: "feishu-conversation", status: "converted",
      activeRevisionNumber: 2, activeRevisionId: "revision-2", sourceMessageId: "source-1",
      convertedTargetId: "target-1", convertedTargetRevisionId: "target-revision-1",
      initiatedByPrincipalType: "user", initiatedByPrincipalId: "user-1",
      confirmedByPrincipalType: "user", confirmedByPrincipalId: "user-1",
      confirmedAt: new Date(), conversionIdempotencyKey: "key-1", createdAt: new Date(), updatedAt: new Date(),
      activeRevision: { id: "revision-2", workspaceId, draftId: "converted-draft", revisionNumber: 2,
        createdByPrincipalType: "user", createdByPrincipalId: "user-1", createdAt: new Date(),
        missingFields: [], fieldSources: {}, contentHash: "hash",
        definition: { title: "Created outcome", summary: null, collectionId: null, outcomeOwner: null,
          goal: "Completed", constraints: [], acceptanceCriteria: [], resourceRefs: [], riskLevel: "low", deadline: null, policySummary: null } },
    };
  }

  async function renderRecovery() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={queryClient}><NewTargetDialog /></QueryClientProvider>));
    return queryClient;
  }

  const recoveryButton = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Verify existing reply");

  it.each(["unknown", "sending"])("explicitly reconciles a %s receipt without repeating Target creation", async (status) => {
    defaults.draft = convertedDraft();
    getTargetDraftChannelReply.mockResolvedValue({ status, receiptId: "receipt-1" });
    let finish!: (value: unknown) => void;
    reconcileTargetDraftChannelReply.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await renderRecovery();
    await waitFor(() => expect(recoveryButton()).toBeTruthy());
    expect(recoveryButton()!.disabled).toBe(true);
    expect(reconcileTargetDraftChannelReply).not.toHaveBeenCalled();
    const input = container.querySelector('input[aria-label="Feishu message ID"]') as HTMLInputElement;
    act(() => setValue(input, "https://example.com/message"));
    expect(recoveryButton()!.disabled).toBe(true);
    act(() => setValue(input, " om_reply-1 "));
    await act(async () => recoveryButton()!.click());
    await waitFor(() => expect(reconcileTargetDraftChannelReply).toHaveBeenCalledWith("workspace-1", "feishu-conversation", "converted-draft", "om_reply-1"));
    expect(input.disabled).toBe(true);
    expect(reconcileTargetDraftChannelReply).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "succeeded", receiptId: "receipt-1" }));
    await waitFor(() => expect(container.textContent).toContain("Reply confirmed"));
    expect(container.querySelector('input[aria-label="Feishu message ID"]')).toBeNull();
    expect(confirmTargetDraft).not.toHaveBeenCalled();
    expect(updateTargetDraft).not.toHaveBeenCalled();
    expect(createTargetDraft).not.toHaveBeenCalled();
    expect(container.querySelector("#new-target-title")).toBeNull();
  });

  it.each([403, 409, 503])("keeps reconciliation errors visible without retrying (%s)", async (status) => {
    defaults.draft = convertedDraft();
    getTargetDraftChannelReply.mockResolvedValue({ status: "unknown", receiptId: "receipt-1" });
    reconcileTargetDraftChannelReply.mockRejectedValue(new ApiError("private diagnostic", status, {}));
    await renderRecovery();
    await waitFor(() => expect(recoveryButton()).toBeTruthy());
    act(() => setValue(container.querySelector('input[aria-label="Feishu message ID"]') as HTMLInputElement, "om_reply"));
    await act(async () => recoveryButton()!.click());
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).not.toContain("private diagnostic");
    expect(reconcileTargetDraftChannelReply).toHaveBeenCalledTimes(1);
    expect(confirmTargetDraft).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "blocked", "not_applicable"])("does not offer recovery for %s", async (status) => {
    defaults.draft = convertedDraft();
    getTargetDraftChannelReply.mockResolvedValue({ status, receiptId: null });
    await renderRecovery();
    await waitFor(() => expect(getTargetDraftChannelReply).toHaveBeenCalled());
    await flush();
    expect(recoveryButton()).toBeUndefined();
    expect(container.querySelector("#new-target-title")).toBeNull();
    expect(confirmTargetDraft).not.toHaveBeenCalled();
  });

  it("refuses a converted draft from another Workspace before any receipt request", async () => {
    defaults.draft = convertedDraft("other-workspace");
    await renderRecovery();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(getTargetDraftChannelReply).not.toHaveBeenCalled();
    expect(recoveryButton()).toBeUndefined();
  });

  it("shows receipt read failure with an explicit retry", async () => {
    defaults.draft = convertedDraft();
    getTargetDraftChannelReply.mockRejectedValueOnce(new Error("private read detail"))
      .mockResolvedValue({ status: "succeeded", receiptId: "receipt-1" });
    await renderRecovery();
    await waitFor(() => expect(container.querySelector('button[aria-label="Refresh reply status"]')).not.toBeNull());
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).not.toContain("private read detail");
    await act(async () => (container.querySelector('button[aria-label="Refresh reply status"]') as HTMLButtonElement).click());
    await waitFor(() => expect(container.textContent).toContain("Reply confirmed"));
    expect(reconcileTargetDraftChannelReply).not.toHaveBeenCalled();
  });

  it("clears candidate IDs on close and ignores completion from a different draft", async () => {
    defaults.draft = convertedDraft();
    getTargetDraftChannelReply.mockResolvedValue({ status: "unknown", receiptId: "receipt-1" });
    let finish!: (value: unknown) => void;
    reconcileTargetDraftChannelReply.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const client = await renderRecovery();
    const rerender = async () => {
      await act(async () => root.render(<QueryClientProvider client={client}><NewTargetDialog /></QueryClientProvider>));
    };
    await waitFor(() => expect(recoveryButton()).toBeTruthy());
    act(() => setValue(container.querySelector('input[aria-label="Feishu message ID"]') as HTMLInputElement, "om_old"));
    await act(async () => recoveryButton()!.click());
    dialogState.open = false;
    await rerender();
    defaults.draft = { ...convertedDraft(), id: "second-draft", activeRevisionId: "revision-3" };
    dialogState.open = true;
    await rerender();
    await waitFor(() => expect(recoveryButton()).toBeTruthy());
    expect((container.querySelector('input[aria-label="Feishu message ID"]') as HTMLInputElement).value).toBe("");
    await act(async () => finish({ status: "succeeded", receiptId: "receipt-1" }));
    await flush();
    expect(container.textContent).not.toContain("Reply confirmed");
    expect(reconcileTargetDraftChannelReply).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("preserves an unknown result without automatic reconciliation or confirmation retries", async () => {
    defaults.draft = convertedDraft();
    getTargetDraftChannelReply.mockResolvedValue({ status: "unknown", receiptId: "receipt-1" });
    reconcileTargetDraftChannelReply.mockResolvedValue({ status: "unknown", receiptId: "receipt-1" });
    await renderRecovery();
    await waitFor(() => expect(recoveryButton()).toBeTruthy());
    act(() => setValue(container.querySelector('input[aria-label="Feishu message ID"]') as HTMLInputElement, "om_unmatched"));
    await act(async () => recoveryButton()!.click());
    await waitFor(() => expect(container.textContent).toContain("No message was resent"));
    expect(reconcileTargetDraftChannelReply).toHaveBeenCalledTimes(1);
    expect(confirmTargetDraft).not.toHaveBeenCalled();
  });

  it("does not let an older status refresh overwrite successful reconciliation", async () => {
    defaults.draft = convertedDraft();
    getTargetDraftChannelReply.mockResolvedValueOnce({ status: "unknown", receiptId: "receipt-1" });
    let finish!: (value: unknown) => void;
    let finishRead!: (value: unknown) => void;
    reconcileTargetDraftChannelReply.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    getTargetDraftChannelReply.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const client = await renderRecovery();
    await waitFor(() => expect(recoveryButton()).toBeTruthy());
    act(() => setValue(container.querySelector('input[aria-label="Feishu message ID"]') as HTMLInputElement, "om_candidate"));
    await act(async () => recoveryButton()!.click());
    act(() => { void client.refetchQueries(); });
    await waitFor(() => expect(getTargetDraftChannelReply).toHaveBeenCalledTimes(2));
    await act(async () => finish({ status: "succeeded", receiptId: "receipt-1" }));
    await act(async () => finishRead({ status: "unknown", receiptId: "receipt-1" }));
    await waitFor(() => expect(container.textContent).toContain("Reply confirmed"));
    expect(recoveryButton()).toBeUndefined();
  });

  it.each(["stale", "succeeded", "unknown", "sending", "blocked"])("resumes the original channel draft and handles confirmation (%s)", async (status) => {
    const stale = status === "stale";
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
    confirmTargetDraft.mockResolvedValue({ target: { workbenchHref: "/targets/target-1/overview" }, channelReply: { status, receiptId: null } });
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
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/targets/target-1/overview"));
      if (status === "succeeded") expect(pushToast).not.toHaveBeenCalled();
      else expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "warn", body: expect.stringContaining("Do not create another Target") }));
      expect(confirmTargetDraft).toHaveBeenCalledTimes(1);
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
