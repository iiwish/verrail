// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { VerrailAgents } from "./VerrailAgents";

const get = vi.hoisted(() => vi.fn());
const createDefinition = vi.hoisted(() => vi.fn());
const updateDefinition = vi.hoisted(() => vi.fn());
const publishVersion = vi.hoisted(() => vi.fn());
const recordEvaluation = vi.hoisted(() => vi.fn());
const createDeployment = vi.hoisted(() => vi.fn());
const reviseDeployment = vi.hoisted(() => vi.fn());

vi.mock("@/api/agentLifecycle", () => ({
  agentLifecycleApi: { get, createDefinition, updateDefinition, publishVersion, recordEvaluation, createDeployment, reviseDeployment },
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "workspace-1" }) }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function readModel() {
  const version = (id: string, versionNumber: number) => ({
    id,
    workspaceId: "workspace-1",
    agentDefinitionId: "definition-1",
    versionNumber,
    runtime: "codex-local",
    model: "gpt-5",
    prompt: "Ship governed releases",
    skills: [],
    tools: [],
    outputSchema: {},
    capabilityCeiling: [],
    supplyChain: {},
    contentHash: `hash-${versionNumber}`,
    createdAt: "2026-08-26T09:00:00.000Z",
  });
  const revision = (id: string, revisionNumber: number) => ({
    id,
    workspaceId: "workspace-1",
    deploymentId: "deployment-1",
    revisionNumber,
    agentVersionId: `version-${revisionNumber}`,
    evaluationRunId: "evaluation-1",
    state: revisionNumber === 2 ? "active" : "superseded",
    runtimeConfig: {},
    contentHash: `hash-${revisionNumber}`,
    createdAt: "2026-08-26T09:30:00.000Z",
  });
  return {
    schemaVersion: 1,
    workspaceId: "workspace-1",
    generatedAt: "2026-08-26T10:00:00.000Z",
    defaultDeploymentId: "deployment-1",
    definitions: [{
      id: "definition-1",
      workspaceId: "workspace-1",
      compatibilityAgentId: null,
      name: "Release Engineer",
      description: "Ships governed releases",
      status: "published",
      versions: [version("version-1", 1), version("version-2", 2)],
      evaluations: [{
        id: "evaluation-1",
        workspaceId: "workspace-1",
        candidateAgentVersionId: "version-2",
        baselineAgentVersionId: "version-1",
        status: "passed",
        qualityScore: 92,
        costCents: 10,
        latencyMs: 1200,
        safetyStatus: "passed",
        summary: null,
        createdAt: "2026-08-26T09:20:00.000Z",
      }],
      deployments: [
        {
          id: "deployment-1",
          workspaceId: "workspace-1",
          agentDefinitionId: "definition-1",
          name: "Release Engineer production",
          status: "active",
          isDefault: true,
          activeRevision: revision("deployment-revision-2", 2),
          revisions: [revision("deployment-revision-1", 1), revision("deployment-revision-2", 2)],
          createdAt: "2026-08-26T09:30:00.000Z",
          updatedAt: "2026-08-26T09:40:00.000Z",
        },
        {
          id: "deployment-2",
          workspaceId: "workspace-1",
          agentDefinitionId: "definition-1",
          name: "Release Engineer staging",
          status: "paused",
          isDefault: false,
          activeRevision: null,
          revisions: [],
          createdAt: "2026-08-26T09:45:00.000Z",
          updatedAt: "2026-08-26T09:50:00.000Z",
        },
      ],
      createdAt: "2026-08-26T08:00:00.000Z",
      updatedAt: "2026-08-26T09:50:00.000Z",
    }],
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setSelectValue(element: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("VerrailAgents", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    get.mockResolvedValue(readModel());
    createDefinition.mockResolvedValue({ schemaVersion: 1, resourceType: "agent_definition", resourceId: "definition-1", replayed: false });
    updateDefinition.mockResolvedValue({ schemaVersion: 1, resourceType: "agent_definition", resourceId: "definition-1", replayed: false });
    publishVersion.mockResolvedValue({ schemaVersion: 1, resourceType: "agent_version", resourceId: "version-3", replayed: false });
    recordEvaluation.mockResolvedValue({ schemaVersion: 1, resourceType: "evaluation_run", resourceId: "evaluation-2", replayed: false });
    createDeployment.mockResolvedValue({ schemaVersion: 1, resourceType: "deployment", resourceId: "deployment-3", replayed: false });
    reviseDeployment.mockResolvedValue({ schemaVersion: 1, resourceType: "deployment_revision", resourceId: "deployment-revision-3", replayed: false });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderAgents() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <VerrailAgents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("renders the lifecycle surface with definition, publish, evaluate, deploy, pause, resume and rollback controls", async () => {
    await renderAgents();

    expect(get).toHaveBeenCalledWith("workspace-1");
    expect(container.textContent).toContain("Release Engineer");
    expect(container.textContent).toContain("v2");
    expect(container.textContent).toContain("Runtime");
    expect(container.textContent).toContain("Content hash");

    const buttons = Array.from(container.querySelectorAll("button"));
    const findButton = (label: string) => buttons.find((candidate) => candidate.textContent?.includes(label));
    expect(findButton("Edit")).toBeDefined();
    const publish = findButton("Publish version");
    const evaluate = findButton("Record evaluation");
    const deploy = findButton("Create deployment");
    expect(publish).toBeDefined();
    expect(evaluate).toBeDefined();
    expect(evaluate?.disabled).toBe(false);
    expect(deploy).toBeDefined();
    expect(deploy?.disabled).toBe(false);
    expect(findButton("Pause")).toBeDefined();
    expect(findButton("Resume")).toBeDefined();
    expect(findButton("Rollback")).toBeDefined();
  });

  it("records a failed evaluation through the dialog selects", async () => {
    await renderAgents();

    const evaluateButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Record evaluation"));
    await act(async () => evaluateButton?.click());
    await flushReact();

    const dialog = container.querySelector('[data-testid="dialog-content"]');
    expect(dialog).not.toBeNull();
    const statusSelect = dialog?.querySelector('select[name="status"]');
    const safetySelect = dialog?.querySelector('select[name="safetyStatus"]');
    expect(statusSelect).not.toBeNull();
    expect(safetySelect).not.toBeNull();

    await act(async () => {
      setSelectValue(statusSelect as HTMLSelectElement, "failed");
      setSelectValue(safetySelect as HTMLSelectElement, "passed");
    });

    const confirmButton = Array.from(dialog?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.getAttribute("type") === "submit");
    expect(confirmButton).toBeDefined();

    await act(async () => confirmButton?.click());
    await flushReact();

    expect(recordEvaluation).toHaveBeenCalledTimes(1);
    expect(recordEvaluation).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        candidateAgentVersionId: "version-2",
        status: "failed",
        safetyStatus: "passed",
      }),
      expect.any(String),
    );
  });

  it("reuses one idempotency key across re-submits and renders the mutation error banner", async () => {
    recordEvaluation.mockRejectedValue(new Error("Evaluation rejected"));

    await renderAgents();

    const evaluateButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Record evaluation"));
    await act(async () => evaluateButton?.click());
    await flushReact();

    const dialog = container.querySelector('[data-testid="dialog-content"]');
    const confirmButton = Array.from(dialog?.querySelectorAll("button") ?? [])
      .find((candidate) => candidate.getAttribute("type") === "submit");

    await act(async () => confirmButton?.click());
    await flushReact();

    await act(async () => confirmButton?.click());
    await flushReact();

    expect(recordEvaluation).toHaveBeenCalledTimes(2);
    const [firstKey, secondKey] = recordEvaluation.mock.calls.map((call) => call[2]);
    expect(firstKey).toEqual(expect.any(String));
    expect(secondKey).toBe(firstKey);

    expect(container.textContent).toContain("Agent lifecycle command failed");
    expect(container.textContent).toContain("Evaluation rejected");
  });
});
