import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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
    await page.goto(`/${seed.companyPrefix}/chat`);
    await page.getByRole("button", { name: "New Target", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Target name").fill("Governed native delivery");
    await dialog.getByLabel("Goal").fill("Deliver one reviewable native result.");
    await dialog.getByRole("textbox", { name: "Criterion 1", exact: true }).fill("A reviewer can inspect the result");
    await dialog.getByRole("button", { name: "Review draft", exact: true }).click();

    await expect(dialog.getByRole("button", { name: "Confirm Target", exact: true })).toBeVisible();
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
    await page.goto(`/${seed.companyPrefix}/chat`);
    await page.getByRole("textbox", { name: "Ask Verrail...", exact: true }).fill("Summarize the delivery context");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${seed.companyPrefix}/chat/[0-9a-f-]+$`));
    await expect(page.getByText("Acceptance runtime response", { exact: true })).toBeVisible();
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
