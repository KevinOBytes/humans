import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext } from "@playwright/test";
import { and, count, eq } from "drizzle-orm";

import { caseMembers, caseResourceLinks } from "@/db/schema/cases";
import {
  researchAssignmentEvents,
  researchAssignmentItems,
} from "@/db/schema/research-assignments";
import { ResearchAssignmentsDocument } from "@/graphql/generated/graphql";
import { createCasesService } from "@/modules/cases/service";
import { createResearchAssignmentsService } from "@/modules/research-assignments/service";

import type { CookieJar } from "../support/auth";
import { caseContext } from "../support/cases";
import { ResearchFixture } from "../support/research-fixture";

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

test("an owner manages a fictional case assignment queue without expanding case access", async ({
  browser,
  page,
}) => {
  const owner = await fixture.createActor("owner");
  const reviewer = await fixture.createWorkspaceMember(owner, "analyst");
  const ownerContext = await caseContext(fixture, owner);
  const cases = createCasesService(ownerContext);
  const assignments = createResearchAssignmentsService(ownerContext);
  const researchCase = await cases.createCase({
    title: "Fictional archive source review",
    purpose: "fictional_source_review",
  });
  await cases.addMember({
    caseId: researchCase.id,
    principalId: reviewer.principalId,
    role: "reviewer",
  });
  await assignments.create({
    caseId: researchCase.id,
    queueKind: "verification",
    title: "Seeded fictional verification",
    description: "Verify a fictional source before accepting any claim.",
    priority: 7,
    idempotencyKey: "browser-assignment-seeded-verification",
  });

  const [beforeLinks] = await fixture.database
    .select({ total: count() })
    .from(caseResourceLinks)
    .where(eq(caseResourceLinks.caseId, researchCase.id));

  await authenticate(page.context(), owner.jar);
  await page.goto("/cases");
  await expect(
    page.getByRole("heading", { name: "Case workspace" }),
  ).toBeVisible();

  const caseSelector = page.getByLabel("Research case");
  await caseSelector.selectOption(researchCase.id);
  const queue = page.getByRole("region", { name: "Research assignments" });
  await expect(queue).toBeVisible();
  await expect(
    queue.getByRole("heading", { name: "Seeded fictional verification" }),
  ).toBeVisible();
  await queue.locator("#assignment-status-filter").selectOption("OPEN");
  await queue.locator("#assignment-kind-filter").selectOption("VERIFICATION");
  await expect(
    queue.getByRole("heading", { name: "Seeded fictional verification" }),
  ).toBeVisible();
  await queue.locator("#assignment-status-filter").selectOption("");
  await queue.locator("#assignment-kind-filter").selectOption("");

  const title = "Browser fictional assignment lifecycle";
  await queue.locator("#assignment-title").fill(title);
  await queue
    .locator("#assignment-description")
    .fill("A disposable browser fixture validates case-scoped workflow.");
  await queue.locator("#assignment-kind").selectOption("REVIEW");
  await queue.locator("#assignment-priority").fill("42");
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/graphql") &&
      Boolean(
        response.request().postData()?.includes("CreateResearchAssignment"),
      ),
  );
  await queue.getByRole("button", { name: "Create assignment" }).click();
  const createResult = await (await createResponse).json();
  expect(createResult.errors).toBeUndefined();
  expect(createResult).toMatchObject({
    data: { createResearchAssignment: { assignment: { title } } },
  });

  const row = queue
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { level: 3, name: title }) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("OPEN");
  await expect(row).toContainText("Priority 42");

  await row
    .getByLabel(`Reason for ${title}`)
    .fill("Assign to the case reviewer.");
  await row
    .getByLabel("Assignee principal ID (clear to unassign)")
    .fill(reviewer.principalId);
  await row.getByRole("button", { name: "Save assignee" }).click();
  await expect(row).toContainText(`Current assignee: ${reviewer.principalId}`);

  await row
    .getByLabel(`Reason for ${title}`)
    .fill("Begin the fictional review.");
  await row.getByRole("button", { name: "Start" }).click();
  await expect(row).toContainText("IN PROGRESS");

  await row
    .getByLabel(`Reason for ${title}`)
    .fill("Escalate to a second fictional reviewer.");
  const escalate = row.getByRole("button", { name: "Escalate" });
  await escalate.focus();
  await expect(escalate).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row).toContainText("Escalations 1");

  const authorizedQueue = await fixture.execute({
    jar: owner.jar,
    query: ResearchAssignmentsDocument,
    variables: { caseId: researchCase.id, first: 25 },
  });
  expect(authorizedQueue.body?.errors).toBeUndefined();
  expect(authorizedQueue.body?.data).toMatchObject({
    researchAssignments: {
      nodes: expect.arrayContaining([
        expect.objectContaining({
          assigneePrincipalId: reviewer.principalId,
          escalationCount: 1,
          status: "IN_PROGRESS",
          title,
        }),
      ]),
    },
  });
  await expect
    .poll(async () => {
      const [item] = await fixture.database
        .select({
          assigneePrincipalId: researchAssignmentItems.assigneePrincipalId,
          escalationCount: researchAssignmentItems.escalationCount,
          id: researchAssignmentItems.id,
          status: researchAssignmentItems.status,
        })
        .from(researchAssignmentItems)
        .where(
          and(
            eq(researchAssignmentItems.workspaceId, owner.workspaceId),
            eq(researchAssignmentItems.caseId, researchCase.id),
            eq(researchAssignmentItems.title, title),
          ),
        );
      const events = item
        ? await fixture.database
            .select({
              eventKind: researchAssignmentEvents.eventKind,
              reason: researchAssignmentEvents.reason,
            })
            .from(researchAssignmentEvents)
            .where(eq(researchAssignmentEvents.assignmentId, item.id))
        : [];
      return { item, events };
    })
    .toMatchObject({
      item: {
        assigneePrincipalId: reviewer.principalId,
        escalationCount: 1,
        status: "in_progress",
      },
      events: expect.arrayContaining([
        expect.objectContaining({
          eventKind: "assigned",
          reason: "Assign to the case reviewer.",
        }),
        expect.objectContaining({
          eventKind: "status_changed",
          reason: "Begin the fictional review.",
        }),
        expect.objectContaining({
          eventKind: "escalated",
          reason: "Escalate to a second fictional reviewer.",
        }),
      ]),
    });
  const [afterLinks] = await fixture.database
    .select({ total: count() })
    .from(caseResourceLinks)
    .where(eq(caseResourceLinks.caseId, researchCase.id));
  expect(afterLinks?.total).toBe(beforeLinks?.total);

  await page.setViewportSize({ width: 390, height: 844 });
  const statusFilter = queue.locator("#assignment-status-filter");
  await statusFilter.focus();
  await expect(statusFilter).toBeFocused();
  expect(await statusFilter.evaluate((element) => element.tagName)).toBe(
    "SELECT",
  );
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-labelledby="assignment-queue-heading"]')
        .analyze()
    ).violations,
  ).toEqual([]);

  const viewer = await fixture.createWorkspaceMember(owner, "viewer");
  const viewerQueue = await fixture.execute({
    jar: viewer.jar,
    query: ResearchAssignmentsDocument,
    variables: { caseId: researchCase.id, first: 25 },
  });
  expect(viewerQueue.body?.data?.researchAssignments).toBeNull();
  expect(viewerQueue.body?.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  const viewerContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3106",
  });
  await authenticate(viewerContext, viewer.jar);
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto("/cases");
  await expect(viewerPage.getByLabel("Research case")).not.toContainText(
    researchCase.title,
  );
  await expect(
    viewerPage.getByRole("heading", { name: "Research assignments" }),
  ).toHaveCount(0);
  const memberships = await fixture.database
    .select({ caseId: caseMembers.caseId })
    .from(caseMembers)
    .where(
      and(
        eq(caseMembers.workspaceId, owner.workspaceId),
        eq(caseMembers.principalId, viewer.principalId),
      ),
    );
  expect(memberships).not.toContainEqual({ caseId: researchCase.id });
  await viewerContext.close();
});
