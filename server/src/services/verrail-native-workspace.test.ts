import { describe, expect, it } from "vitest";
import { validateNativeWorkspaceBinding, type NativeWorkspaceBinding } from "./verrail-native-workspace.js";

const input = {workspaceId: "workspace-1", agentId: "agent-1", attemptId: "attempt-1", runId: "run-1"};
const binding: NativeWorkspaceBinding = {
  ...input, compatibilityAgentId: "agent-1", deploymentRevisionId: "deployment-1", agentVersionId: "version-1",
  revisionAgentVersionId: "version-1", executorPrincipalId: "verrail-host-runner", runtimeProfile: "host_trusted",
  leaseStatus: "active", requestedByActorType: "system", requestedByActorId: "verrail-host-runner",
  leaseGraceExpiresAt: new Date("2099-01-01"), attemptStatus: "running",
  wakeIdempotencyKey: "verrail-run-attempt:attempt-1", runtimeConfig: {cwd: "/workspace/verrail"},
};

describe("native immutable workspace binding", () => {
  it("uses only the pinned deployment cwd", () => {
    expect(validateNativeWorkspaceBinding(binding, input)).toEqual({cwd: "/workspace/verrail", deploymentRevisionId: "deployment-1", agentVersionId: "version-1"});
  });
  it("accepts a claimed pending attempt before the heartbeat emits started", () => {
    expect(validateNativeWorkspaceBinding({...binding, attemptStatus: "pending"}, input).cwd).toBe("/workspace/verrail");
  });
  it.each([
    {workspaceId: "other"}, {agentId: "other"}, {compatibilityAgentId: "other"}, {attemptId: "other"}, {runId: "other"},
    {revisionAgentVersionId: "other"}, {requestedByActorType: "agent"}, {requestedByActorId: "other"},
    {wakeIdempotencyKey: "forged"}, {executorPrincipalId: "other"}, {runtimeProfile: "sandbox"}, {leaseStatus: "released"},
    {attemptStatus: "cancel_requested"}, {attemptStatus: "succeeded"}, {leaseGraceExpiresAt: new Date(0)},
  ])("rejects a foreign, forged or stale binding: %j", (patch) => {
    expect(() => validateNativeWorkspaceBinding({...binding, ...patch}, input)).toThrow("NATIVE_WORKSPACE_BINDING_INVALID");
  });
  it.each([undefined, "", "relative/path", "/invalid\0path", 42])("rejects missing or invalid cwd %j", (cwd) => {
    expect(() => validateNativeWorkspaceBinding({...binding, runtimeConfig: {cwd}}, input)).toThrow("NATIVE_WORKSPACE_UNCONFIGURED");
  });
  it("rejects an uncorrelated heartbeat", () => {
    expect(() => validateNativeWorkspaceBinding(null, input)).toThrow("NATIVE_WORKSPACE_BINDING_INVALID");
  });
});
