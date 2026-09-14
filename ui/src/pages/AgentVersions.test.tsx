// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { AgentVersions } from "./AgentVersions";
const api = vi.hoisted(() => ({ get: vi.fn(), createDeployment: vi.fn(), reviseDeployment: vi.fn(), recordEvaluation: vi.fn() }));
vi.mock("@/api/agentLifecycle", () => ({ agentLifecycleApi: api }));
vi.mock("@/lib/router", () => ({ Link: ({ children }: any) => <span>{children}</span> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ open, children }: any) => open ? <div role="dialog">{children}</div> : null, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogFooter: ({ children }: any) => <footer>{children}</footer>, DialogHeader: ({ children }: any) => <header>{children}</header>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const agent = { id: "agent", companyId: "workspace", name: "Director", adapterConfig: {}, metadata: { paperclipBuiltInAgent: { key: "director", managed: true } } } as unknown as Agent;
function fixture() {
  return { definitions: [{ id: "definition", compatibilityAgentId: "agent", versions: [1, 2].map((n) => ({ id: `v${n}`, versionNumber: n, model: "model", createdAt: "2026-09-12T00:00:00Z", supplyChain: { source: "saved_agent_configuration.v2" } })), evaluations: [1, 2].map((n) => ({ id: `e${n}`, candidateAgentVersionId: `v${n}`, status: "passed", safetyStatus: "passed" })), deployments: [{ id: "deployment", isPrimary: true, name: "runtime", status: "active", activeRevision: { id: "r1", revisionNumber: 1, agentVersionId: "v1", runtimeConfig: {} } }] }] };
}
describe("single effective version UI", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient, data: ReturnType<typeof fixture>;
  beforeEach(async () => {
    vi.clearAllMocks(); await i18n.changeLanguage("en"); data = fixture(); api.get.mockImplementation(async () => structuredClone(data));
    api.reviseDeployment.mockResolvedValue({}); api.createDeployment.mockResolvedValue({});
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function flush() { for (let n = 0; n < 8; n++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); }
  async function render() { await act(async () => root.render(<QueryClientProvider client={client}><AgentVersions agent={agent} /></QueryClientProvider>)); await flush(); }
  function button(text: string) { const result = [...container.querySelectorAll("button")].find((b) => b.textContent === text); expect(result, text).toBeTruthy(); return result!; }
  async function click(text: string) { await act(async () => button(text).click()); await flush(); }
  it("updates the existing runtime and keeps the observed revision despite background refetch", async () => {
    await render(); await click("Update to v2");
    data.definitions[0].deployments[0].activeRevision.id = "r2-concurrent";
    await act(async () => { await client.invalidateQueries(); }); await flush();
    await click("Confirm");
    expect(api.reviseDeployment).toHaveBeenCalledWith("workspace", "deployment", { action: "activate", agentVersionId: "v2", evaluationRunId: "e2", expectedDeploymentRevisionId: "r1", expectedPrimaryDeploymentId: "deployment" }, expect.any(String));
    expect(api.createDeployment).not.toHaveBeenCalled();
  });
  it("shows the update action and reason when validation is missing", async () => {
    data.definitions[0].evaluations = []; await render(); await click("Update to v2");
    expect(container.textContent).toContain("must pass validation"); expect(button("Confirm").disabled).toBe(true);
    expect(api.reviseDeployment).not.toHaveBeenCalled();
  });
  it("creates only the first runtime, without a directory input for Director", async () => {
    data.definitions[0].deployments = []; await render(); await click("Activate version"); await click("Confirm");
    expect(api.createDeployment).toHaveBeenCalledWith("workspace", expect.objectContaining({ agentVersionId: "v2", runtimeConfig: {} }), expect.any(String));
    expect(container.querySelector('input[name="cwd"]')).toBeNull();
  });
  it("creates a fresh runtime without choosing among historical deployments", async () => {
    const first = data.definitions[0].deployments[0]; first.isPrimary = false;
    data.definitions[0].deployments.push({ ...first, id: "other", name: "Other runtime" });
    await render(); await click("Activate version"); expect(button("Confirm").disabled).toBe(false);
    expect(container.querySelector("select")).toBeNull();
    await click("Confirm");
    expect(api.reviseDeployment).not.toHaveBeenCalled();
    expect(api.createDeployment).toHaveBeenCalledWith("workspace", expect.objectContaining({ agentVersionId: "v2" }), expect.any(String));
  });
  it("rolls back via activation and leaves failures visible", async () => {
    data.definitions[0].deployments[0].activeRevision.agentVersionId = "v2";
    api.reviseDeployment.mockRejectedValue(new Error("Reload: revision conflict"));
    await render(); await click("Roll back to v1"); await click("Confirm");
    expect(api.reviseDeployment).toHaveBeenCalledWith("workspace", "deployment", expect.objectContaining({ action: "activate", agentVersionId: "v1", evaluationRunId: "e1" }), expect.any(String));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("revision conflict");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it("does not silently update a runtime created while first activation is open", async () => {
    data.definitions[0].deployments = []; await render(); await click("Activate version");
    data.definitions[0].deployments = fixture().definitions[0].deployments;
    await act(async () => { await client.invalidateQueries(); }); await flush();
    api.createDeployment.mockRejectedValue(new Error("Runtime already exists"));
    await click("Confirm");
    expect(api.createDeployment).toHaveBeenCalled();
    expect(api.reviseDeployment).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("already exists");
  });
});
