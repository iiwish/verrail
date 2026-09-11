import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVitest } from "vitest/node";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
