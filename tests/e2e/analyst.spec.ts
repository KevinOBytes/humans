import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import type { CookieJar } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();
let owner: Awaited<ReturnType<ResearchFixture["createActor"]>>;
let contributor: Awaited<ReturnType<ResearchFixture["createWorkspaceMember"]>>;
const runId = "018f0000-0000-7000-8000-000000000001";
const personId = "018f0000-0000-7000-8000-000000000011";
const evidenceId = "018f0000-0000-7000-8000-000000000012";

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
    request.url().includes("_rsc=")
      ? undefined
      : failures.push(
          `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`,
        ),
  );
  return {
    expectClean: () => expect(failures, failures.join("\n")).toEqual([]),
  };
}

function publicRun(
  state: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED",
) {
  return {
    id: runId,
    state,
    provider: "OLLAMA",
    model: "fixture-model",
    answer:
      state === "COMPLETED"
        ? "The authorized record supports the requested conclusion."
        : null,
    errorCode: state === "FAILED" ? "PROVIDER_TIMEOUT" : null,
    createdAt: "2026-08-04T12:00:00.000Z",
    startedAt: state === "PENDING" ? null : "2026-08-04T12:00:01.000Z",
    completedAt:
      state === "COMPLETED" || state === "FAILED" || state === "CANCELLED"
        ? "2026-08-04T12:00:02.000Z"
        : null,
    citations:
      state === "COMPLETED"
        ? [
            {
              claimText: "The person record supports the conclusion.",
              locator: "Profile",
              resourceId: personId,
              resourceKind: "PERSON",
            },
            {
              claimText: "The evidence item supports the conclusion.",
              locator: "Page 2",
              resourceId: evidenceId,
              resourceKind: "EVIDENCE",
            },
          ]
        : [],
    toolCalls:
      state === "COMPLETED"
        ? [
            {
              name: "getPerson",
              state: "COMPLETED",
              inputSummary: { personCount: 1 },
              resultSummary: { resultCount: 1, truncated: false },
              startedAt: "2026-08-04T12:00:01.000Z",
              completedAt: "2026-08-04T12:00:02.000Z",
            },
          ]
        : [],
  };
}

test.beforeAll(async () => {
  await fixture.reset();
  owner = await fixture.createActor();
  contributor = await fixture.createWorkspaceMember(owner, "contributor");
});

test.afterAll(async () => fixture.close());

test("runs the accessible cited analyst without leaking submitted or provider-private material", async ({
  context,
  page,
}) => {
  await authenticate(context, owner.jar);
  const failures = browserFailures(page);
  let reads = 0;
  const requestBodies: string[] = [];
  await page.route("**/api/graphql", async (route) => {
    const body = route.request().postData() ?? "";
    requestBodies.push(body);
    if (body.includes("StartAiAnalysis")) {
      await route.fulfill({
        json: { data: { startAiAnalysis: publicRun("PENDING") } },
      });
      return;
    }
    if (body.includes("AiRun")) {
      reads += 1;
      await route.fulfill({
        json: {
          data: { aiRun: publicRun(reads === 1 ? "RUNNING" : "COMPLETED") },
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.goto("/analyst");
  await expect(
    page.getByRole("heading", { name: "Cited analyst" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "Analyst" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Close navigation" }).click();
  const initialHtml = await page.content();
  expect(initialHtml).not.toContain("private browser prompt");

  await page
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("private browser prompt");
  await page.getByLabel("Person scope UUIDs").fill(personId);
  await page.getByRole("button", { name: "Start analysis" }).click();
  await expect(page.getByText("Queued", { exact: true })).toBeVisible();
  await expect(page.getByText("Running", { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByRole("heading", { name: "Cited answer" })).toBeFocused(
    {
      timeout: 8_000,
    },
  );
  await expect(page.getByText("OLLAMA · fixture-model")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /person record supports/u }),
  ).toHaveAttribute("href", `/people/${personId}`);
  await expect(page.getByText(/Evidence resource .*Page 2/u)).toBeVisible();
  await expect(page.getByRole("list", { name: "Tool activity" })).toContainText(
    "1 result",
  );

  expect(page.url()).toBe("http://127.0.0.1:3106/analyst");
  const storedValues = await page.evaluate(() => [
    ...Object.values(localStorage),
    ...Object.values(sessionStorage),
  ]);
  expect(storedValues.join("\n")).not.toContain("private browser prompt");
  expect(storedValues.join("\n")).not.toContain("http://127.0.0.1:11434/v1");
  expect(requestBodies.join("\n")).not.toMatch(
    /api[-_ ]?key|base[-_ ]?url|rawTool|upstream/iu,
  );
  expect(
    await page
      .locator("body")
      .evaluate((body) => body.scrollWidth <= body.clientWidth),
  ).toBe(true);
  // A 320 CSS-pixel viewport exercises the same reflow budget as 200% zoom
  // from the 640-pixel baseline above without relying on non-standard CSS zoom.
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page
      .locator("body")
      .evaluate((body) => body.scrollWidth <= body.clientWidth),
  ).toBe(true);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  failures.expectClean();
});

test("gates starting controls and supports explicit cancellation", async ({
  browser,
}) => {
  const contributorContext = await browser.newContext();
  await authenticate(contributorContext, contributor.jar);
  const contributorPage = await contributorContext.newPage();
  await contributorPage.goto("/analyst");
  await expect(
    contributorPage.getByText(
      "You have permission to read prior runs, but not to start or cancel analysis in this workspace.",
    ),
  ).toBeVisible();
  await expect(
    contributorPage.getByRole("textbox", { name: "Question", exact: true }),
  ).toHaveCount(0);
  await contributorContext.close();

  const ownerContext = await browser.newContext();
  await authenticate(ownerContext, owner.jar);
  const ownerPage = await ownerContext.newPage();
  await ownerPage.route("**/api/graphql", async (route) => {
    const body = route.request().postData() ?? "";
    await route.fulfill({
      json: {
        data: body.includes("CancelAiAnalysis")
          ? { cancelAiAnalysis: publicRun("CANCELLED") }
          : body.includes("StartAiAnalysis")
            ? { startAiAnalysis: publicRun("PENDING") }
            : { aiRun: publicRun("PENDING") },
      },
    });
  });
  await ownerPage.goto("/analyst");
  await ownerPage
    .getByRole("textbox", { name: "Question", exact: true })
    .fill("Cancel this analysis");
  await ownerPage.getByRole("button", { name: "Start analysis" }).click();
  await ownerPage.getByRole("button", { name: "Cancel analysis" }).click();
  await expect(ownerPage.getByText("Cancelled", { exact: true })).toBeVisible();
  await ownerContext.close();
});
