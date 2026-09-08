import { expect, test } from "@playwright/test";

import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();
const adminEmail = "admin@example.test";
const adminUsername = "humans-admin";
const adminPassword = "Task6InitialAdministratorPassword!2026";

async function signIn(
  page: import("@playwright/test").Page,
  identifier: string,
) {
  await page.goto("/sign-in?returnTo=%2Fdashboard");
  await page.getByLabel("Email or username").fill(identifier);
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
}

test.beforeAll(async () => fixture.reset());
test.afterAll(async () => fixture.close());

test("configured administrator can sign in by email and username after bootstrap", async ({
  page,
}) => {
  await signIn(page, adminEmail);
  await expect(
    page.getByRole("heading", { name: /research workspace|dashboard/iu }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in\?signedOut=true$/u);

  await signIn(page, adminUsername);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});
