import { describe, expect, it, vi } from "vitest";
import type { ReportRunEventResponseV1 } from "@paperclipai/shared";
import {
  createVerrailRunExecutor,
  type NativeHeartbeatRun,
  type NativeRunLeaseCandidate,
  type VerrailRunExecutorStore,
} from "./verrail-run-executor.js";
import { resolveHeartbeatTaskMarkdown } from "./heartbeat.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { captureNativeOutput, finalizeNativeOutputReceipt } from "./verrail-native-output.js";
import { NATIVE_SOURCE_CONTEXT_KEY, unavailableNativeSource } from "./verrail-native-source.js";

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

function harness(input: { lease?: NativeRunLeaseCandidate; heartbeat?: NativeHeartbeatRun | null; collectArtifacts?: (...args: unknown[]) => Promise<unknown[]> } = {}) {
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
    runner: createVerrailRunExecutor({ store, domainApi, heartbeat: heartbeatExecutor, ...{ collectArtifacts: input.collectArtifacts } }),
  };
}

describe("verrail native run executor", () => {
  it.each(["succeeded", "failed"])("projects only independently correlated persisted source into %s facts", async (status) => {
    const source = unavailableNativeSource({ workspaceId: "workspace-1", heartbeatRunId: "heartbeat-1", agentId: "agent-1", runId: "run-1", attemptId: "attempt-1", deploymentRevisionId: "deployment-revision-1", agentVersionId: "version-1" }, "not_git");
    const test = harness({ heartbeat: heartbeatRun({ status, nativeSourceObservation: source }) });
    await test.runner.tick();
    expect(test.reports.at(-1)?.payload?.sourceObservation).toEqual(source);
  });
  it("does not trust even structurally valid caller context or foreign stored source", async () => {
    const source = unavailableNativeSource({ workspaceId: "workspace-1", heartbeatRunId: "heartbeat-1", agentId: "agent-1", runId: "foreign-run", attemptId: "attempt-1", deploymentRevisionId: "deployment-revision-1", agentVersionId: "version-1" }, "not_git");
    const test = harness({ heartbeat: heartbeatRun({ status: "succeeded", nativeSourceObservation: source, contextSnapshot: { [NATIVE_SOURCE_CONTEXT_KEY]: { ...source, identity: { ...source.identity, runId: "run-1" } } } }) });
    await test.runner.tick();
    expect(test.reports.at(-1)?.payload?.sourceObservation).toBeNull();
  });
  it("never backfills source for historical terminal runs", async () => {
    const test = harness({ heartbeat: heartbeatRun({ status: "succeeded" }) });
    await test.runner.tick();
    expect(test.reports.at(-1)?.payload?.sourceObservation).toBeNull();
  });
  it("does not recollect mutable files for a historical terminal run with no receipt", async () => {
    const collectArtifacts = vi.fn().mockResolvedValue([]);
    const test = harness({ heartbeat: heartbeatRun({ status: "succeeded" }), collectArtifacts });
    await test.runner.tick();
    expect(collectArtifacts).not.toHaveBeenCalled();
    expect(test.reports.at(-1)?.payload?.outputReceipt).toBeNull();
  });
  it("records invalid stored receipt as native failure without fallback or private data", async () => {
    const collectArtifacts = vi.fn().mockRejectedValue(new Error("private contents"));
    const test = harness({ heartbeat: heartbeatRun({ status: "succeeded", nativeOutputReceiptInvalid: true }), collectArtifacts });
    await expect(test.runner.tick()).resolves.toMatchObject({ failed: 1, succeeded: 0, errors: 0 });
    expect(collectArtifacts).not.toHaveBeenCalled();
    expect(test.reports.at(-1)).toMatchObject({ eventType: "failed", payload: { errorCode: "NATIVE_OUTPUT_RECEIPT_INVALID" } });
    expect(JSON.stringify(test.reports)).not.toContain("private contents");
  });
  it("replays byte-identical full success commands after lost response, workspace deletion and executor restart", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "native-replay-"));
    const lease = candidate({ workspaceId: "86679997-3f3a-4477-a2fa-d4da812140ae", compatibilityAgentWorkspaceId: "86679997-3f3a-4477-a2fa-d4da812140ae", runAttemptId: "1e82be4a-a466-4c28-bee6-eb9609b68401", leaseStatus: "active", attemptStatus: "running", lastEventCursor: 2 });
    const identity = { workspaceId: lease.workspaceId, heartbeatRunId: "heartbeat-1", agentId: "agent-1", runId: lease.runId, attemptId: lease.runAttemptId, deploymentRevisionId: lease.deploymentRevisionId, agentVersionId: lease.agentVersionId };
    try {
      const output = path.join(cwd, ".verrail/run-artifacts", lease.runAttemptId);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, "report.txt"), "frozen bytes");
      await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1, artifacts: [{ path: "report.txt", title: "Report", kind: "report" }] }));
      const receipt = finalizeNativeOutputReceipt(await captureNativeOutput({ cwd, identity,
        beforeSource: unavailableNativeSource(identity, "not_git"), revalidate: async () => {},
        storage: { putFile: async (input) => { const sha256 = createHash("sha256").update(input.body).digest("hex"); return { sha256, byteSize: input.body.length, objectKey: `${identity.workspaceId}/verrail/run-artifacts/sha256/${sha256}` } as any; } },
      }), { heartbeatRunId: identity.heartbeatRunId, heartbeatStatus: "succeeded", agentId: identity.agentId,
        logStore: "local_file", logRef: "actual.log", logSha256: "a".repeat(64), logBytes: 123, usage: { inputTokens: 42, costUsd: 0.02 }, exitCode: 0, errorCode: null, environmentManifest: null });
      const heartbeat = heartbeatRun({ status: "succeeded", nativeOutputReceipt: receipt });
      const test = harness({ lease, heartbeat });
      test.domainApi.reportRunEvent.mockRejectedValueOnce(new Error("ambiguous response"));
      await expect(test.runner.tick()).resolves.toMatchObject({ errors: 1 });
      const first = JSON.stringify(test.domainApi.reportRunEvent.mock.calls[0]?.[0]);
      await rm(cwd, { recursive: true, force: true });
      heartbeat.usageJson = { inputTokens: 999 };
      heartbeat.logRef = "mutated.log";
      heartbeat.contextSnapshot = { verrailEnvironmentManifest: { forged: true } };
      const restarted = harness({ lease: { ...lease, attemptUpdatedAt: new Date() }, heartbeat });
      await expect(restarted.runner.tick()).resolves.toMatchObject({ succeeded: 1 });
      expect(JSON.stringify(restarted.domainApi.reportRunEvent.mock.calls[0]?.[0])).toBe(first);
      expect(restarted.domainApi.reportRunEvent).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ artifacts: [expect.objectContaining({ contentHash: receipt.artifacts[0]!.contentHash })], payload: expect.objectContaining({ usage: { inputTokens: 42, costUsd: 0.02 }, logRef: "actual.log" }) }) }));
    } finally { await rm(cwd, { recursive: true, force: true }); }
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
  it("reloads a fast terminal invocation through the trusted store before reporting", async () => {
    const test = harness();
    test.heartbeatExecutor.invoke.mockResolvedValueOnce(heartbeatRun({ status: "succeeded" }));
    (test.store.findHeartbeatRun as any).mockResolvedValueOnce(null).mockResolvedValueOnce(heartbeatRun({ status: "succeeded", nativeOutputReceiptInvalid: true }));
    await test.runner.tick();
    expect(test.store.findHeartbeatRun).toHaveBeenCalledTimes(2);
    expect(test.reports.some((event) => event.eventType === "succeeded")).toBe(false);
    expect(test.reports.at(-1)).toMatchObject({ eventType: "failed", payload: { errorCode: "NATIVE_OUTPUT_RECEIPT_INVALID" } });
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
