import { describe, expect, it, vi } from "vitest";
import type { ReportRunEventResponseV1 } from "@paperclipai/shared";
import {
  createVerrailRunExecutor,
  type NativeHeartbeatRun,
  type NativeRunLeaseCandidate,
  type VerrailRunExecutorStore,
} from "./verrail-run-executor.js";
import { resolveHeartbeatTaskMarkdown } from "./heartbeat.js";
import { NativeRunArtifactError } from "./verrail-run-artifacts.js";

function candidate(overrides: Partial<NativeRunLeaseCandidate> = {}): NativeRunLeaseCandidate {
  return {
    workspaceId: "workspace-1",
    runId: "run-1",
    runAttemptId: "attempt-1",
    leaseId: "lease-1",
    leaseStatus: "offered",
    attemptStatus: "pending",
    runStatus: "queued",
    fencingToken: 1,
    lastEventCursor: 0,
    attemptUpdatedAt: new Date("2026-09-05T00:00:00.000Z"),
    runtimeProfile: "host_trusted",
    executorPrincipalId: "verrail-host-runner",
    deploymentRevisionId: "deployment-revision-1",
    runDeploymentRevisionId: "deployment-revision-1",
    deploymentRevisionState: "active",
    deploymentStatus: "active",
    deploymentAgentDefinitionId: "definition-1",
    agentVersionId: "version-1",
    runAgentVersionId: "version-1",
    revisionAgentVersionId: "version-1",
    agentDefinitionId: "definition-1",
    agentRuntime: "codex_local",
    agentModel: "gpt-5.6-sol",
    agentPrompt: "Pinned delivery prompt.",
    compatibilityAgentId: "agent-1",
    compatibilityAgentWorkspaceId: "workspace-1",
    compatibilityAgentAdapterType: "codex_local",
    compatibilityAgentAdapterConfig: { model: "gpt-5.6-sol" },
    compatibilityAgentCapabilities: "Pinned delivery prompt.",
    responsibleUserId: "user-1",
    targetId: "target-1",
    targetRevisionId: "target-revision-1",
    graphRevisionId: "graph-revision-1",
    workNodeId: "node-1",
    workNodeKey: "implement",
    workNodeTitle: "Implement the target",
    completionDefinition: "Produce a reviewed code artifact.",
    targetTitle: "Production target",
    targetGoal: "Deliver the production change.",
    targetConstraints: ["Do not expose secrets."],
    targetAcceptanceCriteria: [{ id: "ac-1", title: "Tests pass", description: null }],
    ...overrides,
  };
}

function heartbeatRun(overrides: Partial<NativeHeartbeatRun> = {}): NativeHeartbeatRun {
  return {
    id: "heartbeat-1",
    agentId: "agent-1",
    status: "running",
    contextSnapshot: { verrailRunAttemptId: "attempt-1" },
    usageJson: null,
    logStore: "local_file",
    logRef: "runs/heartbeat-1.log",
    logSha256: "sha256-log",
    logBytes: 128,
    exitCode: null,
    errorCode: null,
    error: null,
    ...overrides,
  };
}

function harness(input: { lease?: NativeRunLeaseCandidate; heartbeat?: NativeHeartbeatRun | null; collectArtifacts?: Parameters<typeof createVerrailRunExecutor>[0]["collectArtifacts"] } = {}) {
  let lease = input.lease ?? candidate();
  let heartbeat = input.heartbeat ?? null;
  const store: VerrailRunExecutorStore = {
    listCandidates: vi.fn(async () => [lease]),
    findHeartbeatRun: vi.fn(async () => heartbeat),
  };
  const reports: Array<{ eventType: string; cursor: number; payload?: Record<string, unknown> }> = [];
  const domainApi = {
    reportRunEvent: vi.fn(async (command: any) => {
      reports.push(command.input);
      lease = {
        ...lease,
        lastEventCursor: command.input.cursor,
        leaseStatus: command.input.eventType === "claimed" || command.input.eventType === "heartbeat"
          ? "active"
          : command.input.eventType === "succeeded" || command.input.eventType === "failed" || command.input.eventType === "terminated"
            ? "released"
            : lease.leaseStatus,
        attemptStatus: command.input.eventType === "started"
          ? "running"
          : command.input.eventType === "cancel_acknowledged"
            ? "cancel_acknowledged"
            : lease.attemptStatus,
      };
      return {
        schemaVersion: 1 as const,
        runId: lease.runId,
        runAttemptId: lease.runAttemptId,
        cursor: command.input.cursor,
        eventType: command.input.eventType,
        authoritative: true,
        rejectionCode: null,
        runStatus: lease.runStatus,
        attemptStatus: lease.attemptStatus,
        leaseStatus: lease.leaseStatus,
        replayed: false,
      } as ReportRunEventResponseV1;
    }),
  };
  const heartbeatExecutor = {
    invoke: vi.fn(async () => {
      heartbeat = heartbeatRun({ status: "running" });
      return heartbeat;
    }),
    cancelRun: vi.fn(async () => heartbeat),
  };
  return {
    store,
    reports,
    domainApi,
    heartbeatExecutor,
    runner: createVerrailRunExecutor({ store, domainApi, heartbeat: heartbeatExecutor, collectArtifacts: input.collectArtifacts }),
  };
}

describe("verrail native run executor", () => {
  it("attaches collected outputs only to the succeeded service event", async () => {
    const artifacts = [{ title: "Candidate", kind: "report" as const, contentHash: "a".repeat(64), contentRef: "storage:workspace-1/verrail/run-artifacts/sha256/" + "a".repeat(64) }];
    const collectArtifacts = vi.fn().mockResolvedValue(artifacts);
    const test = harness({ heartbeat: heartbeatRun({ status: "succeeded" }), collectArtifacts });
    await expect(test.runner.tick()).resolves.toMatchObject({ succeeded: 1 });
    expect(collectArtifacts).toHaveBeenCalledOnce();
    expect(test.domainApi.reportRunEvent).toHaveBeenLastCalledWith(expect.objectContaining({ principalType: "service", principalId: "verrail-host-runner", input: expect.objectContaining({ eventType: "succeeded", artifacts }) }));
  });
  it("does not declare success when output collection fails", async () => {
    const collectArtifacts = vi.fn().mockRejectedValue(new Error("NATIVE_ARTIFACT_INVALID"));
    const test = harness({ heartbeat: heartbeatRun({ status: "succeeded" }), collectArtifacts });
    await expect(test.runner.tick()).resolves.toMatchObject({ succeeded: 0, errors: 1 });
    expect(test.reports.some((event) => event.eventType === "succeeded")).toBe(false);
  });
  it("records an observable native failure for invalid output without leaking file contents", async () => {
    const collectArtifacts = vi.fn().mockRejectedValue(new NativeRunArtifactError(new Error("private contents")));
    const test = harness({ heartbeat: heartbeatRun({ status: "succeeded" }), collectArtifacts });
    await expect(test.runner.tick()).resolves.toMatchObject({ failed: 1, succeeded: 0, errors: 0 });
    expect(test.reports.at(-1)).toMatchObject({ eventType: "failed", payload: { errorCode: "NATIVE_ARTIFACT_INVALID" } });
    expect(JSON.stringify(test.reports)).not.toContain("private contents");
  });
  it("claims before invoking and starts the correlated heartbeat run", async () => {
    const test = harness();

    await expect(test.runner.tick()).resolves.toMatchObject({ processed: 1, started: 1 });

    expect(test.reports.map((event) => event.eventType)).toEqual(["claimed", "started"]);
    expect(test.heartbeatExecutor.invoke).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-1",
      idempotencyKey: "verrail-run-attempt:attempt-1",
      responsibleUserId: "user-1",
      contextSnapshot: expect.objectContaining({
        verrailRunAttemptId: "attempt-1",
        verrailRunId: "run-1",
        taskKey: "verrail:run:run-1",
        verrailTaskMarkdown: expect.stringContaining("Deliver the production change."),
      }),
    }));
  });

  it("isolates different Runs on the same node while retaining the session across attempts", async () => {
    const first = harness();
    const nextRun = harness({ lease: candidate({ runId: "run-2", graphRevisionId: "graph-revision-2" }) });
    const retry = harness({ lease: candidate({ runAttemptId: "attempt-2", fencingToken: 2 }) });
    for (const test of [first, nextRun, retry]) await test.runner.tick();
    for (const [test, taskKey] of [[first, "verrail:run:run-1"], [nextRun, "verrail:run:run-2"], [retry, "verrail:run:run-1"]] as const) {
      expect(test.heartbeatExecutor.invoke).toHaveBeenCalledWith(expect.objectContaining({
        contextSnapshot: expect.objectContaining({ taskKey }),
      }));
    }
  });

  it("sends the immutable AgentVersion prompt as execution input rather than only checking it", async () => {
    const test = harness();
    await test.runner.tick();
    expect(test.heartbeatExecutor.invoke).toHaveBeenCalledWith(expect.objectContaining({
      contextSnapshot: expect.objectContaining({
        verrailTaskMarkdown: expect.stringContaining("Pinned delivery prompt."),
      }),
    }));
  });

  it("includes authoritative native identities so the agent need not discover them from host state", async () => {
    const test = harness();
    await test.runner.tick();
    for (const binding of [
      "Workspace: workspace-1", "Target: target-1", "TargetRevision: target-revision-1",
      "GraphRevision: graph-revision-1", "WorkNode: node-1", "Run: run-1",
      "RunAttempt: attempt-1", "DeploymentRevision: deployment-revision-1", "FencingToken: 1",
    ]) {
      expect(test.heartbeatExecutor.invoke).toHaveBeenCalledWith(expect.objectContaining({
        contextSnapshot: expect.objectContaining({ verrailTaskMarkdown: expect.stringContaining(binding) }),
      }));
    }
  });

  it("reuses the durable heartbeat correlation after restart", async () => {
    const existing = heartbeatRun({ status: "running" });
    const test = harness({
      lease: candidate({ leaseStatus: "active", attemptStatus: "running", lastEventCursor: 2 }),
      heartbeat: existing,
    });

    await test.runner.tick();

    expect(test.heartbeatExecutor.invoke).not.toHaveBeenCalled();
    expect(test.reports.map((event) => event.eventType)).toEqual(["heartbeat"]);
    expect(test.reports[0]).toMatchObject({ cursor: 3 });
  });

  it("renews the lease without reporting started while heartbeat execution is queued", async () => {
    const test = harness({
      lease: candidate({ leaseStatus: "active", attemptStatus: "pending", lastEventCursor: 1 }),
      heartbeat: heartbeatRun({ status: "queued" }),
    });

    await expect(test.runner.tick()).resolves.toMatchObject({ renewed: 1, started: 0 });

    expect(test.reports.map((event) => event.eventType)).toEqual(["heartbeat"]);
  });

  it("reports inspectable execution facts when the heartbeat succeeds", async () => {
    const test = harness({
      lease: candidate({ leaseStatus: "active", attemptStatus: "running", runStatus: "running", lastEventCursor: 4 }),
      heartbeat: heartbeatRun({ status: "succeeded", usageJson: { inputTokens: 25 }, exitCode: 0 }),
    });

    await test.runner.tick();

    expect(test.reports).toEqual([
      expect.objectContaining({
        eventType: "succeeded",
        cursor: 5,
        payload: expect.objectContaining({
          heartbeatRunId: "heartbeat-1",
          logRef: "runs/heartbeat-1.log",
          logSha256: "sha256-log",
          usage: { inputTokens: 25 },
        }),
      }),
    ]);
  });

  it("propagates cancellation and terminates only after the heartbeat is terminal", async () => {
    const test = harness({
      lease: candidate({ leaseStatus: "active", attemptStatus: "cancel_requested", runStatus: "cancel_requested", lastEventCursor: 2 }),
      heartbeat: heartbeatRun({ status: "cancelled" }),
    });

    await test.runner.tick();

    expect(test.heartbeatExecutor.cancelRun).not.toHaveBeenCalled();
    expect(test.reports.map((event) => event.eventType)).toEqual(["cancel_acknowledged", "terminated"]);
  });

  it("cancels an active heartbeat and waits for its terminal fact", async () => {
    const test = harness({
      lease: candidate({ leaseStatus: "active", attemptStatus: "cancel_requested", runStatus: "cancel_requested", lastEventCursor: 2 }),
      heartbeat: heartbeatRun({ status: "running" }),
    });

    await expect(test.runner.tick()).resolves.toMatchObject({ canceling: 1, terminated: 0 });

    expect(test.heartbeatExecutor.cancelRun).toHaveBeenCalledWith(
      "heartbeat-1",
      "Native Run run-1 requested cancellation",
    );
    expect(test.reports.map((event) => event.eventType)).toEqual(["cancel_acknowledged"]);
  });

  it("fails closed when the versioned runtime identity does not match", async () => {
    const test = harness({ lease: candidate({ compatibilityAgentAdapterType: "claude_local" }) });

    await test.runner.tick();

    expect(test.heartbeatExecutor.invoke).not.toHaveBeenCalled();
    expect(test.reports.map((event) => event.eventType)).toEqual(["claimed", "failed"]);
    expect(test.reports[1]?.payload).toMatchObject({ errorCode: "NATIVE_EXECUTION_IDENTITY_INVALID" });
  });

  it.each([
    ["model", { compatibilityAgentAdapterConfig: { model: "gpt-5.4" } }],
    ["prompt", { compatibilityAgentCapabilities: "Mutable prompt changed." }],
  ])("fails closed when the pinned %s differs from the compatibility executor", async (_label, mismatch) => {
    const test = harness({ lease: candidate(mismatch) });

    await test.runner.tick();

    expect(test.heartbeatExecutor.invoke).not.toHaveBeenCalled();
    expect(test.reports.map((event) => event.eventType)).toEqual(["claimed", "failed"]);
    expect(test.reports[1]?.payload).toMatchObject({ errorCode: "NATIVE_EXECUTION_IDENTITY_INVALID" });
  });

  it("keeps native Target task markdown when there is no legacy Issue", () => {
    expect(resolveHeartbeatTaskMarkdown(null, "# Native Target\n\nDo the work.")).toBe("# Native Target\n\nDo the work.");
    expect(resolveHeartbeatTaskMarkdown("# Issue", "# Native Target")).toBe("# Issue");
  });
});
