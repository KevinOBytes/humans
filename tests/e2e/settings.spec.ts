import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { apiKeys, invitations, members, users } from "@/db/schema/auth";
import { auditEvents } from "@/db/schema/operations";
import type { CookieJar } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();
let actor: Awaited<ReturnType<ResearchFixture["createActor"]>>;

async function authenticate(context: BrowserContext, jar: CookieJar) {
  await context.addCookies(
    jar
      .toString()
      .split(";")
      .flatMap((pair) => {
        const separator = pair.indexOf("=");
        return separator > 0
          ? [
              {
                name: pair.slice(0, separator).trim(),
                value: pair.slice(separator + 1).trim(),
                domain: "127.0.0.1",
                path: "/",
              },
            ]
          : [];
      }),
  );
}

function browserFailures(page: Page) {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    request.failure()?.errorText === "net::ERR_ABORTED" &&
    (request.url().includes("_rsc=") ||
      request.url().includes("/__nextjs_font/"))
      ? undefined
      : failures.push(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
        ),
  );
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(`response: ${response.status()} ${response.url()}`);
    }
  });
  return () => expect(failures, failures.join("\n")).toEqual([]);
}

test.beforeAll(async () => {
  await fixture.reset();
  actor = await fixture.createActor();
});

test.afterAll(async () => fixture.close());

test("read-only settings are responsive, accessible, and browser-secret safe", async ({
  browser,
  context,
  page,
}) => {
  const expectCleanBrowser = browserFailures(page);
  const nonLoopbackRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost"
    ) {
      nonLoopbackRequests.push(request.url());
    }
  });
  await authenticate(context, actor.jar);
  const browserUsers = Array.from({ length: 26 }, (_, index) => ({
    id: `browser-paged-user-${String(index).padStart(2, "0")}`,
    name: `Browser paged member ${String(index).padStart(2, "0")}`,
    email: `browser-paged-${String(index).padStart(2, "0")}@example.test`,
    emailVerified: true,
  }));
  await fixture.database.insert(users).values(browserUsers);
  await fixture.database.insert(members).values(
    browserUsers.map((user) => ({
      id: newId(),
      organizationId: actor.organizationId,
      userId: user.id,
      role: "viewer",
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      workspaceId: actor.workspaceId,
    })),
  );
  await fixture.database.insert(apiKeys).values(
    Array.from({ length: 26 }, (_, index) => ({
      id: `browser-paged-key-${String(index).padStart(2, "0")}`,
      configId: "organization",
      name: `Browser key ${String(index).padStart(2, "0")}`,
      start: String(index).padStart(6, "0"),
      prefix: "hum_",
      referenceId: actor.organizationId,
      key: `browser-stored-key-${String(index).padStart(2, "0")}`,
      enabled: true,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      permissions: JSON.stringify({ person: ["read"] }),
      workspaceId: actor.workspaceId,
    })),
  );
  const routes = [
    ["/settings/account", "Account"],
    ["/settings/security", "Security"],
    ["/settings/members", "Members"],
    ["/settings/api-keys", "API keys"],
    ["/settings/policies", "Policies"],
    ["/settings/audit", "Audit"],
    ["/settings/integrations", "Integrations"],
  ] as const;

  for (const [route, heading] of routes) {
    await page.goto(route);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).analyze()).violations,
      `axe violations on ${route}`,
    ).toEqual([]);
  }
  expect(nonLoopbackRequests).toEqual([]);

  await page.goto("/settings/members");
  await expect(
    page.getByRole("form", { name: "Invite workspace member" }),
  ).toBeVisible();
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-invite@example.test");
  await page.getByLabel("Role", { exact: true }).selectOption("VIEWER");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Workspace access was updated.")).toBeVisible();
  const [browserInvitation] = await fixture.database
    .select({ id: invitations.id, status: invitations.status })
    .from(invitations)
    .where(eq(invitations.email, "browser-invite@example.test"));
  expect(browserInvitation?.status).toBe("pending");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByText("browser-invite@example.test")
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect
    .poll(async () => {
      const [row] = await fixture.database
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, browserInvitation!.id));
      return row?.status;
    })
    .toBe("canceled");
  await page
    .getByRole("combobox", { name: "Role for Browser paged member 00" })
    .selectOption("CONTRIBUTOR");
  await expect
    .poll(async () => {
      const [row] = await fixture.database
        .select({ role: members.role })
        .from(members)
        .where(eq(members.userId, browserUsers[0]!.id));
      return row?.role;
    })
    .toBe("contributor");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.goto("/settings/api-keys");
  await page.getByRole("link", { name: "Next API keys" }).click();
  await expect(page.getByText(/Showing 26–26 of 26/u)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Previous API keys" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/account");
  const settingsNavigation = page.getByRole("navigation", { name: "Settings" });
  await expect(settingsNavigation).toBeVisible();
  await expect(settingsNavigation.getByRole("link")).toHaveCount(7);
  await expect(
    settingsNavigation.getByRole("link", { name: "Account" }),
  ).toHaveAttribute("aria-current", "page");

  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    (document.activeElement as HTMLElement | null)?.blur();
  });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await expect(
    page.getByRole("heading", { level: 1, name: "Account" }),
  ).toBeVisible();
  await expect(
    settingsNavigation.getByRole("link", { name: "Integrations" }),
  ).toBeVisible();
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });

  const rawAuditSecret = "settings-browser-raw-secret";
  await fixture.database.insert(auditEvents).values(
    Array.from({ length: 26 }, (_, index) => ({
      id: newId(),
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "settings.browser",
      resourceKind: "workspace",
      resourceId: newId(),
      requestId: `settings-browser-${String(index).padStart(2, "0")}`,
      redactedDiff: { raw: rawAuditSecret },
      outcome: "success",
      occurredAt: new Date(
        `2026-08-03T12:${String(index).padStart(2, "0")}:00.000Z`,
      ),
    })),
  );
  await page.goto(
    "/settings/audit?action=settings.browser&from=2026-08-03T12%3A00&until=2026-08-03T12%3A59",
  );
  await expect(page.getByRole("link", { name: "Next events" })).toBeVisible();
  await page.getByRole("link", { name: "Next events" }).click();
  await expect(page.getByText("settings-browser-00")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(rawAuditSecret);

  await page.goto("/settings/audit?from=2026-02-30T12%3A00");
  await expect(
    page.getByText("Enter a valid UTC date and time."),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "From (UTC)" })).toHaveValue(
    "2026-02-30T12:00",
  );

  const viewer = await fixture.createWorkspaceMember(actor, "viewer");
  const viewerContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3106",
  });
  await authenticate(viewerContext, viewer.jar);
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto("/settings/members");
  await expect(
    viewerPage.getByText("Workspace access is unavailable."),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page: viewerPage }).analyze()).violations,
  ).toEqual([]);
  await viewerContext.close();

  const key = await fixture.provisionKey(actor, { workspace: ["read"] });
  const keyContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3106",
    extraHTTPHeaders: { "x-api-key": key.key },
  });
  const keyPage = await keyContext.newPage();
  await keyPage.goto("/settings/policies");
  await expect(keyPage).toHaveURL(
    /\/sign-in\?returnTo=%2Fsettings%2Fpolicies/u,
  );
  expect(await keyPage.content()).not.toContain(key.key);
  await keyContext.close();

  const browserState = await page.evaluate(() => ({
    body: document.body.textContent,
    href: location.href,
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
  }));
  expect(JSON.stringify(browserState)).not.toMatch(
    /session_token|postgres(?:ql)?:\/\/|redis(?:s)?:\/\/|resend_api|storage_secret|raw-key/iu,
  );
  expectCleanBrowser();
});

test("authenticated users can keyboard-sign-out without retaining workspace access", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(browserName !== "chromium", "Chromium lifecycle evidence");
  const signingOutActor = await fixture.createActor();
  await authenticate(context, signingOutActor.jar);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/security");

  const signOut = page.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible();
  await signOut.focus();
  await expect(signOut).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sign-in\?signedOut=true$/u);

  await page.goto("/settings/security");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/u);
  await expect(page.locator("body")).not.toContainText(
    signingOutActor.workspaceId,
  );
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
