import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  PersonEventsDocument,
  PersonEventSummaryFragmentDoc,
  PersonNamesDocument,
  PersonNameSummaryFragmentDoc,
  type PersonEventsQuery,
  type PersonNamesQuery,
} from "@/graphql/generated/graphql";
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

async function expectAccessibleReflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    "record content must not cause horizontal page overflow",
  ).toBe(true);
  const scan = await new AxeBuilder({ page }).analyze();
  expect(
    scan.violations,
    scan.violations.map((item) => `${item.id}: ${item.help}`).join("\n"),
  ).toEqual([]);
}

test.beforeAll(async () => fixture.reset());
test.afterAll(async () => fixture.close());

test("fictional profile names and events persist through keyboard editing and archive without granting workspace access", async ({
  page,
  browser,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const owner = await fixture.createActor();
  const viewer = await fixture.createWorkspaceMember(owner, "viewer");
  const outsider = await fixture.createActor();
  const result = await fixture.createPerson(owner, {
    displayName: "Fictional Morgan Archive",
    biography: "Synthetic consent-based browser acceptance record.",
  });
  const personId = result.body?.data?.createPerson?.person?.id;
  if (!personId) throw new Error("Fictional profile was not created");
  await authenticate(page.context(), owner.jar);
  await page.goto(`/people/${personId}?view=names`);
  await expect(
    page.getByRole("heading", { name: "Fictional Morgan Archive" }),
  ).toBeVisible();
  await expectAccessibleReflow(page);

  const longAlias = `FictionalAlias${"x".repeat(100)}`;
  await page.getByLabel("Full name", { exact: true }).fill(longAlias);
  await page.getByLabel("Kind", { exact: true }).selectOption("ALIAS");
  await page.getByRole("button", { name: "Save name", exact: true }).focus();
  await page.keyboard.press("Enter");
  const names = page.getByRole("region", { name: "Names", exact: true });
  await expect(
    names.getByRole("heading", { name: longAlias, exact: true }),
  ).toBeVisible();
  await page.getByLabel("Full name", { exact: true }).fill("Morgan Former");
  await page.getByLabel("Kind", { exact: true }).selectOption("FORMER");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(names.getByRole("listitem")).toHaveCount(2);

  const eventTitle = `FictionalEducation${"y".repeat(100)}`;
  await page.getByLabel("Event kind", { exact: true }).fill("education");
  await page.getByLabel("Title", { exact: true }).fill(eventTitle);
  await page.getByLabel("Starts", { exact: true }).fill("2020-01-02T10:30");
  await page.getByLabel("Ends", { exact: true }).fill("2024-05-03T12:00");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Fictional archive studies.");
  await page.getByRole("button", { name: "Save event", exact: true }).click();
  const timeline = page.getByRole("region", { name: "Timeline", exact: true });
  await expect(
    timeline.getByRole("heading", { name: eventTitle, exact: true }),
  ).toBeVisible();
  await expect(timeline).toContainText("Jan 2, 2020");
  await expect(timeline).toContainText("May 3, 2024");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectAccessibleReflow(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    document.documentElement.style.zoom = "2";
  });
  await expectAccessibleReflow(page);

  const nameRow = names.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: longAlias, exact: true }),
  });
  const editName = nameRow.getByRole("button", {
    name: `Edit ${longAlias}`,
    exact: true,
  });
  await editName.focus();
  await expect(editName).toBeFocused();
  await page.keyboard.press("Enter");
  await names
    .getByLabel("Full name", { exact: true })
    .fill("Morgan Reviewed Alias");
  await expectAccessibleReflow(page);
  await names.getByRole("button", { name: "Save name", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    names.getByRole("heading", { name: "Morgan Reviewed Alias", exact: true }),
  ).toBeVisible();
  const eventRow = timeline.getByRole("listitem");
  await eventRow
    .getByRole("button", { name: `Edit ${eventTitle}`, exact: true })
    .click();
  await eventRow
    .getByLabel("Title", { exact: true })
    .fill("Reviewed fictional education");
  await eventRow
    .getByLabel("Description", { exact: true })
    .fill("Reviewed fictional archive studies.");
  await expectAccessibleReflow(page);
  await eventRow
    .getByRole("button", { name: "Save event", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    timeline.getByRole("heading", {
      name: "Reviewed fictional education",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dir = "ltr";
    document.documentElement.style.zoom = "";
  });
  await page.reload();
  await expect(
    names.getByRole("heading", { name: "Morgan Reviewed Alias", exact: true }),
  ).toBeVisible();
  await expect(timeline).toContainText("Reviewed fictional archive studies.");

  const nameResult = await fixture.execute<PersonNamesQuery>({
    jar: owner.jar,
    query: PersonNamesDocument,
    variables: { id: personId, first: 5 },
  });
  expect(nameResult.body?.errors).toBeUndefined();
  expect(
    nameResult.body?.data?.person?.names?.nodes?.map((node) =>
      readFragment(PersonNameSummaryFragmentDoc, node),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        fullName: "Morgan Reviewed Alias",
        kind: "ALIAS",
        version: 2,
      }),
      expect.objectContaining({ fullName: "Morgan Former", kind: "FORMER" }),
    ]),
  );
  const eventResult = await fixture.execute<PersonEventsQuery>({
    jar: owner.jar,
    query: PersonEventsDocument,
    variables: { id: personId, first: 5 },
  });
  expect(eventResult.body?.errors).toBeUndefined();
  expect(
    eventResult.body?.data?.person?.events?.nodes?.map((node) =>
      readFragment(PersonEventSummaryFragmentDoc, node),
    ),
  ).toEqual([
    expect.objectContaining({
      title: "Reviewed fictional education",
      description: "Reviewed fictional archive studies.",
      version: 2,
    }),
  ]);

  const viewerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  try {
    await authenticate(viewerContext, viewer.jar);
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(`/people/${personId}?view=names`);
    await expect(
      viewerPage.getByRole("heading", {
        name: "Morgan Reviewed Alias",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      viewerPage.getByRole("button", {
        name: /^(Save name|Save event|Edit Morgan|Archive Morgan|Edit Reviewed|Archive Reviewed)/,
      }),
    ).toHaveCount(0);
    await authenticate(outsiderContext, outsider.jar);
    const outsiderPage = await outsiderContext.newPage();
    const denied = await outsiderPage.goto(`/people/${personId}?view=names`);
    // Streamed Next.js not-found responses may have HTTP 200; verify the
    // authorization result and serialized payload, not its streaming status.
    await expect(
      outsiderPage.getByRole("heading", {
        name: "Person not found",
        exact: true,
      }),
    ).toBeVisible();
    const deniedPayload = await denied?.text();
    expect(deniedPayload).toBeDefined();
    expect(deniedPayload).not.toContain("Morgan Reviewed Alias");
    expect(deniedPayload).not.toContain("Reviewed fictional archive studies.");
    await expect(
      outsiderPage.getByText("Morgan Reviewed Alias", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await viewerContext.close();
    await outsiderContext.close();
  }

  await names
    .getByRole("button", { name: "Archive Morgan Reviewed Alias", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    names.getByRole("heading", { name: "Morgan Reviewed Alias", exact: true }),
  ).toHaveCount(0);
  await timeline
    .getByRole("button", {
      name: "Archive Reviewed fictional education",
      exact: true,
    })
    .click();
  await expect(
    timeline.getByText("No visible timeline events have been recorded.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    names.getByRole("heading", { name: "Morgan Former", exact: true }),
  ).toBeVisible();
  await expect(names.getByRole("listitem")).toHaveCount(1);
  await expect(timeline.getByRole("listitem")).toHaveCount(0);
  expect(failures).toEqual([]);
});
