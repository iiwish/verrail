import { afterEach, describe, expect, it, vi } from "vitest";
import { isForbiddenConfigEnvKey, runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";
import { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";
import { finalizeLaunchEnvironment } from "./acpx-engine/execute.js";

const keys = ["VERRAIL_DOMAIN_API_TOKEN", "verrail_github_ci_proof_token", "ACPX_AUTH_VERRAIL_DOMAIN_API_TOKEN", "acpx_auth_verrail_github_ci_proof_token"];
const fixture = Object.fromEntries(keys.map(key => [key, "fixture-control-plane-credential"]));
afterEach(() => vi.unstubAllEnvs());

describe("control-plane capability environment boundary", () => {
  it("rejects direct and ACPX-promoted config aliases without blocking run or model credentials", () => {
    for (const key of keys) expect(isForbiddenConfigEnvKey(key)).toBe(true);
    expect(isForbiddenConfigEnvKey("OPENAI_API_KEY")).toBe(false);
    expect(isForbiddenConfigEnvKey("PAPERCLIP_API_KEY")).toBe(true);
  });
  it("removes inherited and remote credentials, including explicit reinjection", () => {
    expect(sanitizeInheritedPaperclipEnv({ ...fixture, OPENAI_API_KEY: "model-key", PATH: "/usr/bin" }))
      .toEqual({ OPENAI_API_KEY: "model-key", PATH: "/usr/bin" });
    expect(sanitizeRemoteExecutionEnv({ ...fixture, PAPERCLIP_API_KEY: "run-key", OPENAI_API_KEY: "model-key" }, {}))
      .toEqual({ PAPERCLIP_API_KEY: "run-key", OPENAI_API_KEY: "model-key" });
  });
  it("sanitizes ACPX launch state before session persistence after all contributions", () => {
    for (const key of keys) vi.stubEnv(key, fixture[key]);
    const launch = finalizeLaunchEnvironment({ ...fixture, PAPERCLIP_API_KEY: "run-key", OPENAI_API_KEY: "model-key" },
      [{ env: fixture, scope: "run" }] as never);
    for (const key of keys) expect(launch.env[key]).toBeUndefined();
    expect(launch.env.PAPERCLIP_API_KEY).toBe("run-key"); expect(launch.env.OPENAI_API_KEY).toBe("model-key");
    expect(Object.isFrozen(launch.env)).toBe(true);
  });
  it("does not pass inherited or explicitly overlaid capabilities to a real child", async () => {
    for (const key of keys) vi.stubEnv(key, fixture[key]);
    const result = await runChildProcess("control-plane-env-fixture", process.execPath,
      ["-e", `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify([...keys, "PAPERCLIP_API_KEY", "OPENAI_API_KEY"])}.map(k=>[k,process.env[k]??null]))))`], {
        cwd: process.cwd(), env: { ...fixture, PAPERCLIP_API_KEY: "run-key", OPENAI_API_KEY: "model-key" },
        timeoutSec: 5, graceSec: 1, onLog: async () => {},
      });
    expect(result.exitCode).toBe(0); const observed = JSON.parse(result.stdout);
    for (const key of keys) expect(observed[key]).toBeNull();
    expect(observed.PAPERCLIP_API_KEY).toBe("run-key"); expect(observed.OPENAI_API_KEY).toBe("model-key");
    for (const key of keys) expect(process.env[key]).toBe(fixture[key]);
  });
});
