// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorInstructionsView } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { DirectorInstructionsTab } from "./DirectorInstructionsTab";

const api = vi.hoisted(() => ({ directorInstructions: vi.fn(), previewDirectorInstructions: vi.fn(), applyDirectorInstructions: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function model(overrides: Partial<DirectorInstructionsView> = {}): DirectorInstructionsView {
  return { schemaVersion: 1, mode: "local_compatibility", runtime: "codex", available: true,
    revision: 0, configHash: "a".repeat(64), roleSource: "builtin", rolePrompt: "# Director\nCoordinate useful work.",
    defaultPrompt: "# Director\nCoordinate useful work.", roleHash: "b".repeat(64), policyVersion: "director-chat.v1",
    platformRules: "Platform controls", toolRules: "Actual tool restrictions", systemPrompt: "Effective built-in prompt",
    effectiveHash: "c".repeat(64), appliedAt: null, preview: false, ...overrides };
}

describe("Director instructions", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const dirty = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    api.directorInstructions.mockResolvedValue(model());
    api.previewDirectorInstructions.mockImplementation(async (_id, rolePrompt) => model({ rolePrompt, systemPrompt: `PREVIEW ${rolePrompt}`, preview: true }));
    api.applyDirectorInstructions.mockImplementation(async (_id, input) => model({ rolePrompt: input.rolePrompt, revision: 1, configHash: "d".repeat(64), roleSource: "custom" }));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    await i18n.changeLanguage("en");
  });
  async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
  async function waitFor(check: () => void) {
    let error: unknown;
    for (let i = 0; i < 40; i++) { try { check(); return; } catch (cause) { error = cause; await flush(); } }
    throw error;
  }
  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}><DirectorInstructionsTab agentId="director-1" companyId="workspace-1" onDirtyChange={dirty} /></QueryClientProvider>));
    await waitFor(() => expect(container.querySelector("textarea")).not.toBeNull());
  }
  function button(text: string) {
    const found = Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === text);
    expect(found, `button ${text}`).toBeTruthy();
    return found!;
  }
  async function click(text: string) { await act(async () => button(text).click()); await flush(); }
  async function edit(value: string) {
    await act(async () => {
      const textarea = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
  }

  it("shows the real default rather than an empty AGENTS.md placeholder", async () => {
    await render();
    expect(container.querySelector("textarea")!.value).toBe(model().rolePrompt);
    expect(container.textContent).toContain("Workspace coordination agent");
    expect(container.textContent).toContain("Local compatibility chat");
    expect(button("Save draft").disabled).toBe(true);
  });

  it("keeps drafts inactive, previews without a model run, and only applies after confirmation", async () => {
    await render();
    await edit("A better role");
    expect(api.applyDirectorInstructions).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenLastCalledWith(true);
    await click("Preview instructions");
    await waitFor(() => expect(container.textContent).toContain("PREVIEW A better role"));
    expect(container.textContent).toContain("No model run");
    expect(api.previewDirectorInstructions).toHaveBeenCalledWith("director-1", "A better role", "workspace-1");
    await click("Save draft");
    expect(api.applyDirectorInstructions).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("In-flight replies remain unchanged");
    await click("Confirm and save");
    await waitFor(() => expect(api.applyDirectorInstructions).toHaveBeenCalledWith("director-1", {
      rolePrompt: "A better role", expectedConfigHash: "a".repeat(64),
    }, "workspace-1"));
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  });

  it("does not hide a conflict or replace a draft's expected revision on refetch", async () => {
    await render();
    await edit("Local draft");
    await act(async () => client.setQueryData(queryKeys.agents.directorInstructions("director-1", "workspace-1"), model({ configHash: "e".repeat(64), rolePrompt: "Another operator changed this" })));
    await flush();
    expect(container.querySelector("textarea")!.value).toBe("Local draft");
    expect(button("Save draft").disabled).toBe(true);
    expect(container.textContent).toContain("active instructions changed");
  });

  it("preserves the draft and exposes permission failures", async () => {
    api.applyDirectorInstructions.mockRejectedValue(new ApiError("Denied", 403, {}));
    await render();
    await edit("Keep my draft");
    await click("Save draft");
    await click("Confirm and save");
    await waitFor(() => expect(container.textContent).toContain("do not have permission"));
    expect(container.querySelector("textarea")!.value).toBe("Keep my draft");
    expect(dirty).toHaveBeenLastCalledWith(true);
  });

  it("loads defaults into a draft without applying or claiming publication", async () => {
    api.directorInstructions.mockResolvedValue(model({ roleSource: "custom", revision: 2, rolePrompt: "Custom instructions" }));
    await render();
    await click("Use default as draft");
    expect(container.querySelector("textarea")!.value).toBe(model().defaultPrompt);
    expect(api.applyDirectorInstructions).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Unapplied draft");
  });

  it("renders Chinese state and action labels", async () => {
    await i18n.changeLanguage("zh-CN");
    await render();
    expect(container.textContent).toContain("工作区协调智能体");
    expect(container.textContent).toContain("本地兼容聊天");
    expect(button("保存草稿").disabled).toBe(true);
    expect(container.textContent).not.toContain("directorBehavior.");
  });
});
