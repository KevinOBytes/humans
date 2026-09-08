import { expect, test, type BrowserContext } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { identityCandidates, mergeDecisions, people } from "@/db/schema/people";
import type { CookieJar } from "../support/auth";
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

async function seedCandidate() {
  const owner = await fixture.createActor("owner");
  const first = await fixture.createPerson(owner, {
    displayName: "Alex Morgan",
  });
  const second = await fixture.createPerson(owner, {
    displayName: "Alexandra Morgan",
  });
  const firstPersonId = first.body?.data?.createPerson?.person?.id;
  const secondPersonId = second.body?.data?.createPerson?.person?.id;
  if (!firstPersonId || !secondPersonId) {
    throw new Error("Reconciliation E2E people were not created");
  }

  const candidateId = newId();
  await fixture.database.insert(identityCandidates).values({
    id: candidateId,
    workspaceId: owner.workspaceId,
    firstPersonId,
    secondPersonId,
    matchSignals: { normalizedName: true, sharedEmail: false },
    score: "0.870",
    state: "pending",
    createdBy: owner.userId,
    updatedBy: owner.userId,
  });

  return { candidateId, owner, firstPersonId, secondPersonId };
}

test.beforeAll(async () => fixture.reset());
test.afterAll(async () => fixture.close());

test("an owner can review an identity candidate from the browser", async ({
  browser,
}) => {
  await fixture.reset();
  const { candidateId, owner, firstPersonId, secondPersonId } =
    await seedCandidate();
  const context = await browser.newContext();
  await authenticate(context, owner.jar);
  const page = await context.newPage();

  await page.goto("/reconciliation");
  const candidate = page.getByRole("article");
  await expect(
    page.getByRole("heading", { name: "Reconciliation" }),
  ).toBeVisible();
  await expect(candidate).toContainText("Alex Morgan");
  await expect(candidate).toContainText("87% match");
  await expect(candidate).toContainText("normalizedName: yes");

  await candidate.getByLabel("Review decision").selectOption("ACCEPTED");
  await candidate
    .getByLabel(/Reason/)
    .fill("Confirmed as the same person from the reviewed source set.");
  await candidate.getByRole("button", { name: "Save review" }).click();
  await expect(candidate.getByText("accepted", { exact: true })).toBeVisible();

  await candidate.getByLabel("Merge winner").selectOption("first");
  await candidate
    .getByLabel("Merge reason")
    .fill("Confirmed duplicate identity after source review.");
  await candidate.getByLabel("Confirm merge").check();
  await candidate
    .getByRole("button", { name: "Merge selected people" })
    .click();
  await expect(candidate.getByText("Merge completed")).toBeVisible();

  await expect
    .poll(async () => {
      const rows = await fixture.database
        .select({
          id: people.id,
          status: people.status,
          mergedIntoPersonId: people.mergedIntoPersonId,
        })
        .from(people)
        .where(
          and(
            eq(people.workspaceId, owner.workspaceId),
            eq(people.id, secondPersonId),
          ),
        );
      return rows[0];
    })
    .toMatchObject({
      id: secondPersonId,
      status: "merged",
      mergedIntoPersonId: firstPersonId,
    });
  await expect
    .poll(async () => {
      const rows = await fixture.database
        .select({ id: mergeDecisions.id, reason: mergeDecisions.reason })
        .from(mergeDecisions)
        .where(eq(mergeDecisions.workspaceId, owner.workspaceId));
      return rows;
    })
    .toHaveLength(1);

  await candidate.getByRole("button", { name: "Undo merge" }).click();
  await expect(candidate.getByText("Merge undone")).toBeVisible();
  await expect
    .poll(async () => {
      const rows = await fixture.database
        .select({
          status: people.status,
          mergedIntoPersonId: people.mergedIntoPersonId,
        })
        .from(people)
        .where(
          and(
            eq(people.workspaceId, owner.workspaceId),
            eq(people.id, secondPersonId),
          ),
        );
      return rows[0];
    })
    .toEqual({ status: "active", mergedIntoPersonId: null });
  await expect
    .poll(async () => {
      const [row] = await fixture.database
        .select({ state: identityCandidates.state })
        .from(identityCandidates)
        .where(eq(identityCandidates.id, candidateId));
      return row?.state;
    })
    .toBe("accepted");

  await expect
    .poll(async () => {
      const [row] = await fixture.database
        .select({
          state: identityCandidates.state,
          reviewReason: identityCandidates.reviewReason,
        })
        .from(identityCandidates)
        .where(
          and(
            eq(identityCandidates.id, candidateId),
            eq(identityCandidates.workspaceId, owner.workspaceId),
          ),
        );
      return row;
    })
    .toEqual({
      state: "accepted",
      reviewReason:
        "Confirmed as the same person from the reviewed source set.",
    });

  await context.close();
});

test("a viewer can inspect but cannot change an identity candidate", async ({
  browser,
}) => {
  await fixture.reset();
  const { owner } = await seedCandidate();
  const viewer = await fixture.createWorkspaceMember(owner, "viewer");
  const context = await browser.newContext();
  await authenticate(context, viewer.jar);
  const page = await context.newPage();

  await page.goto("/reconciliation");
  await expect(
    page.getByText(
      "You can inspect candidate matches, but your workspace role cannot change their review state.",
    ),
  ).toBeVisible();
  const candidate = page.getByRole("article");
  await expect(
    candidate.getByRole("button", { name: "Save review" }),
  ).toBeDisabled();
  await expect(candidate.getByLabel("Review decision")).toBeDisabled();
  await expect(candidate.getByLabel(/Reason/)).toBeDisabled();

  await context.close();
});
