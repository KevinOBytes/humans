import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import { members } from "@/db/schema/auth";
import { newId } from "@/db/id";
import { personEvents, personNames } from "@/db/schema/people";
import { workspaces } from "@/db/schema/workspaces";
import {
  ensureUserPrincipal,
  provisionWorkspace,
} from "@/modules/auth/workspaces";
import { ResearchFixture } from "../support/research-fixture";
import type { CookieJar } from "../support/auth";
import type { SessionActor } from "../support/graphql";

const CREATE_FACT_DEFINITION = /* GraphQL */ `
  mutation CreateFactDefinition($input: CreateFactDefinitionInput!) {
    createFactDefinition(input: $input) {
      factDefinition {
        id
      }
      code
    }
  }
`;

const CREATE_RELATIONSHIP_TYPE = /* GraphQL */ `
  mutation CreateRelationshipType($input: CreateRelationshipTypeInput!) {
    createRelationshipType(input: $input) {
      relationshipType {
        id
      }
      code
    }
  }
`;

const CREATE_FACT = /* GraphQL */ `
  mutation CreateFact($input: CreateFactInput!) {
    createFact(input: $input) {
      fact {
        id
        version
      }
      code
    }
  }
`;

const REVISE_FACT = /* GraphQL */ `
  mutation ReviseFact($input: ReviseFactInput!) {
    reviseFact(input: $input) {
      fact {
        id
        version
      }
      code
    }
  }
`;

const PERSON_SELECTIONS = /* GraphQL */ `
  query PersonSelections($id: UUID!) {
    person(id: $id) {
      fieldSelections(first: 10) {
        nodes {
          factId
        }
      }
    }
  }
`;

const fixture = new ResearchFixture();

async function authenticate(context: BrowserContext, jar: CookieJar) {
  const cookies = jar
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
    });
  await context.addCookies(cookies);
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations,
    results.violations
      .map((violation) => `${violation.id}: ${violation.help}`)
      .join("\n"),
  ).toEqual([]);
}

function captureBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("eval() is not supported in this environment")
    ) {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  return () => expect(failures, failures.join("\n")).toEqual([]);
}

test.beforeAll(async () => {
  await fixture.reset();
});

test.afterAll(async () => {
  await fixture.close();
});

test("anonymous protected routes use the canonical safe sign-in redirect", async ({
  page,
}) => {
  const expectNoBrowserFailures = captureBrowserFailures(page);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fdashboard$/u);
  await expect(
    page.getByRole("heading", { name: "Sign in to Humans" }),
  ).toBeVisible();
  expectNoBrowserFailures();
});

test("authenticated research core preserves tenant and claim boundaries", async ({
  browser,
  page,
  context,
}) => {
  const expectNoBrowserFailures = captureBrowserFailures(page);
  const suffix = crypto.randomUUID();
  const user = await fixture.createUser({
    email: `research-${suffix}@example.test`,
    username: `Research_${suffix.replaceAll("-", "")}`,
  });
  await authenticate(context, user.jar);

  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Choose a workspace" }),
  ).toBeVisible();
  await page.getByLabel("Name").fill("Research Alpha");
  await page.getByLabel("Slug").fill(`research-alpha-${suffix}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await expect(
    page.getByRole("heading", { name: "Research dashboard" }),
  ).toBeVisible();
  await expectAxeClean(page);
  await page.goto("/people");
  await expect(
    page.getByRole("heading", { name: "People", exact: true }),
  ).toBeVisible();
  await expectAxeClean(page);

  const [membership] = await fixture.database
    .select({
      memberId: members.id,
      organizationId: workspaces.organizationId,
      workspaceId: workspaces.id,
    })
    .from(members)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, members.workspaceId),
        eq(workspaces.organizationId, members.organizationId),
      ),
    )
    .where(
      and(
        eq(members.userId, user.userId),
        eq(workspaces.name, "Research Alpha"),
      ),
    )
    .limit(1);
  expect(membership).toBeTruthy();
  const principalId = await ensureUserPrincipal(fixture.database, {
    memberId: membership!.memberId,
    userId: user.userId,
    workspaceId: membership!.workspaceId,
  });
  const owner: SessionActor = { ...user, ...membership!, principalId };

  const factDefinition = await fixture.execute<{
    createFactDefinition?: {
      factDefinition: { id: string } | null;
      code: string | null;
    };
  }>({
    jar: user.jar,
    query: CREATE_FACT_DEFINITION,
    variables: {
      input: {
        namespace: "person",
        fieldKey: "date_of_birth",
        label: "Date of birth",
        allowedValueType: "DATE",
        cardinality: "MANY",
        defaultSensitivity: "INTERNAL",
      },
    },
  });
  const factDefinitionId =
    factDefinition.body?.data?.createFactDefinition?.factDefinition?.id;
  expect(factDefinitionId).toBeTruthy();
  const relationshipType = await fixture.execute<{
    createRelationshipType?: { relationshipType: { id: string } | null };
  }>({
    jar: user.jar,
    query: CREATE_RELATIONSHIP_TYPE,
    variables: {
      input: {
        namespace: "person",
        key: "knows",
        forwardLabel: "Knows",
        inverseLabel: "Known by",
        directed: true,
        allowsSelf: false,
      },
    },
  });
  expect(
    relationshipType.body?.data?.createRelationshipType?.relationshipType?.id,
  ).toBeTruthy();
  await Promise.all(
    Array.from({ length: 25 }, async (_, index) => {
      const option = String(index).padStart(2, "0");
      const [definition, type, person] = await Promise.all([
        fixture.execute<{
          createFactDefinition?: { factDefinition: { id: string } | null };
        }>({
          jar: user.jar,
          query: CREATE_FACT_DEFINITION,
          variables: {
            input: {
              namespace: "person",
              fieldKey: `aaa_option_${option}`,
              label: `AAA option ${option}`,
              allowedValueType: "TEXT",
              cardinality: "MANY",
              defaultSensitivity: "INTERNAL",
            },
          },
        }),
        fixture.execute<{
          createRelationshipType?: {
            relationshipType: { id: string } | null;
          };
        }>({
          jar: user.jar,
          query: CREATE_RELATIONSHIP_TYPE,
          variables: {
            input: {
              namespace: "person",
              key: `aaa_type_${option}`,
              forwardLabel: `AAA relation ${option}`,
              inverseLabel: `AAA inverse ${option}`,
              directed: true,
              allowsSelf: false,
            },
          },
        }),
        fixture.createPerson(owner, {
          displayName: `A option person ${option}`,
        }),
      ]);
      expect(
        definition.body?.data?.createFactDefinition?.factDefinition?.id,
      ).toBeTruthy();
      expect(
        type.body?.data?.createRelationshipType?.relationshipType?.id,
      ).toBeTruthy();
      expect(person.body?.data?.createPerson?.person?.id).toBeTruthy();
    }),
  );
  const related = await fixture.createPerson(owner, {
    displayName: "Grace Collaborator",
  });
  const relatedPersonId = related.body?.data?.createPerson?.person?.id;
  expect(relatedPersonId).toBeTruthy();
  const tagTarget = await fixture.createPerson(owner, {
    displayName: "Katherine Tag Target",
  });
  const tagTargetId = tagTarget.body?.data?.createPerson?.person?.id;
  expect(tagTargetId).toBeTruthy();

  await page.goto("/people/new");
  await expectAxeClean(page);
  await page.getByLabel("Display name").fill("Ada Researcher");
  await page
    .getByLabel("Biography")
    .fill("Record with competing birth-date claims.");
  await page.getByRole("button", { name: "Create person" }).click();
  await expect(page).toHaveURL(/\/people\/[0-9a-f-]+(?:\?view=facts)?$/u);
  const personUrl = page.url().split("?")[0]!;

  await page.setViewportSize({ width: 390, height: 844 });
  const editOverview = page.getByRole("button", { name: "Edit overview" });
  await editOverview.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("form", { name: "Person form" })).toBeVisible();
  await page.getByLabel("Display name").fill("Ada Lovelace");
  await page.getByLabel("Preferred name").fill("Countess");
  await page.getByLabel("Status").selectOption("MISSING");
  const saveOverview = page.getByRole("button", { name: "Save overview" });
  await saveOverview.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Ada Lovelace" }),
  ).toBeVisible();
  await expect(page.getByText("Preferred name: Countess")).toBeVisible();
  await expect(page.getByText("missing", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole("link", { name: "More fact fields" }).click();
  await expect(page).toHaveURL(/catalogAfter=/u);
  await expect(page.getByLabel("Field", { exact: true })).toHaveValue(
    factDefinitionId!,
  );
  await page.getByLabel("Value").fill("1815-12-10");
  await page.getByLabel("Claim state").selectOption("ASSERTED");
  await page.getByRole("button", { name: "Add fact" }).click();
  await expect(
    page.getByRole("article", { name: /date of birth/i }),
  ).toBeVisible();
  await page.getByLabel("Value").fill("1815-12-11");
  await page.getByLabel("Claim state").selectOption("DISPUTED");
  await page.getByRole("button", { name: "Add fact" }).click();
  await expect(
    page.getByRole("article", { name: /date of birth/i }),
  ).toHaveCount(2);
  await expect(page.getByText("Asserted", { exact: true })).toBeVisible();
  await expect(page.getByText("Disputed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Contradictory claims" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Contradictory claims" })
      .locator("..")
      .getByText("1815-12-10", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Contradictory claims" })
      .locator("..")
      .getByText("1815-12-11", { exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Select for presentation" })
    .first()
    .click();
  await expect(page.getByText("Selected for presentation")).toBeVisible();
  await expectAxeClean(page);
  if (process.env.PLAYWRIGHT_CAPTURE_TASK9 === "true") {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "test-results/task9-profile-desktop.png",
      fullPage: true,
    });
  }

  const personId = personUrl.split("/").at(-1)!;
  await fixture.database.insert(personNames).values([
    {
      id: newId(),
      workspaceId: membership!.workspaceId,
      personId,
      kind: "alias",
      fullName: "Ada Byron",
      givenName: "Ada",
      familyName: "Byron",
      sensitivity: "internal",
      state: "asserted",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    },
    {
      id: newId(),
      workspaceId: membership!.workspaceId,
      personId,
      kind: "former",
      fullName: "Augusta Ada King",
      givenName: "Augusta Ada",
      familyName: "King",
      sensitivity: "internal",
      state: "verified",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    },
  ]);
  await fixture.database.insert(personEvents).values([
    {
      id: newId(),
      workspaceId: membership!.workspaceId,
      personId,
      eventKind: "milestone",
      title: "Published first program",
      description: "Timeline acceptance event.",
      earliestAt: new Date("1843-01-01T00:00:00.000Z"),
      sensitivity: "internal",
      state: "asserted",
      createdBy: owner.principalId,
      updatedBy: owner.principalId,
    },
  ]);
  await page.goto(personUrl);
  await expect(
    page.getByRole("heading", { name: "Claims", exact: true }),
  ).toBeVisible();
  const namesTimelineLink = page.getByRole("link", {
    name: "Names & timeline",
  });
  await expect(namesTimelineLink).not.toHaveAttribute("aria-current", "page");
  await namesTimelineLink.focus();
  await page.keyboard.press("Enter");
  await expect(namesTimelineLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Names" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ada Byron", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Augusta Ada King", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Published first program", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    document.documentElement.style.zoom = "2";
  });
  await expectAxeClean(page);
  const rtlZoomOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(rtlZoomOverflow, "profile should reflow at RTL 200% zoom").toBe(false);
  await page.evaluate(() => {
    document.documentElement.dir = "ltr";
    document.documentElement.style.zoom = "";
  });
  const selections = await fixture.execute<{
    person?: {
      fieldSelections: { nodes: Array<{ factId: string }> };
    } | null;
  }>({
    jar: user.jar,
    query: PERSON_SELECTIONS,
    variables: { id: personId },
  });
  const selectedFactId =
    selections.body?.data?.person?.fieldSelections.nodes[0]?.factId;
  expect(selectedFactId).toBeTruthy();
  for (let expectedVersion = 1; expectedVersion <= 4; expectedVersion += 1) {
    const revision = await fixture.execute<{
      reviseFact?: { fact: { id: string; version: number } | null };
    }>({
      jar: user.jar,
      query: REVISE_FACT,
      variables: {
        input: {
          id: selectedFactId,
          expectedVersion,
          changeReason: `Pagination sentinel revision ${expectedVersion}`,
        },
      },
    });
    expect(revision.body?.data?.reviseFact?.fact?.version).toBe(
      expectedVersion + 1,
    );
  }
  for (let index = 1; index <= 4; index += 1) {
    const extraFact = await fixture.execute<{
      createFact?: { fact: { id: string } | null };
    }>({
      jar: user.jar,
      query: CREATE_FACT,
      variables: {
        input: {
          personId,
          definitionId: factDefinitionId,
          value: { dateStart: `190${index}-01-01` },
          state: "ASSERTED",
        },
      },
    });
    expect(extraFact.body?.data?.createFact?.fact?.id).toBeTruthy();
  }
  await page.goto(personUrl);
  await page.getByRole("link", { name: "Next facts page" }).click();
  await expect(page.getByText("Selected for presentation")).toBeVisible();
  await page
    .getByRole("link", { name: "More revisions for Date of birth" })
    .click();
  await expect(
    page.getByRole("link", { name: "First revisions page" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Relationships" }).click();
  await page
    .getByRole("textbox", { name: "Find a related person" })
    .fill("Grace");
  await page.getByRole("button", { name: "Search people" }).click();
  await expect(page).toHaveURL(/relationshipPersonSearch=Grace/u);
  await expect(page.getByLabel("Related person", { exact: true })).toHaveValue(
    relatedPersonId!,
  );
  await page.getByRole("link", { name: "More relationship types" }).click();
  await expect(page).toHaveURL(/relationshipTypeAfter=/u);
  await page
    .getByLabel("Relationship type", { exact: true })
    .selectOption({ label: "Knows" });
  await page
    .getByLabel("Related person", { exact: true })
    .selectOption({ label: "Grace Collaborator" });
  await page.getByRole("button", { name: "Add relationship" }).click();
  await expect(
    page.getByRole("region", { name: "Relationships" }).getByText("Knows", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(`/people/${relatedPersonId}?view=relationships`);
  const relationshipRegion = page.getByRole("region", {
    name: "Relationships",
  });
  await expect(
    relationshipRegion.getByText("Known by", { exact: true }),
  ).toBeVisible();
  await expect(
    relationshipRegion.getByRole("link", { name: "Ada Lovelace" }),
  ).toBeVisible();
  await page.goto(`${personUrl}?view=evidence`);

  await page.getByLabel("Source title").fill("Archive register");
  await page.getByLabel("Source URL").fill("https://example.test/archive/42");
  await page.getByLabel("Excerpt").fill("Recorded in the December register.");
  await page.getByRole("button", { name: "Add evidence" }).click();
  await expect(
    page.getByText("Archive register", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Notes & tags" }).click();
  await page
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("Research note kept as escaped plain text.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(
    page.getByText("Research note kept as escaped plain text."),
  ).toBeVisible();
  await page.getByLabel("New tag name").fill("priority");
  await page.getByRole("button", { name: "Apply tag" }).click();
  await expect(
    page
      .getByRole("region", { name: "Tags" })
      .getByText("priority", { exact: true }),
  ).toBeVisible();

  await page.goto(`/people/${tagTargetId}?view=notes`);
  const applyTagForm = page.getByRole("form", { name: "Apply tag" });
  await applyTagForm
    .getByLabel("Tag", { exact: true })
    .selectOption({ label: "priority" });
  await applyTagForm.getByRole("button", { name: "Apply tag" }).click();
  await expect(
    page
      .getByRole("region", { name: "Tags" })
      .getByText("priority", { exact: true }),
  ).toBeVisible();
  await page.goto(personUrl);

  await page.getByRole("button", { name: "Choose theme" }).click();
  await page.getByRole("menuitem", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/u);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("theme")))
    .toBe("light");
  await page.getByRole("button", { name: "Choose theme" }).click();
  await page.getByRole("menuitem", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/u);
  await page.getByRole("button", { name: "Choose theme" }).click();
  await page.getByRole("menuitem", { name: "System" }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("theme")))
    .toBe("system");
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("dialog", { name: "Go to or run a command" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const beta = await provisionWorkspace(fixture.database, {
    userId: user.userId,
    name: "Research Beta",
    slug: `research-beta-${suffix}`,
  });
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const navigationTrigger = page.getByRole("button", {
    name: "Open navigation",
  });
  await navigationTrigger.click();
  const navigationDialog = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigationDialog).toBeVisible();
  await expect(
    navigationDialog.getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    navigationDialog.getByRole("button", { name: "Workspace: Research Alpha" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    navigationDialog.getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  if (process.env.PLAYWRIGHT_CAPTURE_TASK9 === "true") {
    await page.screenshot({
      path: "test-results/task9-navigation-mobile.png",
      fullPage: true,
    });
  }
  await page.keyboard.press("Escape");
  await expect(navigationTrigger).toBeFocused();
  await navigationTrigger.click();
  await navigationDialog
    .getByRole("button", { name: "Workspace: Research Alpha" })
    .click();
  await page.getByRole("menuitem", { name: "Research Beta" }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await navigationTrigger.click();
  await expect(
    navigationDialog.getByRole("button", { name: "Workspace: Research Beta" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/people");
  await expect(page.getByText(/no people have been added/i)).toBeVisible();
  await expectAxeClean(page);
  await expect(page.getByText("Ada Lovelace", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key !== "theme"),
    ),
  ).toEqual([]);

  const viewer = await fixture.createWorkspaceMember(owner, "viewer");
  const viewerContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3106",
  });
  await authenticate(viewerContext, viewer.jar);
  const viewerPage = await viewerContext.newPage();
  const expectNoViewerFailures = captureBrowserFailures(viewerPage);
  await viewerPage.goto(personUrl);
  await expect(
    viewerPage.getByRole("button", { name: "Add fact" }),
  ).toHaveCount(0);
  await expect(
    viewerPage.getByRole("button", { name: "Select for presentation" }),
  ).toHaveCount(0);
  await expect(
    viewerPage.getByRole("button", { name: "Edit overview" }),
  ).toHaveCount(0);
  const denied = await fixture.createPerson(viewer, {
    displayName: "Forbidden write",
  });
  expect(denied.body?.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  expectNoViewerFailures();
  await viewerContext.close();

  expect(beta.organizationId).not.toBe(membership!.organizationId);
  expectNoBrowserFailures();
});
