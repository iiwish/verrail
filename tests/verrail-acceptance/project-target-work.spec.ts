import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const SCREENSHOT_DIR = path.resolve(
  process.env.VERRAIL_ACCEPTANCE_SCREENSHOT_DIR ?? "tests/verrail-acceptance/screenshots",
);

type Seed = {
  companyId: string;
  companyPrefix: string;
  projectId: string;
  projectRef: string;
  projectName: string;
  issueTitle: string;
  targetId: string;
  targetTitle: string;
};

type WorkspaceSeed = {
  companyId: string;
  companyPrefix: string;
};

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>, label: string): Promise<T> {
  expect(response.ok(), `${label} failed ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function seedWorkspace(request: APIRequestContext, label: string): Promise<WorkspaceSeed> {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `B2.6 ${label}` } }),
    "create company",
  );
  await json(
    await request.patch(`/api/companies/${company.id}`, { data: { enableVerrailNavigation: true } }),
    "enable Verrail navigation",
  );
  return { companyId: company.id, companyPrefix: company.issuePrefix };
}

async function deleteWorkspace(request: APIRequestContext, companyId: string) {
  let lastFailure = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await request.delete(`/api/companies/${companyId}`);
    if (response.ok() || response.status() === 404) return;
    lastFailure = `attempt ${attempt}: ${response.status()} ${await response.text()}`;
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error(`delete acceptance workspace failed after 3 attempts (${lastFailure})`);
}

async function seedAcceptanceJourney(request: APIRequestContext, label: string): Promise<Seed> {
  const company = await seedWorkspace(request, label);
  const projectName = `Acceptance project ${label}`;
  const project = await json<{ id: string; urlKey: string }>(
    await request.post(`/api/companies/${company.companyId}/projects`, {
      data: { name: projectName, description: "Project to Target to Work acceptance", status: "in_progress" },
    }),
    "create project",
  );
  const issueTitle = `Legacy work ${label}`;
  const issue = await json<{ id: string }>(
    await request.post(`/api/companies/${company.companyId}/issues`, {
      data: { projectId: project.id, title: issueTitle, description: "Compatibility work item", status: "todo" },
    }),
    "create legacy work",
  );
  const projection = await json<{ targetId: string; title: string }>(
    await request.post(`/api/workspaces/${company.companyId}/target-projections`, {
      data: { sourceType: "issue", sourceId: issue.id, eligibilityReason: "operator_mapping" },
    }),
    "register Target projection",
  );

  return {
    companyId: company.companyId,
    companyPrefix: company.companyPrefix,
    projectId: project.id,
    projectRef: project.urlKey,
    projectName,
    issueTitle,
    targetId: projection.targetId,
    targetTitle: projection.title,
  };
}

function collectBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test("Project -> Target -> Work remains coherent and error-free", async ({ page, request }, testInfo) => {
  test.setTimeout(180_000);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const seed = await seedAcceptanceJourney(request, testInfo.project.name);
  const browserErrors = collectBrowserErrors(page);

  try {
    await page.goto(`/${seed.companyPrefix}/projects`);
    const primaryNavigation = page.getByTestId("verrail-primary-navigation");
    await expect(primaryNavigation.getByRole("link")).toHaveText([
      "Home",
      "Chat",
      "Projects",
      "Agents",
      "Infrastructure",
      "Governance",
      "Settings",
    ]);
    const projectList = page.locator("main");
    await expect(projectList.getByText(seed.projectName, { exact: true })).toBeVisible({ timeout: 30_000 });
    await projectList.getByText(seed.projectName, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectRef}/overview$`));
    await expect(page.getByRole("heading", { name: seed.projectName })).toBeVisible();

    await page.locator("main").getByRole("button", { name: "New Target", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "New Target" })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Close" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const projectsSidebar = page.getByTestId("verrail-projects-sidebar");
    await expect(projectsSidebar.getByRole("link", { name: seed.projectName, exact: true })).toBeVisible();
    const targetLink = projectsSidebar.getByRole("link", { name: seed.targetTitle, exact: true });
    await expect(targetLink).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${testInfo.project.name}-project-target-sidebar.png`),
      fullPage: true,
    });

    await targetLink.click();
    await expect(page).toHaveURL(new RegExp(`/targets/${seed.targetId}/overview$`));
    await expect(page.getByRole("heading", { name: seed.targetTitle })).toBeVisible();
    const breadcrumb = page.getByRole("navigation", { name: "breadcrumb" });
    await expect(breadcrumb.getByRole("link", { name: seed.projectName, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/targets/${seed.targetId}/work$`));
    await expect(page.getByText("No eligible work items have been projected.")).toBeVisible();

    await breadcrumb.getByRole("link", { name: seed.projectName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectRef}/overview$`));
    const legacyWorkResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET"
        && url.pathname === `/api/companies/${seed.companyId}/issues`
        && url.searchParams.get("projectId") === seed.projectId
        && response.ok();
    });
    const legacyWorkTab = page.getByRole("tab", { name: "Legacy work" });
    await Promise.all([
      legacyWorkResponse,
      legacyWorkTab.click(),
    ]);
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectRef}/legacy-work$`));
    await expect(legacyWorkTab).toHaveAttribute("data-state", "active");
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
    await expect(page.locator("main").getByText(seed.issueTitle, { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${testInfo.project.name}-legacy-work.png`),
      fullPage: true,
    });

    await page.goto(`/${seed.companyPrefix}/infrastructure`);
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/infrastructure/secrets$`));
    const infrastructureSidebar = page.getByTestId("verrail-infrastructure-sidebar");
    await expect(infrastructureSidebar).toBeVisible();
    await infrastructureSidebar.getByRole("link", { name: "Environments", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/infrastructure/environments$`));
    await infrastructureSidebar.getByRole("link", { name: "Adapters", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/infrastructure/adapters$`));
    await infrastructureSidebar.getByRole("link", { name: "Plugins", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/infrastructure/plugins$`));
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${testInfo.project.name}-infrastructure.png`),
      fullPage: true,
    });

    await page.goto(`/${seed.companyPrefix}/governance`);
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/governance/attention$`));
    const governanceSidebar = page.getByTestId("verrail-governance-sidebar");
    await expect(governanceSidebar).toBeVisible();
    await governanceSidebar.getByRole("link", { name: "Approvals", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/governance/approvals/pending$`));
    await governanceSidebar.getByRole("link", { name: "Activity", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/governance/audit$`));
    await governanceSidebar.getByRole("link", { name: "Costs", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/governance/costs$`));
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${testInfo.project.name}-governance.png`),
      fullPage: true,
    });

    await page.goto(`/${seed.companyPrefix}/settings`);
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/company/settings$`));
    await expect(page.getByTestId("verrail-infrastructure-sidebar")).toHaveCount(0);
    await expect(page.getByTestId("verrail-governance-sidebar")).toHaveCount(0);
    const settingsSidebar = page.getByTestId("company-settings-sidebar");
    await expect(settingsSidebar.getByText("General", { exact: true })).toBeVisible();
    await expect(settingsSidebar.getByText("Environments", { exact: true })).toHaveCount(0);
    await expect(settingsSidebar.getByText("Secrets", { exact: true })).toHaveCount(0);
    await expect(settingsSidebar.getByText("Adapters", { exact: true })).toHaveCount(0);
    await expect(settingsSidebar.getByText("Plugins", { exact: true })).toHaveCount(0);

    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  } finally {
    await page.close();
    await deleteWorkspace(request, seed.companyId);
  }
});

test("Conversation management and runtime feedback remain coherent and error-free", async ({ page, request }, testInfo) => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const seed = await seedWorkspace(request, `Conversation ${testInfo.project.name}`);
  const browserErrors = collectBrowserErrors(page);
  const prompt = "Confirm the deterministic acceptance response";
  const renamedTitle = `Acceptance conversation ${testInfo.project.name}`;

  try {
    await page.goto(`/${seed.companyPrefix}/chat`);
    const chatSidebar = page.getByTestId("verrail-chat-sidebar");
    await expect(chatSidebar).toBeVisible();

    await page.getByRole("textbox", { name: "Ask Verrail...", exact: true }).fill(prompt);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/chat/[0-9a-f-]+$`));
    await expect(page.getByText("Acceptance runtime response", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("main article").getByText(prompt, { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.getByText("Acceptance runtime response", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("main article").getByText(prompt, { exact: true })).toBeVisible();

    const conversationActions = chatSidebar.getByRole("button", { name: "Conversation actions", exact: true });
    await conversationActions.click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const renameDialog = page.getByRole("dialog");
    await renameDialog.getByRole("textbox").fill(renamedTitle);
    await renameDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(chatSidebar.getByText(renamedTitle, { exact: true })).toBeVisible();

    await conversationActions.click();
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(chatSidebar.getByRole("heading", { name: "Pinned", exact: true })).toBeVisible();

    await conversationActions.click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/chat$`));
    await chatSidebar.getByRole("button", { name: "Archived", exact: true }).click();
    await expect(chatSidebar.getByText(renamedTitle, { exact: true })).toBeVisible();

    await chatSidebar.getByRole("button", { name: "Conversation actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
    await expect(chatSidebar.getByText("No archived conversations.", { exact: true })).toBeVisible();
    await chatSidebar.getByRole("button", { name: "Active conversations", exact: true }).click();

    const search = chatSidebar.getByRole("textbox", { name: "Search conversations", exact: true });
    await search.fill("Acceptance conversation");
    await expect(chatSidebar.getByText(renamedTitle, { exact: true })).toBeVisible();
    await search.fill("No matching acceptance conversation");
    await expect(chatSidebar.getByText("No matching conversations.", { exact: true })).toBeVisible();
    await search.fill("");
    await chatSidebar.getByText(renamedTitle, { exact: true }).click();

    const composer = page.getByRole("textbox", { name: "Ask Verrail...", exact: true });
    await composer.fill("[acceptance-empty]");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("did not return a response", { timeout: 30_000 });
    await page.getByRole("button", { name: "Return to draft", exact: true }).click();

    await composer.fill("[acceptance-slow]");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const stopButton = page.getByRole("button", { name: "Stop response", exact: true });
    await expect(stopButton).toBeVisible();
    await stopButton.click();
    await expect(page.getByRole("alert")).toContainText("Response stopped", { timeout: 30_000 });

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${testInfo.project.name}-conversation.png`),
      fullPage: true,
    });
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  } finally {
    await page.close();
    await deleteWorkspace(request, seed.companyId);
  }
});
