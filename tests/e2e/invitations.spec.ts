import { expect, test, type BrowserContext } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { invitations, members } from "@/db/schema/auth";
import { ResearchFixture } from "../support/research-fixture";
import type { CookieJar } from "../support/auth";

const fixture = new ResearchFixture();

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

test.beforeAll(async () => fixture.reset());
test.afterAll(async () => fixture.close());

test("a verified recipient can hand off and accept a workspace invitation", async ({
  browser,
}) => {
  const owner = await fixture.createActor("owner");
  const recipientEmail = `invitation-recipient-${newId()}@example.test`;
  const recipient = await fixture.createSessionActor({
    email: recipientEmail,
    username: `InvitationRecipient_${newId().replaceAll("-", "")}`,
  });
  const invitationId = newId();
  await fixture.database.insert(invitations).values({
    id: invitationId,
    organizationId: owner.organizationId,
    email: recipientEmail,
    role: "analyst",
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    inviterId: owner.userId,
  });

  const context = await browser.newContext();
  await authenticate(context, recipient.jar);
  const page = await context.newPage();
  await page.goto(`/accept-invitation#id=${invitationId}`);

  await expect(
    page.getByRole("heading", { name: "Review your invitation" }),
  ).toBeVisible();
  await expect(page.getByText("analyst", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept invitation" }),
  ).toBeEnabled();
  expect(page.url()).not.toContain(invitationId);

  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(
    page.getByRole("heading", { name: "You joined the workspace" }),
  ).toBeVisible();
  await expect(page.getByText("Membership created.")).toBeVisible();
  expect(page.url()).not.toContain(invitationId);

  await expect
    .poll(async () => {
      const [invitation] = await fixture.database
        .select({ status: invitations.status })
        .from(invitations)
        .where(eq(invitations.id, invitationId));
      const [membership] = await fixture.database
        .select({ role: members.role, organizationId: members.organizationId })
        .from(members)
        .where(
          and(
            eq(members.userId, recipient.userId),
            eq(members.organizationId, owner.organizationId),
          ),
        );
      return { invitation: invitation?.status, membership };
    })
    .toEqual({
      invitation: "accepted",
      membership: { role: "analyst", organizationId: owner.organizationId },
    });

  await context.close();
});

test("a verified recipient can accept an administrator invitation", async ({
  browser,
}) => {
  const owner = await fixture.createActor("owner");
  const recipientEmail = `invitation-admin-${newId()}@example.test`;
  const recipient = await fixture.createSessionActor({
    email: recipientEmail,
    username: `InvitationAdmin_${newId().replaceAll("-", "")}`,
  });
  const invitationId = newId();
  await fixture.database.insert(invitations).values({
    id: invitationId,
    organizationId: owner.organizationId,
    email: recipientEmail,
    role: "admin",
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    inviterId: owner.userId,
  });

  const context = await browser.newContext();
  await authenticate(context, recipient.jar);
  const page = await context.newPage();
  await page.goto(`/accept-invitation#id=${invitationId}`);

  await expect(
    page.getByRole("heading", { name: "Review your invitation" }),
  ).toBeVisible();
  await expect(page.getByText("admin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(
    page.getByRole("heading", { name: "You joined the workspace" }),
  ).toBeVisible();

  await expect
    .poll(async () => {
      const [membership] = await fixture.database
        .select({ role: members.role, organizationId: members.organizationId })
        .from(members)
        .where(
          and(
            eq(members.userId, recipient.userId),
            eq(members.organizationId, owner.organizationId),
          ),
        );
      return membership;
    })
    .toEqual({ role: "admin", organizationId: owner.organizationId });

  await context.close();
});

test("expired invitations can be re-issued from member administration", async ({
  browser,
}) => {
  const owner = await fixture.createActor("owner");
  const email = `expired-reinvite-${newId()}@example.test`;
  const expiredId = newId();
  await fixture.database.insert(invitations).values({
    id: expiredId,
    organizationId: owner.organizationId,
    email,
    role: "viewer",
    status: "pending",
    expiresAt: new Date(Date.now() - 60_000),
    inviterId: owner.userId,
  });

  const context = await browser.newContext();
  await authenticate(context, owner.jar);
  const page = await context.newPage();
  await page.goto("/settings/members");

  const row = page
    .getByText(email, { exact: true })
    .locator("..")
    .locator("..");
  await expect(row.getByText(/viewer · expired/)).toBeVisible();
  await expect(row.getByRole("button", { name: "Re-invite" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Cancel" })).toBeDisabled();

  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Re-invite" }).click();
  await expect(page.getByText("Workspace access was updated.")).toBeVisible();

  await expect
    .poll(async () => {
      const rows = await fixture.database
        .select({ id: invitations.id, status: invitations.status })
        .from(invitations)
        .where(
          and(
            eq(invitations.organizationId, owner.organizationId),
            eq(invitations.email, email),
          ),
        );
      return {
        expiredStatus: rows.find((row) => row.id === expiredId)?.status,
        pendingCount: rows.filter(
          (row) => row.id !== expiredId && row.status === "pending",
        ).length,
        total: rows.length,
      };
    })
    .toEqual({ expiredStatus: "canceled", pendingCount: 1, total: 2 });

  await context.close();
});
