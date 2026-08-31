// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { NewTargetDialog } from "./NewTargetDialog";

const createTarget = vi.hoisted(() => vi.fn());
const closeNewTarget = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock("../api/targets", () => ({ targetsApi: { create: createTarget } }));
vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([{ id: "project-1", name: "Control plane", archivedAt: null }]) },
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
    newTargetDefaults: { projectId: "project-1" },
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
    createTarget.mockReset();
    closeNewTarget.mockReset();
    navigate.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the idempotency key across a retry and opens the issued Workbench URL", async () => {
    createTarget
      .mockRejectedValueOnce(new ApiError("Unavailable", 503, { code: "TARGET_DOMAIN_API_UNAVAILABLE" }))
      .mockResolvedValueOnce({
        schemaVersion: 1,
        targetId: "target-1",
        targetRevisionId: "revision-1",
        workbenchHref: "/targets/target-1/overview",
        replayed: false,
      });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => {
      root.render(<QueryClientProvider client={queryClient}><NewTargetDialog /></QueryClientProvider>);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Control plane");
      expect(container.textContent).toContain("Owner");
    });
    setValue(container.querySelector("#new-target-title") as HTMLInputElement, "Governed Target");
    setValue(container.querySelector("#new-target-goal") as HTMLTextAreaElement, "Deliver a reviewable outcome.");
    setValue(container.querySelector('[aria-label="Criterion 1"]') as HTMLInputElement, "Evidence is attached");
    await flush();

    const submit = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "New Target")!;
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    await waitFor(() => expect(createTarget).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.textContent).toContain("temporarily unavailable"));

    act(() => submit.click());
    await waitFor(() => expect(createTarget).toHaveBeenCalledTimes(2));
    expect(createTarget.mock.calls[0]?.[2]).toBe(createTarget.mock.calls[1]?.[2]);
    expect(createTarget.mock.calls[1]?.[1]).toMatchObject({
      projectId: "project-1",
      title: "Governed Target",
      outcomeOwner: { principalType: "user", principalId: "user-1" },
      acceptanceCriteria: [{ title: "Evidence is attached" }],
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/targets/target-1/overview"));
    expect(closeNewTarget).toHaveBeenCalled();
  });
});
