import { expect, test } from "@playwright/test";

import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();
const adminEmail = "admin@example.test";
const adminUsername = "humans-admin";
const adminPassword = [
  "Task6",
  "Initial",
  "Administrator",
  "Password!",
  "2026",
].join("");

async function signIn(
  page: import("@playwright/test").Page,
  identifier: string,
) {
  await page.goto("/sign-in?returnTo=%2Fdashboard");
  await page.getByLabel("Email or username").fill(identifier);
  await page.getByLabel("Password").fill(adminPassword);
  const authResponse = page.waitForResponse((response) =>
    /\/api\/auth\/sign-in\/(email|username)$/u.test(response.url()),
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  const response = await authResponse;
  const responseBody = await response.text();
  expect(
    response.ok(),
    `configured administrator sign-in failed (${response.status()}): ${responseBody}`,
  ).toBe(true);
  expect(
    responseBody,
    `configured administrator sign-in returned an error: ${responseBody}`,
  ).not.toContain('"error"');
  await expect(page).toHaveURL(/\/dashboard$/u);
}

async function activateOrCreateWorkspace(
  page: import("@playwright/test").Page,
  name: string,
  slug: string,
) {
  const gate = page.getByRole("heading", { name: "Choose a workspace" });
  if (!(await gate.isVisible())) return;

  const available = page.getByRole("heading", {
    name: "Available workspaces",
  });
  if (await available.isVisible()) {
    await page.locator("ul button").first().click();
  } else {
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Slug").fill(slug);
    await page.getByRole("button", { name: "Create a workspace" }).click();
  }
  await expect(page).toHaveURL(/\/dashboard$/u);
}

test.beforeAll(async () => fixture.reset());
test.afterAll(async () => fixture.close());

test("configured administrator can sign in by email and username after bootstrap", async ({
  page,
}) => {
  await signIn(page, adminEmail);
  await activateOrCreateWorkspace(
    page,
    "Administrator Research",
    "admin-research",
  );
  await expect(
    page.getByRole("heading", { name: "Research dashboard" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in\?signedOut=true$/u);

  await signIn(page, adminUsername);
  await activateOrCreateWorkspace(
    page,
    "Administrator Research",
    "admin-research",
  );
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});
