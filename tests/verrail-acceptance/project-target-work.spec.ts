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

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>, label: string): Promise<T> {
  expect(response.ok(), `${label} failed ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

async function seedAcceptanceJourney(request: APIRequestContext, label: string): Promise<Seed> {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", { data: { name: `B2.3 ${label}` } }),
    "create company",
  );
  await json(
    await request.patch(`/api/companies/${company.id}`, { data: { enableVerrailNavigation: true } }),
    "enable Verrail navigation",
  );
  const projectName = `Acceptance project ${label}`;
  const project = await json<{ id: string; urlKey: string }>(
    await request.post(`/api/companies/${company.id}/projects`, {
      data: { name: projectName, description: "Project to Target to Work acceptance", status: "in_progress" },
    }),
    "create project",
  );
  const issueTitle = `Legacy work ${label}`;
  const issue = await json<{ id: string }>(
    await request.post(`/api/companies/${company.id}/issues`, {
      data: { projectId: project.id, title: issueTitle, description: "Compatibility work item", status: "todo" },
    }),
    "create legacy work",
  );
  const projection = await json<{ targetId: string; title: string }>(
    await request.post(`/api/workspaces/${company.id}/target-projections`, {
      data: { sourceType: "issue", sourceId: issue.id, eligibilityReason: "operator_mapping" },
    }),
    "register Target projection",
  );

  return {
    companyId: company.id,
    companyPrefix: company.issuePrefix,
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
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const seed = await seedAcceptanceJourney(request, testInfo.project.name);
  const browserErrors = collectBrowserErrors(page);

  try {
    await page.goto(`/${seed.companyPrefix}/projects`);
    await expect(page.getByText(seed.projectName, { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByText(seed.projectName, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectRef}/overview$`));
    await expect(page.getByRole("heading", { name: seed.projectName })).toBeVisible();

    await page.getByRole("button", { name: "New Target", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "New Target" })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Close" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const targetsTab = page.getByRole("tab", { name: "Targets" });
    await targetsTab.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${seed.projectRef}/targets$`));
    await expect(targetsTab).toHaveAttribute("data-state", "active");
    await expect(page.getByText(seed.targetTitle, { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${testInfo.project.name}-project-targets.png`),
      fullPage: true,
    });

    await page.getByText(seed.targetTitle, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/targets/${seed.targetId}/overview$`));
    await expect(page.getByRole("heading", { name: seed.targetTitle })).toBeVisible();
    await expect(page.getByRole("link", { name: seed.projectName, exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Work", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/targets/${seed.targetId}/work$`));
    await expect(page.getByText("No eligible work items have been projected.")).toBeVisible();

    await page.getByRole("link", { name: seed.projectName, exact: true }).click();
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
    await expect(page.getByText(seed.issueTitle, { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${testInfo.project.name}-legacy-work.png`),
      fullPage: true,
    });

    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  } finally {
    await request.delete(`/api/companies/${seed.companyId}`).catch(() => undefined);
  }
});
