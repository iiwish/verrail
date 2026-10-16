import { afterEach, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
import { captureClaudeCliUsageText, readClaudeAuthStatus } from "./quota.js";

afterEach(() => {
  vi.unstubAllEnvs();
  execFile.mockReset();
});

it("filters control-plane credentials from both Claude probe child environments", async () => {
  const keys = ["VERRAIL_DOMAIN_API_TOKEN", "verrail_github_ci_proof_token", "ACPX_AUTH_VERRAIL_DOMAIN_API_TOKEN", "acpx_auth_verrail_github_ci_proof_token"];
  for (const key of keys) vi.stubEnv(key, "fixture-control-credential");
  vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
  execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(null, '{"loggedIn":false}', "");
  });
  await readClaudeAuthStatus();
  await captureClaudeCliUsageText().catch(() => undefined);
  expect(execFile).toHaveBeenCalledTimes(2);
  for (const call of execFile.mock.calls) {
    const env = call[2].env;
    for (const key of keys) expect(env[key]).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("fixture-model-key");
  }
});
