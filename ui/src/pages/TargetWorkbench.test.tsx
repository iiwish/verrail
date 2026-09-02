// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TargetWorkbench } from "./TargetWorkbench";

const get = vi.hoisted(() => vi.fn());
const getRevision = vi.hoisted(() => vi.fn());
const getWorkspace = vi.hoisted(() => vi.fn());
const createConversation = vi.hoisted(() => vi.fn());
const createRunAttempt = vi.hoisted(() => vi.fn());
const requestRunCancellation = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const setBreadcrumbs = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ targetId: "target-1", tab: "overview", targetRevisionId: undefined as string | undefined }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => navigate,
  useParams: () => route,
}));
vi.mock("../api/targets", () => ({
  targetsApi: { get, getRevision, getWorkspace, createConversation, createRunAttempt, requestRunCancellation },
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "workspace-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: string }> }) => (
    <div>{items.map((item) => <span key={item.value}>{item.label}</span>)}</div>
  ),
}));
vi.mock("@/components/ui/tabs", () => ({ Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function targetModel() {
  return {
    schemaVersion: 1,
    readModelPolicyVersion: "native.v1",
    targetId: "target-1",
    activeTargetRevisionId: "revision-1",
    workspaceId: "workspace-1",
    collection: { id: "collection-1", name: "Release work" },
    title: "Release Verrail",
    summary: "A reviewable delivery",
    status: "awaiting_acceptance",
    outcomeOwner: { principalType: "user", principalId: "owner-1", displayName: "Owner" },
    currentStage: { key: "accept", label: "Accept" },
    risk: { level: "high" },
    attentionSummary: { total: 1, highestSeverity: "high" },
    artifactSummary: { count: 0, latestRevisionId: null },
    evidenceSummary: { count: 0, passed: 0, failed: 0, inconclusive: 0, coverage: "unknown" },
    runSummary: { active: 0, failed: 0, latestRunId: null, latestRunAt: null },
    definition: { goal: "Release a governed version.", constraints: [], acceptanceCriteria: [{ id: "criterion-1", title: "Reviewed", description: null }], deadline: null, policySummary: null, resourceRefs: [] },
    createdAt: "2026-08-26T09:00:00.000Z",
    updatedAt: "2026-08-26T10:00:00.000Z",
    projectedAt: "2026-08-26T10:00:01.000Z",
  };
}

function targetWorkspace() {
  return {
    schemaVersion: 1,
    targetId: "target-1",
    targetRevisionId: "revision-1",
    workspaceId: "workspace-1",
    generatedAt: "2026-08-26T10:00:02.000Z",
    graph: { workGraphId: "graph-1", activeGraphRevisionId: "graph-revision-1", status: "active", revisionNumber: 1 },
    stages: [
      { key: "define", label: "Define", state: "completed" },
      { key: "execute", label: "Execute", state: "current" },
      { key: "verify", label: "Verify", state: "pending" },
      { key: "accept", label: "Accept", state: "pending" },
    ],
    work: [{
      id: "node-1",
      nodeKey: "release",
      graphRevisionId: "graph-revision-1",
      kind: "agent_task",
      stage: "execute",
      title: "Release Verrail",
      status: "running",
      responsiblePrincipal: { principalType: "agent", principalId: "agent-1" },
      dependencyNodeKeys: [],
      completionDefinition: "Publish a reviewable release.",
      updatedAt: "2026-08-26T10:00:00.000Z",
    }],
    attention: [],
    submissions: [],
    artifacts: [],
    evidence: [],
    runs: [],
    timeline: [{
      id: "target:target-1:created",
      type: "target_created",
      title: "Target created",
      detail: "Release Verrail",
      occurredAt: "2026-08-26T09:00:00.000Z",
    }],
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function runFixtures() {
  return [
    {
      id: "run-1",
      kind: "agent_run",
      targetRevisionId: "revision-1",
      graphRevisionId: "graph-revision-1",
      workNodeId: "node-1",
      status: "failed",
      actor: { principalType: "agent", principalId: "agent-1" },
      deploymentRevisionId: "deployment-revision-1",
      agentVersionId: "agent-version-1",
      attempt: 1,
      cancelRequestedAt: null,
      attempts: [{
        id: "attempt-1",
        runId: "run-1",
        attemptNumber: 1,
        deploymentRevisionId: "deployment-revision-1",
        agentVersionId: "agent-version-1",
        runtimeProfile: "host_trusted",
        executor: { principalType: "service", principalId: "host-trusted-local" },
        fencingToken: 7,
        status: "failed",
        lastEventCursor: 42,
        errorCode: "ADAPTER_FAILED",
        errorMessage: "adapter crashed",
        result: null,
        lease: {
          id: "lease-1",
          runAttemptId: "attempt-1",
          executorPrincipalId: "host-trusted-local",
          runtimeProfile: "host_trusted",
          fencingToken: 7,
          status: "active",
          expiresAt: "2026-08-26T11:00:00.000Z",
          graceExpiresAt: "2026-08-26T11:05:00.000Z",
          claimedAt: "2026-08-26T10:01:00.000Z",
          lastHeartbeatAt: null,
          releasedAt: null,
        },
        events: [],
        startedAt: "2026-08-26T10:01:00.000Z",
        finishedAt: "2026-08-26T10:02:00.000Z",
        createdAt: "2026-08-26T10:00:30.000Z",
        updatedAt: "2026-08-26T10:02:00.000Z",
      }],
      startedAt: "2026-08-26T10:01:00.000Z",
      finishedAt: "2026-08-26T10:02:00.000Z",
      createdAt: "2026-08-26T10:00:30.000Z",
    },
    {
      id: "run-2",
      kind: "agent_run",
      targetRevisionId: "revision-1",
      graphRevisionId: "graph-revision-1",
      workNodeId: "node-1",
      status: "running",
      actor: { principalType: "agent", principalId: "agent-2" },
      deploymentRevisionId: "deployment-revision-1",
      agentVersionId: "agent-version-1",
      attempt: 1,
      cancelRequestedAt: null,
      attempts: [{
        id: "attempt-2",
        runId: "run-2",
        attemptNumber: 1,
        deploymentRevisionId: "deployment-revision-1",
        agentVersionId: "agent-version-1",
        runtimeProfile: "host_trusted",
        executor: { principalType: "service", principalId: "host-trusted-local" },
        fencingToken: 8,
        status: "running",
        lastEventCursor: 5,
        errorCode: null,
        errorMessage: null,
        result: null,
        lease: null,
        events: [],
        startedAt: "2026-08-26T10:03:00.000Z",
        finishedAt: null,
        createdAt: "2026-08-26T10:02:30.000Z",
        updatedAt: "2026-08-26T10:03:00.000Z",
      }],
      startedAt: "2026-08-26T10:03:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-26T10:02:30.000Z",
    },
  ];
}

describe("TargetWorkbench", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    route.targetId = "target-1";
    route.tab = "overview";
    route.targetRevisionId = undefined;
    get.mockResolvedValue(targetModel());
    getRevision.mockResolvedValue(targetModel());
    getWorkspace.mockResolvedValue(targetWorkspace());
    createConversation.mockResolvedValue({ id: "conversation-1" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderWorkbench() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TargetWorkbench />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("shows the native responsibility and immutable definition snapshot", async () => {
    await renderWorkbench();
    expect(container.textContent).toContain("Release Verrail");
    expect(container.textContent).toContain("Owner");
    expect(container.textContent).toContain("Release a governed version");
    expect(container.textContent).toContain("Work Graph");
    expect(container.textContent).toContain("Acceptance");
    expect(container.querySelector('a[href="/VER/issues/VER-1"]')).toBeNull();
    expect(container.textContent).not.toContain("Accepted");
    expect(setBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Targets", href: "/targets" },
      { label: "Release Verrail" },
    ]);
  });

  it("loads immutable revisions through the revision endpoint", async () => {
    route.targetRevisionId = "revision-1";
    await renderWorkbench();
    expect(getRevision).toHaveBeenCalledWith("workspace-1", "target-1", "revision-1");
    expect(container.textContent).toContain("Immutable revision");
    expect(container.querySelector('a[href="/targets/target-1/overview"]')).not.toBeNull();
  });

  it("keeps a historical native revision inspectable without a compatibility source", async () => {
    route.targetRevisionId = "revision-1";
    getRevision.mockResolvedValue(targetModel());

    await renderWorkbench();

    expect(container.textContent).toContain("Immutable revision");
    expect(container.querySelector('a[href="/VER/issues/VER-1"]')).toBeNull();
  });

  it("distinguishes a retryable read-model outage from a missing Target", async () => {
    const { ApiError } = await import("../api/client");
    get.mockRejectedValue(new ApiError("Target projection unavailable", 503, {
      code: "TARGET_PROJECTION_UNAVAILABLE",
    }));

    await renderWorkbench();

    expect(container.textContent).toContain("temporarily unavailable");
    expect(container.textContent).not.toContain("outside your access boundary");
  });

  it("renders Work from the versioned Target workspace response", async () => {
    route.tab = "work";
    await renderWorkbench();

    expect(getWorkspace).toHaveBeenCalledWith("workspace-1", "target-1");
    expect(container.textContent).toContain("release · Release Verrail");
    expect(container.textContent).toContain("agent_task · execute");
    expect(container.querySelector('a[href="/VER/issues/VER-1"]')).toBeNull();
  });

  it("opens a server-validated Target-bound conversation", async () => {
    await renderWorkbench();
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Discuss"));
    expect(button).toBeDefined();

    await act(async () => button?.click());
    await flushReact();

    expect(createConversation).toHaveBeenCalledWith("workspace-1", "target-1");
    expect(navigate).toHaveBeenCalledWith("/chat/conversation-1");
  });

  it("runs tab shows attempt fencing, cursor, lease evidence and drives retry and cancel", async () => {
    route.tab = "runs";
    getWorkspace.mockResolvedValue({ ...targetWorkspace(), runs: runFixtures() });
    createRunAttempt.mockResolvedValue({ schemaVersion: 1, runId: "run-1", replayed: false });
    requestRunCancellation.mockResolvedValue({ schemaVersion: 1, runId: "run-2", status: "cancel_requested", replayed: false });

    await renderWorkbench();

    expect(getWorkspace).toHaveBeenCalledWith("workspace-1", "target-1");
    expect(container.textContent).toContain("agent-1");
    expect(container.textContent).toContain("Fence 7");
    expect(container.textContent).toContain("Cursor 42");
    expect(container.textContent).toContain("Lease active");
    expect(container.textContent).toContain("adapter crashed");
    expect(container.textContent).toContain("No lease");

    const retryButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Retry"));
    expect(retryButton).toBeDefined();

    await act(async () => retryButton?.click());
    await flushReact();

    expect(createRunAttempt).toHaveBeenCalledTimes(1);
    expect(createRunAttempt).toHaveBeenCalledWith(
      "workspace-1",
      "run-1",
      expect.objectContaining({
        executor: expect.objectContaining({ principalType: "service", principalId: "host-trusted-local" }),
      }),
      expect.any(String),
    );

    const cancelButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Cancel"));
    expect(cancelButton).toBeDefined();

    await act(async () => cancelButton?.click());
    await flushReact();

    expect(requestRunCancellation).toHaveBeenCalledWith("workspace-1", "run-2", expect.any(String));
  });

  it("disables only the pending run's retry and surfaces the server failure code", async () => {
    route.tab = "runs";
    const runs = [
      ...runFixtures(),
      { ...runFixtures()[0], id: "run-3", actor: { principalType: "agent", principalId: "agent-3" }, attempts: [runFixtures()[0].attempts[0]].map((attempt) => ({ ...attempt, id: "attempt-3", runId: "run-3" })) },
    ];
    getWorkspace.mockResolvedValue({ ...targetWorkspace(), runs });
    const { ApiError } = await import("../api/client");
    createRunAttempt.mockImplementation(() => new Promise(() => {}));

    await renderWorkbench();

    const retryButtons = Array.from(container.querySelectorAll("button"))
      .filter((candidate) => candidate.textContent?.includes("Retry"));
    expect(retryButtons).toHaveLength(2);

    await act(async () => retryButtons[0]?.click());

    expect(retryButtons[0]?.disabled).toBe(true);
    expect(retryButtons[1]?.disabled).toBe(false);

    createRunAttempt.mockRejectedValueOnce(new ApiError("Command rejected", 409, { code: "RUN_FENCE_STALE" }));
    createRunAttempt.mockImplementation(() => new Promise(() => {}));

    const retryRun3 = Array.from(container.querySelectorAll("button"))
      .filter((candidate) => candidate.textContent?.includes("Retry"))
      .find((candidate) => !candidate.disabled);
    expect(retryRun3).toBeDefined();

    await act(async () => retryRun3?.click());
    await flushReact();

    expect(container.textContent).toContain("RUN_FENCE_STALE");
    expect(container.textContent).toContain("Review the run state");
  });
});
