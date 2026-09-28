import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isWorkspaceDirector } from "../../packages/shared/src/director-instructions";
import type { AgentLifecycleReadModelV1, AgentPublicationPreviewV1 } from "../../packages/shared/src/index";

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>, label: string): Promise<T> {
  expect(response.ok(), `${label} failed ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function seedWorkspace(request: APIRequestContext, label: string) {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `G1 ${label}` } }),
    "create workspace",
  );
  await json(
    await request.patch(`/api/companies/${company.id}`, { data: { enableVerrailNavigation: true } }),
    "enable Verrail navigation",
  );
  return { companyId: company.id, companyPrefix: company.issuePrefix };
}

async function deleteWorkspace(request: APIRequestContext, companyId: string) {
  const response = await request.delete(`/api/companies/${companyId}`);
  expect(response.ok() || response.status() === 404).toBe(true);
}

async function publishFixtureDirector(request: APIRequestContext, workspaceId: string) {
  const prefix = `/api/workspaces/${workspaceId}`;
  const command = (route: string, data: unknown) => request.post(`${prefix}${route}`, {
    headers: { "Idempotency-Key": `browser-fixture:${randomUUID()}` }, data,
  }).then(response => json<{ resourceId: string }>(response, route));
  const agents = await json<Array<{ id: string; metadata: unknown }>>(
    await request.get(`/api/companies/${workspaceId}/agents`), "list fixture agents");
  const director = agents.find(agent => isWorkspaceDirector(agent.metadata));
  expect(director).toBeDefined();
  const definition = await command("/agent-definitions", {
    name: "Browser fixture Director", compatibilityAgentId: director!.id,
  });
  const preview = await json<AgentPublicationPreviewV1>(
    await request.get(`${prefix}/agents/${director!.id}/publication-preview`), "publication preview");
  const version = await command(`/agent-definitions/${definition.resourceId}/publish-saved`, { sourceHash: preview.sourceHash });
  // Synthetic CLI behavior is evaluated only in this disposable browser workspace.
  const evaluation = await command("/evaluation-runs", { candidateAgentVersionId: version.resourceId,
    status: "passed", safetyStatus: "passed", summary: "Synthetic browser fixture, not a production model evaluation." });
  const lifecycle = await json<AgentLifecycleReadModelV1>(await request.get(`${prefix}/agent-lifecycle`), "lifecycle");
  const primary = lifecycle.definitions.find(item => item.id === definition.resourceId)?.deployments.find(item => item.isPrimary);
  if (primary) {
    await command(`/deployments/${primary.id}/revisions`, { action: "activate",
      agentVersionId: version.resourceId, evaluationRunId: evaluation.resourceId,
      expectedDeploymentRevisionId: primary.activeRevision!.id, expectedPrimaryDeploymentId: primary.id });
  } else {
    await command("/deployments", { agentDefinitionId: definition.resourceId, agentVersionId: version.resourceId,
      evaluationRunId: evaluation.resourceId, name: "Browser fixture Director", isDefault: true });
  }
}

function collectBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test("explicit Target creation pauses at a persisted confirmation draft", async ({ page, request }, testInfo) => {
  const seed = await seedWorkspace(request, testInfo.project.name);
  const browserErrors = collectBrowserErrors(page);
  try {
    await page.goto(`/${seed.companyPrefix}/targets`);
    await page.getByTestId("verrail-targets-sidebar").getByRole("button", { name: "New Target", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Target name").fill("Governed native delivery");
    await dialog.getByLabel("Goal").fill("Deliver one reviewable native result.");
    await dialog.getByRole("textbox", { name: "Criterion 1", exact: true }).fill("A reviewer can inspect the result");
    const createdDraft = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/target-drafts"));
    await dialog.getByRole("button", { name: "Review draft", exact: true }).click();

    await expect(dialog.getByRole("button", { name: "Confirm Target", exact: true })).toBeVisible();
    const draft = await (await createdDraft).json() as { id: string; conversationId: string };
    const persisted = await json<Array<{ id: string; status: string }>>(
      await request.get(`/api/workspaces/${seed.companyId}/conversations/${draft.conversationId}/target-drafts`), "read persisted draft");
    expect(persisted).toContainEqual(expect.objectContaining({ id: draft.id, status: "ready_for_confirmation" }));
    const targets = await json<{ items: unknown[] }>(
      await request.get(`/api/workspaces/${seed.companyId}/targets`),
      "list Targets before confirmation",
    );
    expect(targets.items).toEqual([]);
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  } finally {
    await page.close();
    await deleteWorkspace(request, seed.companyId);
  }
});

test("ordinary conversation messages do not create Target drafts or Targets", async ({ page, request }, testInfo) => {
  const seed = await seedWorkspace(request, `ordinary ${testInfo.project.name}`);
  const browserErrors = collectBrowserErrors(page);
  try {
    await publishFixtureDirector(request, seed.companyId);
    await page.goto(`/${seed.companyPrefix}/chat`);
    await page.getByRole("textbox", { name: "Ask Verrail...", exact: true }).fill("Summarize the delivery context");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/chat/[0-9a-f-]+$`));
    await expect(page.getByText("Acceptance runtime response", { exact: true })).toBeVisible();
    const conversationId = new URL(page.url()).pathname.split("/").at(-1);
    const drafts = await json<unknown[]>(await request.get(
      `/api/workspaces/${seed.companyId}/conversations/${conversationId}/target-drafts`), "ordinary conversation drafts");
    expect(drafts).toEqual([]);
    const targets = await json<{ items: unknown[] }>(
      await request.get(`/api/workspaces/${seed.companyId}/targets`),
      "list Targets after ordinary message",
    );
    expect(targets.items).toEqual([]);
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  } finally {
    await page.close();
    await deleteWorkspace(request, seed.companyId);
  }
});

test("confirmed Target opens an authority-aware Workbench and appears in Home attention", async ({ page, request }, testInfo) => {
  const seed = await seedWorkspace(request, `workbench ${testInfo.project.name}`);
  const browserErrors = collectBrowserErrors(page);
  const failedResponses: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
  try {
    await page.goto(`/${seed.companyPrefix}/targets`);
    await page.getByTestId("verrail-targets-sidebar").getByRole("button", { name: "New Target", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Target name").fill("Production closure workbench");
    await dialog.getByLabel("Goal").fill("Operate the governed delivery loop from the product UI.");
    await dialog.getByRole("textbox", { name: "Criterion 1", exact: true }).fill("Every command exposes authoritative state");
    await dialog.getByRole("button", { name: "Review draft", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm Target", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/targets/[0-9a-f-]+/overview$`));
    await expect(page.getByRole("heading", { name: "Next actions", exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Include blocked and completed", exact: true }).check();
    await expect(page.getByText("Define graph revision", { exact: true })).toBeVisible();
    await expect(page.locator('[data-command-id="activate_graph_revision"]')).toContainText("Blocked");
    await expect(page.getByText("An authorized Agent or Service must issue this candidate command.", { exact: false })).toHaveCount(0);
    await expect(page.locator('[data-command-id="activate_graph_revision"] button:enabled')).toHaveCount(0);

    const refresh = page.getByRole("button", { name: "Refresh authoritative facts", exact: true });
    await refresh.focus();
    await expect(refresh).toBeFocused();

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      commandWidth: document.querySelector('[aria-labelledby="target-commands-title"]')?.getBoundingClientRect().width ?? 0,
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.commandWidth).toBeGreaterThan(0);

    const screenshotRoot = process.env.VERRAIL_ACCEPTANCE_SCREENSHOT_DIR
      ?? path.resolve("tests/verrail-acceptance/screenshots");
    await fs.mkdir(screenshotRoot, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotRoot, `${testInfo.project.name}-target-workbench.png`),
      fullPage: true,
    });

    await page.goto(`/${seed.companyPrefix}`);
    await expect(page.getByText("Production closure workbench", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Work graph needs activation", { exact: true })).toBeVisible();
    await page.getByText("Production closure workbench", { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Next actions", exact: true })).toBeVisible();

    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
    expect(failedResponses, failedResponses.join("\n")).toEqual([]);
  } finally {
    await page.close();
    await deleteWorkspace(request, seed.companyId);
  }
});
