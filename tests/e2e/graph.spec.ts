import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type BrowserContext,
  type Download,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import IORedis from "ioredis";

import { sessions } from "@/db/schema/auth";
import { relationshipTypes } from "@/db/schema/relationships";
import {
  provisionWorkspace,
  type WorkspaceIdentity,
} from "@/modules/auth/workspaces";

import type { CookieJar } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();
let actor: Awaited<ReturnType<ResearchFixture["createActor"]>>;
let secondaryWorkspace: WorkspaceIdentity;
let primaryRelationshipTypeId: string;

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
  page.on("response", (response) => {
    if (response.status() >= 500)
      failures.push(`response: ${response.status()} ${response.url()}`);
  });
  return () => expect(failures, failures.join("\n")).toEqual([]);
}

async function downloadBytes(download: Download) {
  const path = await download.path();
  if (!path) throw new Error("Browser download path was unavailable");
  return readFile(path);
}

async function flushTestRedis() {
  if (process.env.TEST_REDIS_URL) {
    const redis = new IORedis(process.env.TEST_REDIS_URL, {
      maxRetriesPerRequest: 0,
    });
    await redis.flushdb();
    await redis.quit();
  }
}

test.beforeAll(async () => {
  await fixture.reset();
  actor = await fixture.createActor();
  const alpha = await fixture.createPerson(actor, {
    displayName: "Alpha Person",
  });
  const beta = await fixture.createPerson(actor, {
    displayName: "Beta Person",
  });
  const alphaId = alpha.body?.data?.createPerson?.person?.id;
  const betaId = beta.body?.data?.createPerson?.person?.id;
  if (!alphaId || !betaId) throw new Error("Graph E2E people were not created");
  const type = await fixture.execute<{
    createRelationshipType: { relationshipType: { id: string } | null };
  }>({
    jar: actor.jar,
    query: `mutation($input: CreateRelationshipTypeInput!) { createRelationshipType(input: $input) { relationshipType { id } } }`,
    variables: {
      input: {
        key: "collaborates",
        forwardLabel: "collaborates with",
        inverseLabel: "collaborates with",
        directed: false,
      },
    },
  });
  const typeId = type.body?.data?.createRelationshipType.relationshipType?.id;
  if (!typeId) throw new Error("Graph E2E relationship type was not created");
  primaryRelationshipTypeId = typeId;
  const relationship = await fixture.execute({
    jar: actor.jar,
    query: `mutation($input: CreateRelationshipInput!) { createRelationship(input: $input) { relationship { id } code } }`,
    variables: {
      input: {
        sourcePersonId: alphaId,
        targetPersonId: betaId,
        relationshipTypeId: typeId,
      },
    },
  });
  if (relationship.body?.errors)
    throw new Error("Graph E2E relationship was not created");

  secondaryWorkspace = await provisionWorkspace(fixture.database, {
    userId: actor.userId,
    name: "Graph E2E Beta",
    slug: `graph-e2e-beta-${actor.workspaceId}`,
  });
  await fixture.database
    .update(sessions)
    .set({ activeOrganizationId: secondaryWorkspace.organizationId })
    .where(eq(sessions.userId, actor.userId));
  const betaOne = await fixture.createPerson(actor, {
    displayName: "Beta Workspace One",
  });
  const betaTwo = await fixture.createPerson(actor, {
    displayName: "Beta Workspace Two",
  });
  const betaOneId = betaOne.body?.data?.createPerson?.person?.id;
  const betaTwoId = betaTwo.body?.data?.createPerson?.person?.id;
  if (!betaOneId || !betaTwoId) {
    throw new Error("Secondary graph E2E people were not created");
  }
  const betaType = await fixture.execute<{
    createRelationshipType: { relationshipType: { id: string } | null };
  }>({
    jar: actor.jar,
    query: `mutation($input: CreateRelationshipTypeInput!) { createRelationshipType(input: $input) { relationshipType { id } } }`,
    variables: {
      input: {
        key: "beta-links",
        forwardLabel: "beta links",
        inverseLabel: "beta links",
        directed: false,
      },
    },
  });
  const betaTypeId =
    betaType.body?.data?.createRelationshipType.relationshipType?.id;
  if (!betaTypeId) {
    throw new Error("Secondary graph E2E relationship type was not created");
  }
  const betaRelationship = await fixture.execute({
    jar: actor.jar,
    query: `mutation($input: CreateRelationshipInput!) { createRelationship(input: $input) { relationship { id } code } }`,
    variables: {
      input: {
        sourcePersonId: betaOneId,
        targetPersonId: betaTwoId,
        relationshipTypeId: betaTypeId,
      },
    },
  });
  if (betaRelationship.body?.errors) {
    throw new Error("Secondary graph E2E relationship was not created");
  }
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

test("authenticated graph keeps table parity, saves views, and exports safe files", async ({
  context,
  page,
}) => {
  const expectNoFailures = browserFailures(page);
  await authenticate(context, actor.jar);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:3106",
  });
  await page.goto("/graph");
  await expect(
    page.getByRole("heading", { name: "Social graph" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Loaded people" }),
  ).toContainText("Alpha Person");
  await expect(
    page.getByRole("table", { name: "Loaded people" }),
  ).toContainText("Beta Person");
  await expect(
    page.getByRole("table", { name: "Loaded relationships" }),
  ).toContainText("collaborates with");
  await page.waitForTimeout(2_000);
  expectNoFailures();
  await expect(page.getByLabel("Filter loaded people")).toBeVisible();
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations,
    axe.violations.map(({ id, help }) => `${id}: ${help}`).join("\n"),
  ).toEqual([]);
  expectNoFailures();

  await page.getByLabel("Filter loaded people").fill("Alpha");
  await expect(
    page.getByRole("table", { name: "Loaded people" }),
  ).toContainText("Alpha Person");
  await expect(
    page.getByRole("table", { name: "Loaded people" }),
  ).not.toContainText("Beta Person");
  await page.getByLabel("Filter loaded people").fill("");
  await page.getByRole("button", { name: "Start path mode" }).click();
  await page.getByRole("button", { name: "Details for Alpha Person" }).click();
  await page.getByRole("button", { name: "Details for Beta Person" }).click();
  await expect(
    page.getByRole("status", { name: "Graph explorer status" }),
  ).toContainText("Path contains 2 people");

  await page.getByRole("button", { name: "Save new view" }).click();
  await expect(
    page.getByRole("status", { name: "Graph explorer status" }),
  ).toContainText("Graph view saved");
  await page.getByRole("button", { name: "Copy selected view link" }).click();
  const savedUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(savedUrl).toMatch(/\/graph\?view=[0-9a-f-]+$/u);
  await page.goto(savedUrl);
  await expect(
    page.getByRole("heading", { name: "Social graph" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const jsonDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON" }).click();
  const json = JSON.parse(
    (await downloadBytes(await jsonDownload)).toString("utf8"),
  ) as { schema?: string; nodes?: unknown[] };
  expect(json).toMatchObject({ schema: "humans.graph-export.v1" });
  expect(json.nodes).toHaveLength(2);

  const svgDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download SVG" }).click();
  const svg = (await downloadBytes(await svgDownload)).toString("utf8");
  expect(svg).toContain('viewBox="0 0 1600 900"');
  expect(svg).not.toMatch(/<script|foreignObject|onerror|href=/u);

  const nodesDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download nodes CSV" }).click();
  const nodesCsv = (await downloadBytes(await nodesDownload)).toString("utf8");
  expect(nodesCsv).toMatch(
    /^person_id,display_name,status,sensitivity,version,degree,community\r\n/u,
  );
  expect(nodesCsv).toContain("Alpha Person");

  const relationshipsDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download relationships CSV" })
    .click();
  const relationshipsCsv = (
    await downloadBytes(await relationshipsDownload)
  ).toString("utf8");
  expect(relationshipsCsv).toMatch(
    /^relationship_id,source_person_id,target_person_id,type_id,label,directed,state,sensitivity,confidence,strength,valid_from,valid_until,version\r\n/u,
  );
  expect(relationshipsCsv).toContain("collaborates with");

  const gexfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GEXF" }).click();
  const gexf = (await downloadBytes(await gexfDownload)).toString("utf8");
  expect(gexf).toContain("<gexf");
  expect(gexf).toContain("Alpha Person");
  expect(gexf).not.toMatch(/<script|onerror=/u);

  const graphMlDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download GraphML" }).click();
  const graphMl = (await downloadBytes(await graphMlDownload)).toString("utf8");
  expect(graphMl).toContain("<graphml");
  expect(graphMl).toContain("Alpha Person");
  expect(graphMl).not.toMatch(/<script|onerror=/u);

  await page.getByRole("button", { name: "Create snapshot" }).click();
  await expect(
    page.getByRole("status", { name: "Graph explorer status" }),
  ).toContainText("Reproducibility snapshot created");
  await expect(page.getByText("Snapshot ID")).toBeVisible();
  await page.getByRole("button", { name: "Check snapshot validity" }).click();
  await expect(
    page.getByRole("status", { name: "Graph explorer status" }),
  ).toContainText("reproducible with current authorized data");

  await page.getByRole("button", { name: "Run analysis" }).click();
  await expect(
    page.getByRole("status", { name: "Graph explorer status" }),
  ).toContainText("Degree analysis completed", { timeout: 15_000 });
  expectNoFailures();
  await expect(
    page.getByRole("table", { name: "New graph analysis metrics" }),
  ).toContainText("Alpha Person");
  const analysisDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export results JSON" }).click();
  const analysisJson = JSON.parse(
    (await downloadBytes(await analysisDownload)).toString("utf8"),
  ) as { schema?: string; results?: unknown[] };
  expect(analysisJson.schema).toBe("humans.graph-analysis-export.v1");
  expect(analysisJson.results).toHaveLength(2);
  await fixture.database
    .update(relationshipTypes)
    .set({ version: 2 })
    .where(eq(relationshipTypes.id, primaryRelationshipTypeId));
  await page.getByRole("button", { name: "Check snapshot validity" }).click();
  await expect(
    page.getByRole("status", { name: "Graph explorer status" }),
  ).toContainText("no longer reproducible");

  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG" }).click();
  const png = await downloadBytes(await pngDownload);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(1600);
  expect(png.readUInt32BE(20)).toBe(900);
  expectNoFailures();
});

test("graph has an explicit Canvas 2D fallback when WebGL is unavailable", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await authenticate(context, actor.jar);
  await context.addInitScript(() => {
    Object.defineProperty(window, "WebGLRenderingContext", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "WebGL2RenderingContext", {
      configurable: true,
      value: undefined,
    });
  });
  const page = await context.newPage();
  const expectNoFailures = browserFailures(page);
  await page.goto("/graph");
  await expect(
    page.getByRole("img", {
      name: /Read-only social graph image with 2 people and 1 relationship/u,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "WebGL is unavailable. Showing a read-only Canvas 2D image.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Loaded people" }),
  ).toContainText("Alpha Person");
  expectNoFailures();
  await context.close();
});

test("switching workspaces cannot retain graph, saved-view, or in-flight analysis state", async ({
  context,
  page,
}) => {
  await authenticate(context, actor.jar);
  await page.goto("/graph");
  await expect(
    page.getByRole("table", { name: "Loaded people" }),
  ).toContainText("Alpha Person");
  await page.getByRole("textbox", { name: "View name" }).fill("Alpha only");
  await page.getByRole("button", { name: "Save new view" }).click();
  await expect(page.getByLabel("Saved view")).toContainText("Alpha only");

  await page.route("**/api/graphql", async (route) => {
    if (route.request().postData()?.includes("RunGraphAnalysis")) {
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Run analysis" }).click();
  await page
    .getByRole("button", { name: /^Workspace:/u })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Graph E2E Beta" }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await page.goto("/graph");

  const people = page.getByRole("table", { name: "Loaded people" });
  await expect(people).toContainText("Beta Workspace One");
  await expect(people).not.toContainText("Alpha Person");
  await expect(page.getByLabel("Saved view")).not.toContainText("Alpha only");
  await expect(
    page.getByRole("table", { name: "New graph analysis metrics" }),
  ).toHaveCount(0);
});

test("graph keyboard access, reduced motion, system dark mode, and narrow zoom reflow remain usable", async ({
  browser,
}) => {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1_440 },
  });
  await authenticate(context, actor.jar);
  const page = await context.newPage();
  const expectNoFailures = browserFailures(page);
  await page.goto("/graph");
  await expect(
    page.getByRole("heading", { name: "Social graph" }),
  ).toBeVisible();
  await expect(page.getByLabel("Saved view")).toBeVisible();
  await page.waitForTimeout(750);

  await expect(page.locator("html")).toHaveClass(/dark/u);
  const filter = page.getByLabel("Filter loaded people");
  await filter.focus();
  await expect(filter).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeFocused();

  await page.getByRole("button", { name: "Run ForceAtlas2 layout" }).click();
  await expect(
    page.getByRole("status", { name: "Graph explorer status" }),
  ).toContainText("reduced motion is enabled");

  const alphaDetails = page.getByRole("button", {
    name: "Details for Alpha Person",
  });
  await alphaDetails.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Alpha Person" }),
  ).toBeVisible();

  for (const percentage of [200, 400]) {
    await page.setViewportSize({
      height: 900,
      width: Math.floor(1_440 / (percentage / 100)),
    });
    await expect(
      page.getByRole("table", { name: "Loaded people" }),
    ).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows, `page overflowed at ${percentage}% text zoom`).toBe(
      false,
    );
  }

  await page
    .getByRole("button", { name: "Edit selected neighborhood" })
    .click();
  const editor = page.getByRole("dialog", { name: "Edit neighborhood" });
  await expect(editor).toBeVisible();
  const firstEditorNode = page
    .getByLabel("Focused relationship editor")
    .locator(".react-flow__node")
    .first();
  await expect(firstEditorNode).toHaveAttribute("tabindex", "0");
  await page.waitForTimeout(750);
  await firstEditorNode.focus();
  await expect(firstEditorNode).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).not.toBeVisible();

  expectNoFailures();
  await context.close();
});

test("WebGL context recovery preserves the table and degrades safely after repeated loss", async ({
  context,
  page,
}) => {
  await authenticate(context, actor.jar);
  await page.goto("/graph");
  const canvas = page.locator(".sigma-container canvas").first();
  await expect(canvas).toBeVisible();

  await canvas.evaluate((element) =>
    element.dispatchEvent(new Event("webglcontextlost", { cancelable: true })),
  );
  await page.getByRole("button", { name: /Retry WebGL/u }).click();
  const recovered = page.locator(".sigma-container canvas").first();
  await expect(recovered).toBeVisible();
  await recovered.evaluate((element) =>
    element.dispatchEvent(new Event("webglcontextlost", { cancelable: true })),
  );

  await expect(page.getByText("Visual graph unavailable")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Retry WebGL/u }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("table", { name: "Loaded people" }),
  ).toContainText("Alpha Person");
});

test("relationship editor performs only explicitly confirmed mutations", async ({
  context,
  page,
}) => {
  await authenticate(context, actor.jar);
  const expectNoFailures = browserFailures(page);
  await page.goto("/graph");
  await page.getByRole("button", { name: "Details for Alpha Person" }).click();
  await page
    .getByRole("button", { name: "Edit selected neighborhood" })
    .click();

  await page
    .getByRole("combobox", { name: "Relationship source" })
    .selectOption({ label: "Alpha Person" });
  await page
    .getByRole("combobox", { name: "Relationship target" })
    .selectOption({ label: "Beta Person" });
  await page.getByRole("button", { name: "Create relationship" }).click();
  await expect(
    page.getByText("2 relationships loaded", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Details for Alpha Person" }).click();
  await page
    .getByRole("button", { name: "Edit selected neighborhood" })
    .click();
  await page
    .getByRole("combobox", { name: "Existing relationship" })
    .selectOption({ index: 1 });
  await page
    .getByRole("combobox", { name: "Existing relationship sensitivity" })
    .selectOption("CONFIDENTIAL");
  await page.getByRole("button", { name: "Review update" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm update" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm update" }).click();
  await expect(
    page.getByText("2 relationships loaded", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Details for Alpha Person" }).click();
  await page
    .getByRole("button", { name: "Edit selected neighborhood" })
    .click();
  await page
    .getByRole("combobox", { name: "Existing relationship" })
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: "Review archive" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm archive" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm archive" }).click();
  await expect(
    page.getByText("1 relationships loaded", { exact: true }),
  ).toBeVisible();
  expectNoFailures();
});
