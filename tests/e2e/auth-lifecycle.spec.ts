import { createHmac } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { invitations, sessions, users } from "@/db/schema/auth";
import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();
const password = "Task7GraphQLFixturePassword!2026";
const email = "auth-browser@example.test";
const fakeResendUrl = "http://127.0.0.1:3107";
const disabledBaseUrl = "http://127.0.0.1:3108";
const inviteBaseUrl = "http://127.0.0.1:3109";

type CapturedMessage = {
  html?: string;
  subject: string;
  text?: string;
  to: string[];
};

async function capturedMessages(): Promise<CapturedMessage[]> {
  return (await (
    await fetch(`${fakeResendUrl}/messages`)
  ).json()) as CapturedMessage[];
}

function capturedUrl(message: CapturedMessage): string {
  const match = `${message.text ?? ""}\n${message.html ?? ""}`.match(
    /https?:\/\/[^\s<>"]+/u,
  );
  if (!match) throw new Error("Expected captured action URL");
  return match[0].replaceAll("&amp;", "&");
}

function decodeBase32(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.toUpperCase().replaceAll("=", "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid browser TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function currentTotp(secret: string): string {
  const counter = BigInt(Math.floor(Date.now() / 30_000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) >>>
    0;
  return (binary % 1_000_000).toString().padStart(6, "0");
}

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/sign-in?returnTo=%2Fdashboard");
  await page.getByLabel(/email or username/iu).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function activateWorkspaceIfNeeded(
  page: import("@playwright/test").Page,
) {
  if (
    await page.getByRole("heading", { name: "Choose a workspace" }).isVisible()
  ) {
    await page.locator("ul button").first().click();
  }
  await expect(page).toHaveURL(/\/dashboard$/u);
}

async function enroll(page: import("@playwright/test").Page) {
  const initialResponse = await page.goto("/two-factor/enroll");
  expect(await initialResponse?.text()).not.toMatch(
    /otpauth:|backup.?code.{0,20}[a-z0-9]{8}/iu,
  );
  await page.getByLabel("Current password").fill(password);
  await page.getByRole("button", { name: "Begin secure setup" }).click();
  const secret = (await page.locator("code").first().textContent())?.trim();
  expect(secret).toBeTruthy();
  const backupCodes = await page
    .getByRole("region", { name: "One-time backup codes" })
    .locator("li")
    .allTextContents();
  expect(backupCodes).toHaveLength(10);
  await page.getByLabel("Authentication code").fill(currentTotp(secret!));
  await page.getByRole("button", { name: "Verify and enable" }).click();
  await expect(page.locator("body")).not.toContainText(secret!);
  await expect(page.getByAltText("Authenticator QR code")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "One-time backup codes" }),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "I saved my codes — finish" }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  expect(page.url()).not.toContain(secret!);
  const browserStorage = JSON.stringify(
    await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    })),
  );
  expect(browserStorage).not.toContain(secret!);
  for (const code of backupCodes) expect(browserStorage).not.toContain(code);
  return { backupCodes, secret: secret! };
}

test.beforeAll(async () => {
  await fixture.reset();
});

test.afterAll(async () => fixture.close());

async function completeSignUpForm(
  page: import("@playwright/test").Page,
  baseUrl: string,
  account: { email: string; username: string },
) {
  await page.goto(`${baseUrl}/sign-up`);
  await page.getByLabel("Display name").fill("Policy Browser");
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

test("disabled and invite-only registration policies hold in a real browser", async ({
  page,
}) => {
  await fetch(`${fakeResendUrl}/messages`, { method: "DELETE" });
  const suffix = Date.now();
  const disabledEmail = `disabled-browser-${suffix}@example.test`;
  await completeSignUpForm(page, disabledBaseUrl, {
    email: disabledEmail,
    username: `DisabledBrowser${suffix}`,
  });
  await expect(
    page.getByText("We couldn't create the account", { exact: false }),
  ).toBeVisible();
  expect(await capturedMessages()).toEqual([]);
  expect(
    await fixture.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, disabledEmail)),
  ).toEqual([]);

  const owner = await fixture.createSessionActor({
    email: `invite-owner-${suffix}@example.test`,
    username: `InviteOwner${suffix}`,
  });
  const invitedEmail = `invited-browser-${suffix}@example.test`;
  await fixture.database.insert(invitations).values({
    id: `browser-invitation-${suffix}`,
    organizationId: owner.organizationId,
    email: invitedEmail,
    role: "viewer",
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    inviterId: owner.userId,
  });
  const missingEmail = `missing-browser-${suffix}@example.test`;
  await completeSignUpForm(page, inviteBaseUrl, {
    email: missingEmail,
    username: `MissingBrowser${suffix}`,
  });
  await expect(
    page.getByText("We couldn't create the account", { exact: false }),
  ).toBeVisible();
  expect(await capturedMessages()).toEqual([]);
  expect(
    await fixture.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, missingEmail)),
  ).toEqual([]);

  await completeSignUpForm(page, inviteBaseUrl, {
    email: invitedEmail,
    username: `InvitedBrowser${suffix}`,
  });
  await expect(page.getByRole("status")).toContainText("Check your email");
  await expect.poll(async () => (await capturedMessages()).length).toBe(1);
  const verification = (await capturedMessages())[0]!;
  expect(verification.to).toContain(invitedEmail);
  expect(capturedUrl(verification)).toContain(inviteBaseUrl);
  expect(JSON.stringify(verification)).not.toContain(password);
  expect(
    await fixture.database
      .select({ verified: users.emailVerified })
      .from(users)
      .where(eq(users.email, invitedEmail)),
  ).toEqual([{ verified: false }]);
  expect(
    await fixture.database
      .select({ status: invitations.status })
      .from(invitations)
      .where(eq(invitations.email, invitedEmail)),
  ).toEqual([{ status: "pending" }]);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("TOTP, backup-code rotation, replay rejection, disablement, and re-enrollment are browser-safe", async ({
  context,
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverComponentBodies: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", async (response) => {
    if (response.headers()["content-type"]?.includes("text/x-component")) {
      try {
        serverComponentBodies.push(await response.text());
      } catch {
        // A navigation may abort a development-only component response.
      }
    }
  });
  const actor = await fixture.createSessionActor({
    email,
    username: "AuthBrowserUser",
  });
  await context.addCookies(
    actor.jar
      .toString()
      .split(";")
      .map((pair) => {
        const [name, ...value] = pair.trim().split("=");
        return {
          name: name!,
          value: value.join("="),
          domain: "127.0.0.1",
          path: "/",
        };
      }),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  const first = await enroll(page);
  await expect(page.locator("body")).not.toContainText(first.secret);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in\?signedOut=true$/u);
  await signIn(page);
  await expect(page).toHaveURL(/\/two-factor/u);
  await page.getByRole("button", { name: "Backup code" }).click();
  await page.getByLabel("Backup code").fill(first.backupCodes[0]!);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await activateWorkspaceIfNeeded(page);

  await page.goto("/two-factor/enroll");
  await page.getByLabel("Current password").fill(password);
  await page.getByRole("button", { name: "Generate new backup codes" }).click();
  const replacementRegion = page.getByRole("region", {
    name: "One-time backup codes",
  });
  await expect(replacementRegion).toBeVisible();
  const replacements = await replacementRegion.locator("li").allTextContents();
  expect(replacements).toHaveLength(10);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page).toHaveURL(/\/settings\/security$/u);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in\?signedOut=true$/u);
  await signIn(page);
  await page.getByRole("button", { name: "Backup code" }).click();
  await page.getByLabel("Backup code").fill(first.backupCodes[1]!);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page.getByText("We couldn't verify that code.")).toBeVisible();
  await page.getByLabel("Backup code").fill(replacements[0]!);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await activateWorkspaceIfNeeded(page);

  await page.goto("/two-factor/enroll");
  await page.getByLabel("Current password").fill(password);
  await page
    .getByRole("button", { name: "Disable two-step verification" })
    .click();
  await expect(page).toHaveURL(/\/sign-in\?securityChanged=true$/u);
  await signIn(page);
  await activateWorkspaceIfNeeded(page);

  await page.goto("/two-factor/enroll");
  await page.getByLabel("Current password").fill(password);
  await page.getByRole("button", { name: "Begin secure setup" }).click();
  const cancelledSecret = (await page
    .locator("code")
    .first()
    .textContent())!.trim();
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(page).toHaveURL(/\/settings\/security$/u);
  await expect(page.locator("body")).not.toContainText(cancelledSecret);
  expect(page.url()).not.toContain(cancelledSecret);

  const second = await enroll(page);
  expect(second.secret).not.toBe(first.secret);
  await expect(page.locator("body")).not.toContainText(second.secret);
  const protectedValues = [
    first.secret,
    cancelledSecret,
    second.secret,
    ...first.backupCodes,
    ...replacements,
    ...second.backupCodes,
  ];
  const closedBrowserState = JSON.stringify(
    await page.evaluate(() => ({
      body: document.body.textContent,
      href: location.href,
      local: { ...localStorage },
      session: { ...sessionStorage },
    })),
  );
  for (const value of protectedValues) {
    expect(closedBrowserState).not.toContain(value);
    expect(serverComponentBodies.join("\n")).not.toContain(value);
  }
  expect(
    consoleErrors.filter(
      (message) =>
        message !==
        "Failed to load resource: the server responded with a status of 401 (UNAUTHORIZED)",
    ),
  ).toEqual([]);
  for (const value of protectedValues) {
    expect(consoleErrors.join("\n")).not.toContain(value);
    expect(pageErrors.join("\n")).not.toContain(value);
  }
  expect(pageErrors).toEqual([]);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("real registration, recovery, reset, and revoked-session states stay generic and recoverable", async ({
  browser,
  context,
  page,
}) => {
  await fetch(`${fakeResendUrl}/messages`, { method: "DELETE" });
  const registrationEmail = `policy-browser-${Date.now()}@example.test`;
  await page.goto("/sign-up");
  await page.getByLabel("Display name").fill("Policy Browser");
  await page.getByLabel("Email address").fill(registrationEmail);
  await page.getByLabel("Username").fill(`PolicyBrowser${Date.now()}`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await expect.poll(async () => (await capturedMessages()).length).toBe(1);
  const verification = (await capturedMessages()).find(
    ({ subject, to }) =>
      /verify/iu.test(subject) && to.includes(registrationEmail),
  )!;
  expect(JSON.stringify(verification)).not.toContain(password);
  await page.goto(capturedUrl(verification));
  await expect
    .poll(async () => {
      const [registered] = await fixture.database
        .select({ verified: users.emailVerified })
        .from(users)
        .where(eq(users.email, registrationEmail));
      return registered?.verified;
    })
    .toBe(true);
  await page.goto("/sign-in");
  await page.getByLabel(/email or username/iu).fill(registrationEmail);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/u);

  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  await secondPage.goto("/sign-in");
  await secondPage.getByLabel(/email or username/iu).fill(registrationEmail);
  await secondPage.getByLabel("Password").fill(password);
  await secondPage.getByRole("button", { name: "Sign in" }).click();
  await expect(secondPage).toHaveURL(/\/$/u);
  const [registeredUser] = await fixture.database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, registrationEmail));
  expect(
    await fixture.database
      .select()
      .from(sessions)
      .where(eq(sessions.userId, registeredUser!.id)),
  ).toHaveLength(2);

  await page.goto("/forgot-password");
  await page.getByLabel("Email address").fill(registrationEmail);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If an account matches that address",
  );
  await expect.poll(async () => (await capturedMessages()).length).toBe(2);
  const resetMessage = (await capturedMessages()).find(({ subject }) =>
    /reset/iu.test(subject),
  )!;
  const resetUrl = capturedUrl(resetMessage);
  const resetToken =
    new URL(resetUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
  expect(resetToken).toBeTruthy();

  await page.goto(resetUrl);
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain(resetToken);
  expect(await page.content()).not.toContain(resetToken);
  const newPassword = "Browser reset password! 2026 changed";
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("status")).toContainText(
    /password has been updated/iu,
  );
  expect(
    await fixture.database
      .select()
      .from(sessions)
      .where(eq(sessions.userId, registeredUser!.id)),
  ).toHaveLength(0);
  await secondPage.goto("/dashboard");
  await expect(secondPage).toHaveURL(/\/sign-in\?returnTo=/u);
  await secondContext.close();

  await page.goto(`/reset-password?token=${resetToken}`);
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain(resetToken);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(
    page.getByText("This reset link is invalid or has expired.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(page.url()).not.toContain(resetToken);

  await fetch(`${fakeResendUrl}/messages`, { method: "DELETE" });
  await page.goto("/forgot-password");
  await page.getByLabel("Email address").fill("unknown@example.test");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If an account matches that address",
  );
  expect(await capturedMessages()).toEqual([]);

  const revoked = await fixture.createSessionActor({
    email: "revoked-browser@example.test",
    username: "RevokedBrowser",
  });
  await context.addCookies(
    revoked.jar
      .toString()
      .split(";")
      .map((pair) => {
        const [name, ...value] = pair.trim().split("=");
        return {
          name: name!,
          value: value.join("="),
          domain: "127.0.0.1",
          path: "/",
        };
      }),
  );
  await fixture.database
    .delete(sessions)
    .where(eq(sessions.userId, revoked.userId));
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/u);
  await expect(page.locator("body")).not.toContainText(revoked.workspaceId);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});
