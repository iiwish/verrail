import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVitest } from "vitest/node";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the stable runner covers every configured non-server project", async () => {
  const vitest = await createVitest("test", { root: repoRoot, watch: false });
  try {
    const selected = ["general-workspaces-a", "general-workspaces-b"].flatMap((group) => {
      const output = execFileSync(process.execPath, ["scripts/run-vitest-stable.mjs", "--mode", "general", "--group", group, "--dry-run"], { cwd: repoRoot, encoding: "utf8" });
      return JSON.parse(output).workspaceProjects;
    });
    const expected = vitest.projects.map((project) => project.config.name).filter((name) => name !== "@paperclipai/server");
    assert.deepEqual([...selected].sort(), expected.sort());
  } finally {
    await vitest.close();
  }
});

test("the UI project bounds workers without relaxing deadlines or filtering regressions", async () => {
  const vitest = await createVitest("test", {
    root: repoRoot,
    watch: false,
    project: ["@paperclipai/ui"],
  });
  try {
    assert.equal(vitest.projects.length, 1);
    const project = vitest.projects[0];
    assert.equal(project.config.name, "@paperclipai/ui");
    assert.equal(project.config.maxWorkers, 2);
    assert.equal(project.config.testTimeout ?? vitest.config.testTimeout, 5_000);
    assert.equal(project.config.retry ?? vitest.config.retry ?? 0, 0);
    assert.equal(project.config.testNamePattern, undefined);

    const files = new Set((await vitest.globTestSpecifications()).map((spec) => spec.moduleId));
    for (const file of [
      "pages/CompanyEnvironments.test.tsx",
      "pages/CompanySettings.test.tsx",
      "pages/Inbox.test.tsx",
      "pages/Secrets.render.test.tsx",
      "components/AgentActionButtons.test.tsx",
      "components/AgentConfigForm.render.test.tsx",
      "components/IssuesList.test.tsx",
      "components/OnboardingWizard.step.test.tsx",
    ]) {
      assert.ok(files.has(path.join(repoRoot, "ui/src", file)), `${file} must stay in the UI suite`);
    }
  } finally {
    await vitest.close();
  }
});
