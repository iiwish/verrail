// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collections } from "./Collections";

const list = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const setBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../api/collections", () => ({ collectionsApi: { list, create } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "workspace-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));
vi.mock("../components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function collectionFixture() {
  return { id: "collection-1", name: "Release work", description: "Ships governed releases", targetCount: 3 };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Collections", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    list.mockResolvedValue([collectionFixture()]);
    create.mockResolvedValue({ ...collectionFixture(), id: "collection-2", name: "Platform targets" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderCollections() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Collections />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("renders the collection list with target counts", async () => {
    await renderCollections();

    expect(list).toHaveBeenCalledWith("workspace-1");
    expect(container.textContent).toContain("Release work");
    expect(container.textContent).toContain("Ships governed releases");
    expect(container.textContent).toContain("3 targets");
  });

  it("creates a collection through the dialog", async () => {
    await renderCollections();

    const openButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("New Collection"));
    expect(openButton).toBeDefined();

    await act(async () => openButton?.click());
    await flushReact();

    const dialog = container.querySelector('[data-testid="dialog-content"]');
    expect(dialog).not.toBeNull();

    const nameInput = dialog?.querySelector("#collection-name");
    expect(nameInput).not.toBeNull();
    await act(async () => setValue(nameInput as HTMLInputElement, "Platform targets"));

    const submitButton = Array.from(dialog?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.textContent?.includes("New Collection"));
    expect(submitButton).toBeDefined();

    await act(async () => submitButton?.click());
    await flushReact();

    expect(create).toHaveBeenCalledWith("workspace-1", { name: "Platform targets" });
  });

  it("renders a visible failure when collections cannot be loaded", async () => {
    list.mockRejectedValue(new Error("projection unavailable"));

    await renderCollections();

    expect(container.textContent).toContain("Collections could not be loaded.");
  });
});
