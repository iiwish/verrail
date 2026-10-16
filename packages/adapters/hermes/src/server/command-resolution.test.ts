import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";

import { HERMES_CLI } from "../shared/constants.js";
import { resolveHermesCommand } from "./execute.js";
import { testEnvironment } from "./test.js";

test("resolveHermesCommand prefers hermesCommand over command", () => {
  expect(resolveHermesCommand({ hermesCommand: "hermes_maximus", command: "hermes_backup" }))
    .toBe("hermes_maximus");
});

test("resolveHermesCommand falls back to command before default hermes binary", () => {
  expect(resolveHermesCommand({ command: "hermes_maximus" })).toBe("hermes_maximus");
  expect(resolveHermesCommand({})).toBe(HERMES_CLI);
});

test("testEnvironment accepts config.command when hermesCommand is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-command-resolution-"));
  const cliPath = path.join(tempDir, "fake-hermes");

  try {
    await writeFile(
      cliPath,
      "#!/bin/sh\necho fake-hermes 1.2.3\n",
      "utf8",
    );
    await chmod(cliPath, 0o755);

    const result = await testEnvironment({
      companyId: "company-test",
      adapterType: "hermes_local",
      config: {
        command: cliPath,
      },
    });

    expect(result.status).not.toBe("fail");
    expect(result.checks.some((check) => check.code === "hermes_cli_not_found")).toBe(false);
    expect(result.checks.some(
      (check) => check.code === "hermes_version" && check.message.includes("fake-hermes 1.2.3"),
    )).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("configured Hermes probes do not inherit control-plane credentials", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-env-probe-"));
  const cliPath = path.join(tempDir, "fake-hermes");
  const keys = ["VERRAIL_DOMAIN_API_TOKEN", "verrail_github_ci_proof_token", "ACPX_AUTH_VERRAIL_DOMAIN_API_TOKEN", "acpx_auth_verrail_github_ci_proof_token"];
  try {
    for (const key of keys) vi.stubEnv(key, "fixture-control-credential");
    vi.stubEnv("OPENAI_API_KEY", "fixture-model-key");
    vi.stubEnv("HOME", tempDir);
    await writeFile(cliPath, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify([...keys, "OPENAI_API_KEY"])}.map(key => [key, process.env[key] ?? null]))));\n`, "utf8");
    await chmod(cliPath, 0o755);
    const result = await testEnvironment({ companyId: "fixture", adapterType: "hermes_local", config: { command: cliPath } });
    const version = result.checks.find((check) => check.code === "hermes_version")?.message ?? "";
    expect(version).toContain("fixture-model-key");
    expect(version).not.toContain("fixture-control-credential");
  } finally {
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  }
});
