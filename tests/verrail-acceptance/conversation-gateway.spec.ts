import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("gateway chat restores streaming output and cancels only on explicit action", async ({ page, request }, testInfo) => {
  const created = await request.post("/api/companies", { data: { name: "Gateway browser fixture" } });
  expect(created.ok()).toBe(true);
  const workspace = await created.json();
  try {
    expect((await request.patch(`/api/companies/${workspace.id}`, { data: { enableVerrailNavigation: true } })).ok()).toBe(true);
    const response = await request.post(`/api/workspaces/${workspace.id}/conversations`, { data: { contextBindings: [] } });
    expect(response.ok()).toBe(true);
    const conversation = await response.json();
    const message = await request.post(`/api/workspaces/${workspace.id}/conversations/${conversation.id}/messages`, { data: { body: "Check the bound target" } });
    expect(message.ok()).toBe(true);
    const invocation = { id: randomUUID(), workspaceId: workspace.id, conversationId: conversation.id, principalId: "fixture", sourceMessageId: randomUUID(), agentVersionId: randomUUID(), deploymentRevisionId: randomUUID(), status: "running", output: "Saved gateway response", lastEventCursor: 2, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null as string | null, errorCode: null };
    let cancellations = 0;
    const base = `/api/workspaces/${workspace.id}/conversations/${conversation.id}/invocations`;
    await page.route(`**/api/workspaces/${workspace.id}/conversation-runtime`, route => route.fulfill({ json: { mode: "execution_gateway" } }));
    await page.route(`**${base}`, route => route.fulfill({ json: [invocation] }));
    await page.route(`**${base}/${invocation.id}/events?*`, route => route.fulfill({ contentType: "text/event-stream", body: 'id: 3\nevent: chunk\ndata: {"text":" continues"}\n\n' }));
    await page.route(`**${base}/${invocation.id}/cancel`, route => {
      cancellations += 1;
      invocation.status = "cancel_requested";
      return route.fulfill({ json: invocation });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`/${workspace.issuePrefix}/chat/${conversation.id}`);
    await expect(page.getByText("Saved gateway response continues", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Saved gateway response continues", { exact: true })).toBeVisible();
    expect(cancellations).toBe(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`gateway-chat-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Stop response", exact: true }).click();
    await expect(page.getByText("Stopping execution...", { exact: true })).toBeVisible();
    expect(cancellations).toBe(1);
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeDisabled();
    invocation.status = "canceled";
    invocation.finishedAt = new Date().toISOString();
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    expect((await request.delete(`/api/companies/${workspace.id}`)).ok()).toBe(true);
  }
});
