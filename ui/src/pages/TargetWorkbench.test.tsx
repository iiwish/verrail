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
const runOutboxFailures = vi.hoisted(() => vi.fn());
const retryRunOutbox = vi.hoisted(() => vi.fn());
const createGraphRevision = vi.hoisted(() => vi.fn());
const activateGraphRevision = vi.hoisted(() => vi.fn());
const createRun = vi.hoisted(() => vi.fn());
const recordDeliveryReview = vi.hoisted(() => vi.fn());
const acceptSubmission = vi.hoisted(() => vi.fn());
const approveAction = vi.hoisted(() => vi.fn());
const executeAction = vi.hoisted(() => vi.fn());
const getAgentLifecycle = vi.hoisted(() => vi.fn());
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
  targetsApi: {
    get,
    getRevision,
    getWorkspace,
    createConversation,
    createRunAttempt,
    requestRunCancellation,
    runOutboxFailures,
    retryRunOutbox,
    createGraphRevision,
    activateGraphRevision,
    createRun,
    recordDeliveryReview,
    acceptSubmission,
    approveAction,
    executeAction,
  },
}));
vi.mock("../api/agentLifecycle", () => ({
  agentLifecycleApi: { get: getAgentLifecycle },
}));
vi.mock("../api/companies-query", () => ({
  useAccountIdentity: () => ({ userId: "owner-1", settled: true }),
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
    outcome: {
      state: "open",
      latestSubmissionId: null,
      latestReviewId: null,
      validAcceptanceId: null,
      effectReceiptIds: [],
      controls: [],
    },
    availableCommands: [
      { id: "create_graph_revision", state: "available", reason: null, resourceId: "graph-1" },
      { id: "activate_graph_revision", state: "completed", reason: null, resourceId: "graph-revision-1" },
      { id: "create_run", state: "blocked", reason: "No ready agent task is available.", resourceId: null },
      { id: "create_submission", state: "blocked", reason: "Complete work first.", resourceId: null },
      { id: "record_review", state: "blocked", reason: "A current complete Submission is required.", resourceId: null },
      { id: "accept_submission", state: "blocked", reason: "A current approved Review is required.", resourceId: null },
      { id: "request_pull_request", state: "blocked", reason: "A current Submission is required.", resourceId: null },
      { id: "approve_action", state: "blocked", reason: "An ActionRequest is required.", resourceId: null },
      { id: "execute_action", state: "blocked", reason: "An approved ActionRequest is required.", resourceId: null },
      { id: "reconcile_action", state: "blocked", reason: "Only an unknown effect can be reconciled.", resourceId: null },
    ],
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
    reviews: [],
    acceptances: [],
    artifacts: [],
    evidence: [],
    claims: [],
    verificationResults: [],
    integrationRuns: [],
    humanWorkResults: [],
    actionRequests: [],
    effectReceipts: [],
    workspaceBinding: null,
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

const CONTENT_HASH_A = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const CONTENT_HASH_B = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
const OBJECT_HASH = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

function assuranceFacts() {
  return {
    artifacts: [
      {
        id: "artifact-1",
        targetId: "target-1",
        kind: "code_change",
        title: "Traceability ledger",
        createdBy: { principalType: "agent", principalId: "agent-1" },
        createdAt: "2026-08-26T10:05:00.000Z",
        updatedAt: "2026-08-26T10:20:00.000Z",
        revisions: [
          {
            id: "revision-a1",
            artifactId: "artifact-1",
            revisionNumber: 1,
            contentHash: CONTENT_HASH_A,
            contentRef: `verrail://objects/${CONTENT_HASH_A}`,
            sourceRunId: "run-1",
            sourceWorkNodeId: null,
            baseRevisionId: null,
            createdBy: { principalType: "agent", principalId: "agent-1" },
            createdAt: "2026-08-26T10:06:00.000Z",
          },
          {
            id: "revision-a2",
            artifactId: "artifact-1",
            revisionNumber: 2,
            contentHash: CONTENT_HASH_B,
            contentRef: `verrail://objects/${CONTENT_HASH_B}`,
            sourceRunId: null,
            sourceWorkNodeId: null,
            baseRevisionId: "revision-a1",
            createdBy: { principalType: "agent", principalId: "agent-1" },
            createdAt: "2026-08-26T10:20:00.000Z",
          },
        ],
      },
    ],
    claims: [
      {
        id: "claim-1",
        targetId: "target-1",
        targetRevisionId: "revision-1",
        criterionKey: "criterion-1",
        title: "Release builds cleanly",
        status: "supported",
        createdBy: { principalType: "user", principalId: "owner-1" },
        createdAt: "2026-08-26T10:07:00.000Z",
        updatedAt: "2026-08-26T10:15:00.000Z",
      },
      {
        id: "claim-2",
        targetId: "target-1",
        targetRevisionId: "revision-1",
        criterionKey: "reviewed",
        title: "Security review recorded",
        status: "open",
        createdBy: { principalType: "user", principalId: "owner-1" },
        createdAt: "2026-08-26T10:08:00.000Z",
        updatedAt: "2026-08-26T10:08:00.000Z",
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        targetId: "target-1",
        claimId: "claim-1",
        kind: "ci_result",
        producer: { principalType: "service", principalId: "ci-runner" },
        objectHash: OBJECT_HASH,
        reference: "verrail://ci/runs/run-1/report",
        trustLevel: "high",
        recordedAt: "2026-08-26T10:10:00.000Z",
        createdBy: { principalType: "service", principalId: "ci-runner" },
        createdAt: "2026-08-26T10:10:00.000Z",
      },
      {
        id: "evidence-2",
        targetId: "target-1",
        claimId: null,
        kind: "human_review",
        producer: { principalType: "user", principalId: "owner-1" },
        objectHash: OBJECT_HASH,
        reference: "verrail://reviews/r-9",
        trustLevel: "medium",
        recordedAt: "2026-08-26T10:12:00.000Z",
        createdBy: { principalType: "user", principalId: "owner-1" },
        createdAt: "2026-08-26T10:12:00.000Z",
      },
    ],
    verificationResults: [
      {
        id: "verification-1",
        targetId: "target-1",
        claimId: "claim-1",
        verdict: "passed",
        verifierVersion: "verifier.v1",
        evidenceIds: ["evidence-1"],
        waiverReference: null,
        resultHash: OBJECT_HASH,
        createdBy: { principalType: "user", principalId: "owner-1" },
        createdAt: "2026-08-26T10:15:00.000Z",
      },
    ],
  };
}

const SUBMISSION_HASH_A = "b1946ac92492d2347c6235b4d2611184e0f2a5ab2b0f8a9c1d2e3f4a5b6c7d80";
const SUBMISSION_HASH_B = "ff2527f949b3f0c5b2a3d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f0";
const REVIEW_HASH_A = "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae";
const REVIEW_HASH_B = "9d3e09cbae7b9c1a2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c";
const ACCEPTANCE_HASH_A = "5d41402abc4b2a76b9719d911017c592a1b2c3d4e5f60718293a4b5c6d7e8f90";
const ACCEPTANCE_HASH_B = "7d865e959b2466918c9863afca942d0fb8912c9a4fca7f1d7c6b9a5e4d3c2b10";
const SUBMISSION_ID_A = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SUBMISSION_ID_B = "0f5d4c3b-2a19-4e87-b6f5-c8d9e0a1b2c3";
const REVIEW_ID_A = "d3b07384-d113-4b1f-8a2c-5e9f0a1b2c3d";
const REVIEW_ID_B = "c4ca4238-a0b9-4e33-a5c6-7d8e9f0a1b2c";
const ACCEPTANCE_ID_A = "9a8b7c6d-5e4f-4031-8271-9a0b1c2d3e4f";
const ACCEPTANCE_ID_B = "3e1c5a7b-9d2f-4a68-b0c4-8e7f6a5b4c3d";

// Newest-first on (created_at desc, id desc): submission A supersedes the
// older submission B, so B's acceptance derives invalid/superseded server-side.
function adjudicationFacts() {
  return {
    submissions: [
      {
        id: SUBMISSION_ID_A,
        targetId: "target-1",
        targetRevisionId: "revision-1",
        artifactRevisionIds: ["revision-a1"],
        verificationResultIds: ["verification-1"],
        commitRef: "e07fc1f90ae7",
        environmentSummary: "staging · all checks green",
        notes: "Candidate binding for the release review.",
        submissionHash: SUBMISSION_HASH_A,
        submittedBy: { principalType: "agent", principalId: "agent-1" },
        createdAt: "2026-08-26T11:00:00.000Z",
      },
      {
        id: SUBMISSION_ID_B,
        targetId: "target-1",
        targetRevisionId: "revision-1",
        artifactRevisionIds: ["revision-a2"],
        verificationResultIds: [],
        commitRef: null,
        environmentSummary: null,
        notes: null,
        submissionHash: SUBMISSION_HASH_B,
        submittedBy: { principalType: "agent", principalId: "agent-2" },
        createdAt: "2026-08-26T10:30:00.000Z",
      },
    ],
    reviews: [
      {
        id: REVIEW_ID_A,
        targetId: "target-1",
        submissionId: SUBMISSION_ID_A,
        verdict: "approved",
        risks: "Rollback plan documented.",
        unprovenItems: ["Load test at peak traffic"],
        comments: "Evidence chain is complete.",
        reviewHash: REVIEW_HASH_A,
        reviewer: { principalType: "user", principalId: "reviewer-1" },
        createdAt: "2026-08-26T11:10:00.000Z",
      },
      {
        id: REVIEW_ID_B,
        targetId: "target-1",
        submissionId: SUBMISSION_ID_B,
        verdict: "approved",
        risks: null,
        unprovenItems: [],
        comments: null,
        reviewHash: REVIEW_HASH_B,
        reviewer: { principalType: "user", principalId: "reviewer-2" },
        createdAt: "2026-08-26T10:40:00.000Z",
      },
    ],
    acceptances: [
      {
        id: ACCEPTANCE_ID_A,
        targetId: "target-1",
        targetRevisionId: "revision-1",
        submissionId: SUBMISSION_ID_A,
        reviewId: REVIEW_ID_A,
        authority: "outcome_owner",
        acceptedBy: { principalType: "user", principalId: "owner-1" },
        acceptanceHash: ACCEPTANCE_HASH_A,
        createdAt: "2026-08-26T11:20:00.000Z",
        validity: "valid",
        invalidReason: null,
      },
      {
        id: ACCEPTANCE_ID_B,
        targetId: "target-1",
        targetRevisionId: "revision-1",
        submissionId: SUBMISSION_ID_B,
        reviewId: REVIEW_ID_B,
        authority: "outcome_owner",
        acceptedBy: { principalType: "user", principalId: "owner-1" },
        acceptanceHash: ACCEPTANCE_HASH_B,
        createdAt: "2026-08-26T10:50:00.000Z",
        validity: "invalid",
        invalidReason: "superseded_submission",
      },
    ],
  };
}

const ACTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTION_PARAMS_HASH = "8f14e45fceea167a5a36dedd4bea2543d4a0d5d7a8df6a8ca3e9d42e3a1f8201";

function actionFact() {
  return {
    id: ACTION_ID,
    targetId: "target-1",
    submissionId: SUBMISSION_ID_A,
    actionType: "create_pull_request",
    params: { title: "Ship governed release", head: "codex/release", base: "main" },
    paramsHash: ACTION_PARAMS_HASH,
    expectedCommitRef: "e07fc1f90ae7",
    status: "approved",
    providerMarker: null,
    executionAttemptCount: 0,
    executionStartedAt: null,
    lastReconciledAt: null,
    requestedBy: { principalType: "agent", principalId: "agent-1" },
    createdAt: "2026-08-26T11:25:00.000Z",
    updatedAt: "2026-08-26T11:30:00.000Z",
    approvals: {
      count: 1,
      latest: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        approvedBy: { principalType: "user", principalId: "owner-1" },
        paramsHash: ACTION_PARAMS_HASH,
        createdAt: "2026-08-26T11:30:00.000Z",
      },
    },
    executedReceipt: null,
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
    runOutboxFailures.mockResolvedValue([]);
    route.targetId = "target-1";
    route.tab = "overview";
    route.targetRevisionId = undefined;
    get.mockResolvedValue(targetModel());
    getRevision.mockResolvedValue(targetModel());
    getWorkspace.mockResolvedValue(targetWorkspace());
    getAgentLifecycle.mockResolvedValue({
      schemaVersion: 1,
      workspaceId: "workspace-1",
      generatedAt: "2026-09-04T00:00:00.000Z",
      defaultDeploymentId: "deployment-1",
      definitions: [{
        id: "definition-1",
        workspaceId: "workspace-1",
        compatibilityAgentId: "agent-42",
        name: "Delivery Agent",
        description: null,
        status: "published",
        versions: [],
        evaluations: [],
        deployments: [{
          id: "deployment-1",
          workspaceId: "workspace-1",
          agentDefinitionId: "definition-1",
          name: "Production",
          status: "active",
          isDefault: true,
          activeRevision: {
            id: "deployment-revision-1",
            workspaceId: "workspace-1",
            deploymentId: "deployment-1",
            revisionNumber: 1,
            agentVersionId: "agent-version-1",
            evaluationRunId: "evaluation-1",
            state: "active",
            runtimeConfig: {},
            contentHash: "a".repeat(64),
            createdAt: "2026-09-04T00:00:00.000Z",
          },
          revisions: [],
          createdAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T00:00:00.000Z",
        }],
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      }],
    });
    createConversation.mockResolvedValue({ id: "conversation-1" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
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

  it("keeps candidate-only commands visible without offering board impersonation", async () => {
    getWorkspace.mockResolvedValue({
      ...targetWorkspace(),
      availableCommands: targetWorkspace().availableCommands.map((command) =>
        command.id === "create_submission" || command.id === "request_pull_request"
          ? { ...command, state: "available", reason: null, resourceId: SUBMISSION_ID_A }
          : command),
    });

    await renderWorkbench();

    expect(container.textContent).toContain("An authorized Agent or Service must issue this candidate command");
    expect(Array.from(container.querySelectorAll("button")).some(
      (button) => button.textContent?.includes("Create submission") || button.textContent?.includes("Request pull request"),
    )).toBe(false);
  });

  it("creates and activates a graph revision, then starts its bound Agent Run", async () => {
    getWorkspace.mockResolvedValue({
      ...targetWorkspace(),
      work: [{ ...targetWorkspace().work[0], status: "ready" }],
      availableCommands: targetWorkspace().availableCommands.map((command) => {
        if (command.id === "activate_graph_revision") return { ...command, state: "available", resourceId: "graph-revision-2" };
        if (command.id === "create_run") return { ...command, state: "available", reason: null, resourceId: "node-1" };
        return command;
      }),
    });
    createGraphRevision.mockResolvedValue({ schemaVersion: 1, targetId: "target-1", targetRevisionId: "revision-1", workGraphId: "graph-1", graphRevisionId: "graph-revision-2", revisionNumber: 2, replayed: false });
    activateGraphRevision.mockResolvedValue({ schemaVersion: 1, targetId: "target-1", targetRevisionId: "revision-1", workGraphId: "graph-1", graphRevisionId: "graph-revision-2", revisionNumber: 2, activatedAt: new Date().toISOString(), replayed: false });
    createRun.mockResolvedValue({ schemaVersion: 1, runId: "run-3", targetId: "target-1", targetRevisionId: "revision-1", graphRevisionId: "graph-revision-1", workNodeId: "node-1", deploymentRevisionId: null, agentVersionId: null, status: "queued", replayed: false });

    await renderWorkbench();

    const deploymentSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Delivery deployment revision"]');
    expect(deploymentSelect?.value).toBe("deployment-revision-1");
    const createButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Create revision"));
    await act(async () => createButton?.click());
    await flushReact();

    expect(createGraphRevision).toHaveBeenCalledWith("workspace-1", "target-1", expect.objectContaining({
      expectedTargetRevisionId: "revision-1",
      nodes: expect.arrayContaining([
        expect.objectContaining({ nodeKey: "deliver", responsiblePrincipal: { principalType: "agent", principalId: "deployment-revision-1" } }),
        expect.objectContaining({ nodeKey: "verify", dependencyNodeKeys: ["deliver"] }),
        expect.objectContaining({ nodeKey: "review", dependencyNodeKeys: ["verify"] }),
        expect.objectContaining({ nodeKey: "accept", dependencyNodeKeys: ["review"] }),
      ]),
    }), expect.any(String));

    const activateButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === "Activate");
    await act(async () => activateButton?.click());
    await flushReact();
    expect(activateGraphRevision).toHaveBeenCalledWith("workspace-1", "target-1", "graph-revision-2", expect.any(String));

    const startButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Start run"));
    await act(async () => startButton?.click());
    await flushReact();
    expect(createRun).toHaveBeenCalledWith(
      "workspace-1",
      "target-1",
      "graph-revision-1",
      "node-1",
      { kind: "agent_run", actor: { principalType: "agent", principalId: "agent-1" } },
      expect.any(String),
    );
  });

  it("issues review, acceptance, approval, and execution as separate bound human commands", async () => {
    const adjudication = adjudicationFacts();
    const action = actionFact();
    getWorkspace.mockResolvedValue({
      ...targetWorkspace(),
      ...adjudication,
      actionRequests: [action],
      availableCommands: targetWorkspace().availableCommands.map((command) => {
        if (command.id === "record_review") return { ...command, state: "available", reason: null, resourceId: SUBMISSION_ID_A };
        if (command.id === "accept_submission") return { ...command, state: "available", reason: null, resourceId: REVIEW_ID_A };
        if (command.id === "approve_action" || command.id === "execute_action") return { ...command, state: "available", reason: null, resourceId: ACTION_ID };
        return command;
      }),
    });
    recordDeliveryReview.mockResolvedValue({ schemaVersion: 1, resourceType: "delivery_review", resourceId: REVIEW_ID_A, replayed: false });
    acceptSubmission.mockResolvedValue({ schemaVersion: 1, resourceType: "acceptance", resourceId: ACCEPTANCE_ID_A, replayed: false });
    approveAction.mockResolvedValue({ schemaVersion: 1, resourceType: "action_approval", resourceId: action.approvals.latest.id, replayed: false });
    executeAction.mockResolvedValue({ schemaVersion: 1, resourceType: "effect_receipt", resourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", replayed: false });

    await renderWorkbench();

    expect(container.querySelector(`[title="${SUBMISSION_HASH_A}"]`)).not.toBeNull();
    expect(container.querySelector(`[title="${REVIEW_HASH_A}"]`)).not.toBeNull();
    expect(container.querySelector(`[title="${ACTION_PARAMS_HASH}"]`)).not.toBeNull();

    const clickCommand = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.includes(label));
      expect(button, label).toBeDefined();
      await act(async () => button?.click());
      await flushReact();
    };

    await clickCommand("Record review");
    expect(recordDeliveryReview).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      submissionId: SUBMISSION_ID_A,
      reviewerPrincipalId: "owner-1",
      verdict: "approved",
    }), expect.any(String));

    await clickCommand("Accept");
    expect(acceptSubmission).toHaveBeenCalledWith("workspace-1", {
      submissionId: SUBMISSION_ID_A,
      reviewId: REVIEW_ID_A,
    }, expect.any(String));

    await clickCommand("Approve");
    expect(approveAction).toHaveBeenCalledWith("workspace-1", ACTION_ID, expect.objectContaining({
      approverPrincipalId: "owner-1",
      paramsHash: ACTION_PARAMS_HASH,
    }), expect.any(String));

    await clickCommand("Create pull request");
    expect(executeAction).toHaveBeenCalledWith("workspace-1", ACTION_ID, { actionRequestId: ACTION_ID }, expect.any(String));
  });

  it("shows a rejected command code and retries the identical command intent", async () => {
    const { ApiError } = await import("../api/client");
    getWorkspace.mockResolvedValue({
      ...targetWorkspace(),
      ...adjudicationFacts(),
      availableCommands: targetWorkspace().availableCommands.map((command) =>
        command.id === "record_review"
          ? { ...command, state: "available", reason: null, resourceId: SUBMISSION_ID_A }
          : command),
    });
    recordDeliveryReview
      .mockRejectedValueOnce(new ApiError("Stale submission", 409, { code: "ADJUDICATION_SUBMISSION_STALE" }))
      .mockResolvedValueOnce({ schemaVersion: 1, resourceType: "delivery_review", resourceId: REVIEW_ID_A, replayed: false });

    await renderWorkbench();
    const recordButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Record review"));
    await act(async () => recordButton?.click());
    await flushReact();

    expect(container.textContent).toContain("ADJUDICATION_SUBMISSION_STALE");
    const retryButton = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === "Retry");
    await act(async () => retryButton?.click());
    await flushReact();

    expect(recordDeliveryReview).toHaveBeenCalledTimes(2);
    expect(recordDeliveryReview.mock.calls[1]?.[2]).toBe(recordDeliveryReview.mock.calls[0]?.[2]);
    expect(container.textContent).toContain("authoritative facts were refreshed");
  });

  it("retries the exact failed event without creating an Attempt and reuses the command key after uncertainty", async () => {
    route.tab = "runs";
    getWorkspace.mockResolvedValue({ ...targetWorkspace(), runs: runFixtures() });
    runOutboxFailures.mockResolvedValue([{ eventId: "event-1", runId: "run-1", eventType: "verrail.run.cancellation_requested.v1", attemptCount: 3, lastError: "unsupported Run event type", createdAt: "2026-09-05T00:00:00Z" }]);
    retryRunOutbox.mockRejectedValue(new Error("connection lost"));
    await renderWorkbench();
    expect(runOutboxFailures).toHaveBeenCalledWith("workspace-1", "target-1");
    expect(container.textContent).toContain("unsupported Run event type");
    const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "Retry event delivery");
    expect(button).toBeDefined();
    await act(async () => button?.click());
    await flushReact();
    await act(async () => button?.click());
    await flushReact();
    expect(retryRunOutbox).toHaveBeenCalledTimes(2);
    expect(retryRunOutbox.mock.calls[0]).toEqual(["workspace-1", "run-1", { eventId: "event-1", expectedAttemptCount: 3 }, expect.any(String)]);
    expect(retryRunOutbox.mock.calls[1]).toEqual(retryRunOutbox.mock.calls[0]);
    expect(createRunAttempt).not.toHaveBeenCalled();
    expect(requestRunCancellation).not.toHaveBeenCalled();
  });

  it("refreshes asynchronous recovery facts on the Runs tab without allocating another Attempt", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    route.tab = "runs";
    getWorkspace.mockResolvedValue({ ...targetWorkspace(), runs: [{ ...runFixtures()[0], status: "queued" }] });
    await renderWorkbench();
    expect(container.textContent).toContain("Queued");
    const initialReads = getWorkspace.mock.calls.length;

    getWorkspace.mockResolvedValue({ ...targetWorkspace(), runs: [runFixtures()[0]] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await flushReact();

    expect(getWorkspace.mock.calls.length).toBeGreaterThan(initialReads);
    expect(container.textContent).not.toContain("Queued");
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Retry")).toBe(true);
    expect(createRunAttempt).not.toHaveBeenCalled();
  });

  it("does not poll the full workspace outside the Runs tab", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await renderWorkbench();
    const initialReads = getWorkspace.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getWorkspace).toHaveBeenCalledTimes(initialReads);
  });

  it("shows outbox read failure rather than treating it as an empty recovery list", async () => {
    route.tab = "runs";
    runOutboxFailures.mockRejectedValue(new Error("unavailable"));
    await renderWorkbench();
    expect(container.textContent).toContain("Failed to load Run event delivery failures.");
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
        executor: expect.objectContaining({ principalType: "service", principalId: "verrail-host-runner" }),
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

  it("renders server assurance facts on the artifacts tab", async () => {
    route.tab = "artifacts";
    getWorkspace.mockResolvedValue({ ...targetWorkspace(), ...assuranceFacts() });

    await renderWorkbench();

    expect(getWorkspace).toHaveBeenCalledWith("workspace-1", "target-1");
    expect(container.textContent).toContain("Traceability ledger");
    expect(container.textContent).toContain("agent-1");
    expect(container.textContent).toContain("Revision 1");
    expect(container.textContent).toContain("Revision 2");
    expect(container.textContent).toContain(CONTENT_HASH_A.slice(0, 12));
    expect(container.textContent).not.toContain(CONTENT_HASH_A);
    expect(container.querySelector(`[title="${CONTENT_HASH_A}"]`)).not.toBeNull();
    expect(container.querySelector(`[title="${CONTENT_HASH_B}"]`)).not.toBeNull();
    expect(container.textContent).toContain("Run run-1");
  });

  it("groups verification results and evidence under their claims on the evidence tab", async () => {
    route.tab = "evidence";
    getWorkspace.mockResolvedValue({ ...targetWorkspace(), ...assuranceFacts() });

    await renderWorkbench();

    expect(container.textContent).toContain("Release builds cleanly");
    expect(container.textContent).toContain("criterion-1");
    expect(container.textContent).toContain("Supported");
    expect(container.textContent).toContain("Passed");
    expect(container.textContent).toContain("Verifier verifier.v1");
    expect(container.textContent).toContain("Evidence items: 1");
    expect(container.textContent).toContain("ci-runner");
    expect(container.textContent).toContain("verrail://ci/runs/run-1/report".slice(0, 12));
    expect(container.textContent).toContain(OBJECT_HASH.slice(0, 12));
    expect(container.querySelector(`[title="${OBJECT_HASH}"]`)).not.toBeNull();
    expect(container.textContent).toContain("Security review recorded");
    expect(container.textContent).toContain("Open");
    expect(container.textContent).toContain("Unbound evidence");
    expect(container.textContent).toContain("owner-1");
    expect(container.textContent).toContain("Human review");
  });

  it("keeps honest empty states for the assurance tabs without server facts", async () => {
    route.tab = "artifacts";
    await renderWorkbench();
    expect(container.textContent).toContain("No artifact revisions have been projected.");

    route.tab = "evidence";
    await renderWorkbench();
    expect(container.textContent).toContain("No verification evidence has been projected.");
  });

  it("renders submissions newest-first with reviews and the acceptance chip on the submission tab", async () => {
    route.tab = "submission";
    getWorkspace.mockResolvedValue({ ...targetWorkspace(), ...adjudicationFacts() });

    await renderWorkbench();

    expect(getWorkspace).toHaveBeenCalledWith("workspace-1", "target-1");
    expect(container.textContent).toContain(SUBMISSION_HASH_A.slice(0, 12));
    expect(container.textContent).not.toContain(SUBMISSION_HASH_A);
    expect(container.querySelector(`[title="${SUBMISSION_HASH_A}"]`)).not.toBeNull();
    expect(container.textContent.indexOf(SUBMISSION_HASH_A.slice(0, 12)))
      .toBeLessThan(container.textContent.indexOf(SUBMISSION_HASH_B.slice(0, 12)));
    expect(container.textContent).toContain("agent-1");
    expect(container.textContent).toContain("e07fc1f90ae7");
    expect(container.textContent).toContain("staging · all checks green");
    expect(container.textContent).toContain("Candidate binding for the release review.");
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("reviewer-1");
    expect(container.textContent).toContain("Load test at peak traffic");
    expect(container.textContent).toContain("Risks: Rollback plan documented.");
    expect(container.textContent).toContain("Comments: Evidence chain is complete.");
    expect(container.textContent).toContain("Accepted");
    expect(container.textContent).toContain("Outcome owner");
    expect(container.textContent).toContain("owner-1");
  });

  it("renders invalid acceptances with their derived reason on the acceptance tab", async () => {
    route.tab = "acceptance";
    getWorkspace.mockResolvedValue({ ...targetWorkspace(), ...adjudicationFacts() });

    await renderWorkbench();

    expect(container.textContent).toContain("Superseded by a newer submission");
    expect(container.textContent).toContain("Accepted");
    expect(container.textContent).toContain(`Submission ${SUBMISSION_HASH_B.slice(0, 12)}`);
    expect(container.querySelector(`[title="${SUBMISSION_HASH_B}"]`)).not.toBeNull();
    expect(container.textContent).toContain(`Review ${REVIEW_ID_A.slice(0, 12)}`);
    expect(container.querySelector(`[title="${REVIEW_ID_A}"]`)).not.toBeNull();
    expect(container.textContent).toContain("Outcome owner");
    expect(container.textContent).toContain("owner-1");
    expect(container.textContent).not.toContain(ACCEPTANCE_HASH_B);
  });

  it("keeps honest empty states for the adjudication tabs without server facts", async () => {
    route.tab = "submission";
    await renderWorkbench();
    expect(container.textContent).toContain("No immutable submission exists for this target.");

    route.tab = "acceptance";
    await renderWorkbench();
    expect(container.textContent).toContain("No version-bound acceptance has been recorded.");
  });
});
