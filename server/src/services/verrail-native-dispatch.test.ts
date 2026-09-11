import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bindNativeDispatchConfiguration, validateNativeDispatchConfiguration } from "./verrail-native-dispatch.js";

function input() {
  const identity = Object.fromEntries(["workspaceId", "runId", "attemptId", "heartbeatRunId", "agentId", "agentVersionId", "deploymentRevisionId"].map(key => [key, randomUUID()])) as never;
  return { identity, runtime: "codex_local", model: "test-model", agentVersionContentHash: "a".repeat(64), deploymentRevisionContentHash: "b".repeat(64),
    permissionConfig: { engine: "cli", dangerouslyBypassApprovalsAndSandbox: false },
    config: { engine: "cli", model: "test-model", dangerouslyBypassApprovalsAndSandbox: false, env: { PRIVATE_TOKEN: "not-for-output" } } as Record<string, unknown> };
}
describe("native dispatch configuration binding", () => {
  it("binds selected dispatch fields to immutable revision configuration without secrets", () => {
    const s = input(), result = bindNativeDispatchConfiguration(s);
    expect(result.binding).toBe("version_bound");
    expect(validateNativeDispatchConfiguration(result, s.identity)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|not-for-output|env/);
    expect(result.limitations).toContain("not_effective_permission_enforcement");
  });
  it.each(["model", "engine", "bypass", "extra_args", "policy_field", "runtime"])("rejects dispatch drift: %s", change => {
    const s = input();
    if (change === "model") s.config.model = "other-model";
    if (change === "engine") s.config.engine = "acp";
    if (change === "bypass") s.config.dangerouslyBypassApprovalsAndSandbox = true;
    if (change === "extra_args") s.config.extraArgs = ["--dangerously-bypass-approvals-and-sandbox"];
    if (change === "policy_field") Object.assign(s.permissionConfig, { env: { SECRET: "value" } });
    if (change === "runtime") s.runtime = "process";
    expect(() => bindNativeDispatchConfiguration(s)).toThrow("NATIVE_DISPATCH_CONFIGURATION_INVALID");
  });
  it("does not treat historical compatibility settings as version-bound permissions", () => {
    const s = input();
    const result = bindNativeDispatchConfiguration({ ...s, permissionConfig: undefined });
    expect(result.binding).toBe("compatibility_only");
    expect(result.versionedPermissionFieldsSha256).toBeNull();
  });
  it("rejects modified or foreign configuration records", () => {
    const s = input(), result = bindNativeDispatchConfiguration(s);
    expect(validateNativeDispatchConfiguration({ ...result, binding: "compatibility_only" }, s.identity)).toBeNull();
    expect(validateNativeDispatchConfiguration(result, { ...result.identity, runId: randomUUID() })).toBeNull();
  });
});
