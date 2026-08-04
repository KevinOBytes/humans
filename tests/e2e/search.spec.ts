import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";

import { sessions } from "@/db/schema/auth";
import { newId } from "@/db/id";
import { auditEvents } from "@/db/schema/operations";
import { searchDocuments } from "@/db/schema/search";
import { provisionWorkspace } from "@/modules/auth/workspaces";

import type { CookieJar } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();
let actor: Awaited<ReturnType<ResearchFixture["createActor"]>>;
const literalMarkup = '<img src=x onerror="globalThis.pwned=true">';

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
  const messages: string[] = [];
  page.on("console", (message) => {
    messages.push(message.text());
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    request.failure()?.errorText === "net::ERR_ABORTED" &&
    request.url().includes("_rsc=")
      ? undefined
      : failures.push(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
        ),
  );
  page.on("response", (response) => {
    if (response.status() >= 500)
      failures.push(`response: ${response.status()} ${response.url()}`);
  });
  return {
    expectClean: () => expect(failures, failures.join("\n")).toEqual([]),
    messages,
  };
}

async function flushTestRedis() {
  if (!process.env.TEST_REDIS_URL) return;
  const redis = new IORedis(process.env.TEST_REDIS_URL, {
    maxRetriesPerRequest: 0,
  });
  await redis.flushdb();
  await redis.quit();
}

test.beforeAll(async () => {
  await fixture.reset();
  actor = await fixture.createActor();
  const alpha = await fixture.createPerson(actor, {
    displayName: "Browser Search Alpha",
  });
  expect(alpha.body?.errors).toBeUndefined();
  const alphaId = alpha.body?.data?.createPerson?.person?.id;
  if (!alphaId) throw new Error("Search E2E person was not created");
  await fixture.database.insert(searchDocuments).values({
    id: newId(),
    workspaceId: actor.workspaceId,
    resourceKind: "person",
    resourceId: alphaId,
    sourceVersion: 1,
    resultKind: "PERSON",
    resultId: alphaId,
    subjectPersonId: alphaId,
    sensitivity: "internal",
    redactedText: "Browser Search Alpha",
    bodyText: "",
    displayText: `Browser Search Alpha ${literalMarkup}`,
  });
  for (let index = 1; index <= 12; index += 1) {
    const created = await fixture.createPerson(actor, {
      displayName: `Browser Pagination ${String(index).padStart(2, "0")}`,
    });
    const id = created.body?.data?.createPerson?.person?.id;
    if (!id) throw new Error("Search E2E pagination person was not created");
    await fixture.database.insert(searchDocuments).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      resourceKind: "person",
      resourceId: id,
      sourceVersion: 1,
      resultKind: "PERSON",
      resultId: id,
      subjectPersonId: id,
      sensitivity: "internal",
      redactedText: `Browser Pagination ${String(index).padStart(2, "0")}`,
      bodyText: "",
      displayText: `Browser Pagination ${String(index).padStart(2, "0")}`,
    });
  }
  for (const sensitivity of ["public", "internal"] as const) {
    const created = await fixture.createPerson(actor, {
      displayName: `Browser Sensitivity ${sensitivity}`,
      sensitivity: sensitivity === "public" ? "PUBLIC" : "INTERNAL",
    });
    const id = created.body?.data?.createPerson?.person?.id;
    if (!id) throw new Error("Search E2E sensitivity person was not created");
    await fixture.database.insert(searchDocuments).values({
      id: newId(),
      workspaceId: actor.workspaceId,
      resourceKind: "person",
      resourceId: id,
      sourceVersion: 1,
      resultKind: "PERSON",
      resultId: id,
      subjectPersonId: id,
      sensitivity,
      redactedText: `Browser Sensitivity ${sensitivity}`,
      bodyText: "",
      displayText: `Browser Sensitivity ${sensitivity}`,
    });
  }

  const foreignWorkspace = await provisionWorkspace(fixture.database, {
    userId: actor.userId,
    name: "Search E2E Foreign",
    slug: `search-e2e-foreign-${actor.workspaceId}`,
  });
  await fixture.database
    .update(sessions)
    .set({ activeOrganizationId: foreignWorkspace.organizationId })
    .where(eq(sessions.userId, actor.userId));
  const foreign = await fixture.createPerson(actor, {
    displayName: "Foreign Secret Needle",
  });
  expect(foreign.body?.errors).toBeUndefined();
  const foreignId = foreign.body?.data?.createPerson?.person?.id;
  if (!foreignId) throw new Error("Foreign search E2E person was not created");
  await fixture.database.insert(searchDocuments).values({
    id: newId(),
    workspaceId: foreignWorkspace.workspaceId,
    resourceKind: "person",
    resourceId: foreignId,
    sourceVersion: 1,
    resultKind: "PERSON",
    resultId: foreignId,
    subjectPersonId: foreignId,
    sensitivity: "internal",
    redactedText: "Foreign Secret Needle",
    bodyText: "",
    displayText: "Foreign Secret Needle",
  });
  await fixture.database
    .update(sessions)
    .set({ activeOrganizationId: actor.organizationId })
    .where(eq(sessions.userId, actor.userId));
});

test.beforeEach(async () => {
  await fixture.database
    .update(sessions)
    .set({ activeOrganizationId: actor.organizationId })
    .where(eq(sessions.userId, actor.userId));
  await flushTestRedis();
});

test.afterAll(async () => fixture.close());

test("authorized search is accessible, isolated, savable, and browser-storage safe", async ({
  context,
  page,
}) => {
  const browser = browserFailures(page);
  await authenticate(context, actor.jar);
  await page.goto("/search");
  await expect(
    page.getByRole("heading", { name: "Authorized search" }),
  ).toBeVisible();
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations,
    axe.violations.map(({ id, help }) => `${id}: ${help}`).join("\n"),
  ).toEqual([]);

  const query = page.getByLabel("Search query");
  await query.fill("Alpha");
  await query.press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "Authorized search results loaded.",
  );
  const results = page.getByRole("list", {
    name: "Authorized search results",
  });
  await expect(results).toContainText("Browser Search Alpha");
  await expect(results).toContainText(literalMarkup);
  await expect(results.locator("img")).toHaveCount(0);
  await expect(results.locator("mark")).toContainText("Alpha");
  expect(await page.evaluate(() => Reflect.has(globalThis, "pwned"))).toBe(
    false,
  );

  await page.getByLabel("Saved query name").fill("Alpha browser query");
  await page.getByLabel("Sharing").selectOption("WORKSPACE");
  await page.getByRole("button", { name: "Save current query" }).click();
  await expect(page.getByRole("status")).toContainText("Current query saved.");
  await page.getByRole("button", { name: "Run saved query" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Authorized search results loaded.",
  );
  await expect(results).toContainText("Browser Search Alpha");

  await query.fill("Foreign Secret Needle");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "No authorized results matched this search.",
  );
  await expect(results).toHaveCount(0);

  const protectedSecret = "+1 212 555 0199";
  await page.getByLabel("Search mode").selectOption("PROTECTED_EXACT");
  await page
    .getByLabel("Protected value", { exact: true })
    .fill(protectedSecret);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "No authorized results matched this search.",
  );

  expect(page.url()).not.toContain("Alpha");
  expect(page.url()).not.toContain("Needle");
  expect(page.url()).not.toContain(encodeURIComponent(protectedSecret));
  const browserStorage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  const browserArtifacts = JSON.stringify({
    browserStorage,
    console: browser.messages,
  });
  expect(browserArtifacts).not.toContain("Foreign Secret Needle");
  expect(browserArtifacts).not.toContain(protectedSecret);
  const audits = await fixture.database.select().from(auditEvents);
  expect(JSON.stringify(audits)).not.toContain("Foreign Secret Needle");
  expect(JSON.stringify(audits)).not.toContain(protectedSecret);
  browser.expectClean();
});

test("generated search operations paginate, narrow sensitivity, and render safe failure states", async ({
  context,
  page,
}) => {
  const browser = browserFailures(page);
  await authenticate(context, actor.jar);
  await page.goto("/search");
  const query = page.getByLabel("Search query");
  const results = page.getByRole("list", {
    name: "Authorized search results",
  });

  await page.getByLabel("Results per page").selectOption("10");
  await query.fill("Browser Pagination");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(results.getByRole("listitem")).toHaveCount(10);
  await page.getByRole("button", { name: "Load more results" }).click();
  await expect(results.getByRole("listitem")).toHaveCount(12);
  await expect(
    page.getByRole("button", { name: "Load more results" }),
  ).toHaveCount(0);

  await page.getByText("Structured filters").click();
  await page.getByLabel("PUBLIC").check();
  await query.fill("Browser Sensitivity");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(results).toContainText("Browser Sensitivity public");
  await expect(results).not.toContainText("Browser Sensitivity internal");

  const observedGeneratedQueries: string[] = [];
  let code: "RATE_LIMITED" | "PROVIDER_UNAVAILABLE" = "RATE_LIMITED";
  await page.route("**/api/graphql", async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as { query?: unknown };
    if (
      typeof body.query !== "string" ||
      !body.query.includes("query SearchWorkbenchSearch")
    ) {
      await route.continue();
      return;
    }
    observedGeneratedQueries.push(body.query);
    await route.fulfill({
      contentType: "application/json",
      status: 200,
      body: JSON.stringify({
        data: null,
        errors: [
          {
            message:
              code === "RATE_LIMITED"
                ? "Too many requests."
                : "A required service is temporarily unavailable.",
            extensions: { code, requestId: crypto.randomUUID() },
          },
        ],
      }),
    });
  });
  await query.fill("Browser capacity state");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Search capacity is temporarily exhausted. Wait and try again.",
  );
  code = "PROVIDER_UNAVAILABLE";
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Search is temporarily unavailable. Try again later.",
  );
  expect(observedGeneratedQueries).toHaveLength(2);
  expect(
    observedGeneratedQueries.every((document) =>
      document.includes("fragment SearchWorkbenchPage"),
    ),
  ).toBe(true);
  browser.expectClean();
});
