import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { aiMessages, aiRuns, aiThreads, aiToolCalls } from "@/db/schema/ai";
import { files, imports } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { workspaceSettings } from "@/db/schema/workspaces";

import type { CookieJar } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

const fixture = new ResearchFixture();

type Actor = Awaited<ReturnType<ResearchFixture["createActor"]>>;

let owner: Actor;
let viewer: Actor;
let emptyOwner: Actor;

const sentinels = {
  auditDiff: "DASHBOARD_PRIVATE_AUDIT_DIFF_42",
  credential: "sk-dashboard-never-render-42",
  hiddenPerson: "Dashboard Restricted Person 42",
  prompt: "DASHBOARD_PRIVATE_PROMPT_42",
  storage: "dashboard-private-storage-key-42",
  tool: "DASHBOARD_PRIVATE_TOOL_ARGUMENT_42",
} as const;

const longName = `Long Dashboard ${"UnbrokenLabel".repeat(18)}`;

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

function monitorBrowser(page: Page) {
  const failures: string[] = [];
  const consoleText: string[] = [];
  const responseText: string[] = [];
  page.on("console", (message) => {
    consoleText.push(message.text());
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
    if (
      response.url().includes("/dashboard") ||
      response.url().includes("_rsc=")
    ) {
      void response
        .text()
        .then((body) => responseText.push(body))
        .catch(() => undefined);
    }
  });
  return {
    assertNoFailures: () => expect(failures, failures.join("\n")).toEqual([]),
    async assertNoLeakage() {
      await page.waitForTimeout(200);
      const storage = await page.evaluate(() => ({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      }));
      const exposed = [
        page.url(),
        await page.content(),
        JSON.stringify(storage),
        consoleText.join("\n"),
        responseText.join("\n"),
      ].join("\n");
      for (const sentinel of Object.values(sentinels)) {
        expect(
          exposed,
          `${sentinel} leaked into browser-visible material`,
        ).not.toContain(sentinel);
      }
    },
  };
}

async function seedPopulatedDashboard() {
  const old = new Date("2026-08-01T12:00:00.000Z");
  const middle = new Date("2026-08-02T12:00:00.000Z");
  const recent = new Date("2026-08-03T12:00:00.000Z");
  const ids = {
    oldest: newId(),
    middle: newId(),
    newest: newId(),
    hidden: newId(),
    type: newId(),
    visibleEdge: newId(),
    hiddenEdge: newId(),
    file: newId(),
    import: newId(),
    thread: newId(),
    message: newId(),
    aiRun: newId(),
  };

  await fixture.database.insert(people).values([
    {
      id: ids.oldest,
      workspaceId: owner.workspaceId,
      displayName: longName,
      sensitivity: "internal",
      createdAt: old,
      updatedAt: old,
      createdBy: owner.userId,
      updatedBy: owner.userId,
    },
    {
      id: ids.middle,
      workspaceId: owner.workspaceId,
      displayName: "Dashboard Older Visible",
      sensitivity: "internal",
      createdAt: old,
      updatedAt: middle,
      createdBy: owner.userId,
      updatedBy: owner.userId,
    },
    {
      id: ids.newest,
      workspaceId: owner.workspaceId,
      displayName: "Dashboard Newest Visible",
      preferredName: "Newest",
      sensitivity: "internal",
      createdAt: old,
      updatedAt: recent,
      createdBy: owner.userId,
      updatedBy: owner.userId,
    },
    {
      id: ids.hidden,
      workspaceId: owner.workspaceId,
      displayName: sentinels.hiddenPerson,
      sensitivity: "confidential",
      createdAt: old,
      updatedAt: new Date("2026-08-04T12:00:00.000Z"),
      createdBy: owner.userId,
      updatedBy: owner.userId,
    },
  ]);
  await fixture.database.insert(relationshipTypes).values({
    id: ids.type,
    workspaceId: owner.workspaceId,
    key: "dashboard-acceptance-link",
    forwardLabel: "worked with",
    inverseLabel: "worked with",
    directed: false,
    createdBy: owner.userId,
    updatedBy: owner.userId,
  });
  await fixture.database.insert(relationships).values([
    {
      id: ids.visibleEdge,
      workspaceId: owner.workspaceId,
      sourcePersonId: ids.middle,
      targetPersonId: ids.newest,
      relationshipTypeId: ids.type,
      sensitivity: "internal",
      createdBy: owner.userId,
      updatedBy: owner.userId,
    },
    {
      id: ids.hiddenEdge,
      workspaceId: owner.workspaceId,
      sourcePersonId: ids.newest,
      targetPersonId: ids.hidden,
      relationshipTypeId: ids.type,
      sensitivity: "internal",
      createdBy: owner.userId,
      updatedBy: owner.userId,
    },
  ]);
  await fixture.database.insert(files).values({
    id: ids.file,
    workspaceId: owner.workspaceId,
    storageProvider: "minio",
    storageBucket: "humans-private",
    storageKey: sentinels.storage,
    originalName: "dashboard-import.csv",
    mediaType: "text/csv",
    byteSize: 42,
    checksum: "sha256:" + "55".repeat(32),
    quarantineState: "available",
    scanState: "clean",
    sensitivity: "internal",
    uploadedBy: owner.userId,
    createdBy: owner.userId,
    updatedBy: owner.userId,
  });
  await fixture.database.insert(imports).values({
    id: ids.import,
    workspaceId: owner.workspaceId,
    fileId: ids.file,
    format: "CSV",
    state: "completed_with_errors",
    idempotencyKey: "dashboard-import-acceptance",
    totalRows: 12,
    acceptedRows: 10,
    rejectedRows: 2,
    startedAt: recent,
    completedAt: recent,
    createdAt: recent,
    updatedAt: recent,
    createdBy: owner.userId,
    updatedBy: owner.userId,
  });
  for (const algorithm of ["PAGERANK", "LOUVAIN_COMMUNITY"] as const) {
    const result = await fixture.execute<{
      runGraphAnalysis?: { run: { id: string } | null };
    }>({
      jar: owner.jar,
      query: `mutation($input: RunGraphAnalysisInput!) { runGraphAnalysis(input: $input) { run { id } } }`,
      variables: { input: { algorithm, filter: { mode: "WORKSPACE" } } },
    });
    if (!result.body?.data?.runGraphAnalysis?.run?.id) {
      throw new Error(
        `Dashboard ${algorithm} analysis was not created: ${JSON.stringify(result.body)}`,
      );
    }
  }
  await fixture.database.insert(aiThreads).values({
    id: ids.thread,
    workspaceId: owner.workspaceId,
    ownerId: owner.principalId,
    title: "Private dashboard thread",
    sharing: "private",
    createdAt: recent,
    updatedAt: recent,
    createdBy: owner.principalId,
    updatedBy: owner.principalId,
  });
  await fixture.database.insert(aiMessages).values({
    id: ids.message,
    workspaceId: owner.workspaceId,
    threadId: ids.thread,
    role: "user",
    encryptedContent: sentinels.prompt,
    contentHash: "sha256:" + "88".repeat(32),
    createdAt: recent,
    updatedAt: recent,
    createdBy: owner.principalId,
    updatedBy: owner.principalId,
  });
  await fixture.database.insert(aiRuns).values({
    id: ids.aiRun,
    workspaceId: owner.workspaceId,
    threadId: ids.thread,
    messageId: ids.message,
    provider: "OPENAI",
    baseUrlFingerprint: sentinels.credential,
    model: "gpt-5-mini",
    promptHash: "sha256:" + "99".repeat(32),
    configurationHash: "sha256:" + "aa".repeat(32),
    state: "completed",
    startedAt: new Date("2026-08-03T18:00:00.000Z"),
    completedAt: new Date("2026-08-03T18:01:00.000Z"),
    createdAt: new Date("2026-08-03T18:00:00.000Z"),
    createdBy: owner.principalId,
  });
  await fixture.database.insert(aiToolCalls).values({
    id: newId(),
    workspaceId: owner.workspaceId,
    aiRunId: ids.aiRun,
    approvedToolName: "people.search",
    redactedArguments: { private: sentinels.tool },
    state: "completed",
    createdAt: recent,
  });
  await fixture.database.insert(auditEvents).values({
    id: newId(),
    workspaceId: owner.workspaceId,
    actorUserId: owner.userId,
    action: "dashboard.acceptance.completed",
    resourceKind: "workspace",
    requestId: "dashboard-acceptance-request",
    redactedDiff: { private: sentinels.auditDiff },
    outcome: "success",
    occurredAt: new Date("2026-08-04T20:00:00.000Z"),
  });
  await fixture.database
    .update(workspaceSettings)
    .set({ retentionDays: 90, aiEnabled: true, storageEnabled: false })
    .where(eq(workspaceSettings.workspaceId, owner.workspaceId));
}

test.beforeAll(async () => {
  await fixture.reset();
  owner = await fixture.createActor("owner");
  viewer = await fixture.createWorkspaceMember(owner, "viewer");
  emptyOwner = await fixture.createActor("owner");
  await seedPopulatedDashboard();
});

test.afterAll(async () => fixture.close());

test("owner sees newest research, merged analysis labels, exact statistics, safe policy, and activity", async ({
  context,
  page,
}) => {
  const browser = monitorBrowser(page);
  await authenticate(context, owner.jar);
  await page.goto("/dashboard");

  await expect(
    page.getByRole("heading", { name: "Research dashboard" }),
  ).toBeVisible();
  await expect(
    page.locator("#main-content").getByRole("link", { name: "Add person" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Manage policies" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View audit log" }),
  ).toBeVisible();

  const peopleList = page.getByRole("list", {
    name: "Recently updated people",
  });
  const peopleLabels = await peopleList.getByRole("link").allTextContents();
  expect(peopleLabels.slice(0, 3)).toEqual([
    "Dashboard Newest Visible",
    "Dashboard Older Visible",
    longName,
  ]);
  await expect(peopleList).toContainText(longName);
  await expect(peopleList).not.toContainText(sentinels.hiddenPerson);
  await expect(page.getByText("Visible people").locator("..")).toContainText(
    "3",
  );
  await expect(
    page.getByText("Visible relationships").locator(".."),
  ).toContainText("1");

  const importsList = page.getByRole("list", { name: "Recent imports" });
  await expect(importsList).toContainText("Csv import");
  await expect(importsList).toContainText(
    "10 accepted · 2 rejected · 12 total",
  );

  const analyses = page.getByRole("list", { name: "Recent analyses" });
  await expect(analyses).toContainText("OpenAI · gpt-5-mini");
  await expect(analyses).toContainText("Louvain Community");
  await expect(analyses).toContainText("Pagerank");
  const analysisLabels = await analyses
    .locator("li > div > div:first-child > p:first-child")
    .allTextContents();
  expect(analysisLabels.slice(0, 3)).toEqual([
    "Louvain Community",
    "Pagerank",
    "OpenAI · gpt-5-mini",
  ]);

  const defaults = page.locator(
    'section[aria-labelledby="workspace-defaults-heading"]',
  );
  await expect(defaults).toContainText("90 days");
  await expect(defaults).toContainText("AI analysisEnabled");
  await expect(defaults).toContainText("File storageDisabled");
  await expect(
    page.getByRole("list", { name: "Workspace activity" }),
  ).toContainText("Dashboard Acceptance Completed");

  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations,
    axe.violations.map(({ id, help }) => `${id}: ${help}`).join("\n"),
  ).toEqual([]);
  await browser.assertNoLeakage();
  browser.assertNoFailures();
});

test("viewer gets a read-only, visibility-scoped dashboard without owner or private AI material", async ({
  context,
  page,
}) => {
  const browser = monitorBrowser(page);
  await authenticate(context, viewer.jar);
  await page.goto("/dashboard");

  await expect(page.getByText("Signed in as Viewer.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Add person" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage policies" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: "View audit log" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: "Start an import" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: "Open graph analysis" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open AI analyst" }),
  ).toBeVisible();

  const peopleList = page.getByRole("list", {
    name: "Recently updated people",
  });
  const peopleLabels = await peopleList.getByRole("link").allTextContents();
  expect(peopleLabels.slice(0, 2)).toEqual([
    "Dashboard Newest Visible",
    "Dashboard Older Visible",
  ]);
  await expect(peopleList).not.toContainText(sentinels.hiddenPerson);
  await expect(page.getByText("Visible people").locator("..")).toContainText(
    "3",
  );
  await expect(
    page.getByText("Visible relationships").locator(".."),
  ).toContainText("1");
  await expect(
    page.getByRole("list", { name: "Recent analyses" }),
  ).not.toContainText("gpt-5-mini");
  await expect(
    page.getByText("Activity is managed by workspace administrators."),
  ).toBeVisible();

  await browser.assertNoLeakage();
  browser.assertNoFailures();
});

test("an empty workspace presents explicit empty states and usable keyboard focus", async ({
  context,
  page,
}) => {
  const browser = monitorBrowser(page);
  await authenticate(context, emptyOwner.jar);
  await page.goto("/dashboard");

  await expect(page.getByText("No people have been added yet.")).toBeVisible();
  await expect(
    page.getByText("No imports have been started yet."),
  ).toBeVisible();
  await expect(page.getByText("No analyses have been run yet.")).toBeVisible();
  await expect(
    page.getByText("No workspace activity has been recorded yet."),
  ).toBeVisible();
  await expect(page.getByText("Visible people").locator("..")).toContainText(
    "0",
  );
  await expect(
    page.getByText("Visible relationships").locator(".."),
  ).toContainText("0");

  await page.locator("body").focus();
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press("Tab");
    if (
      await page
        .locator("#main-content")
        .getByRole("link", { name: "Add person" })
        .evaluate((node) => node === document.activeElement)
    )
      break;
  }
  await expect(
    page.locator("#main-content").getByRole("link", { name: "Add person" }),
  ).toBeFocused();
  await browser.assertNoLeakage();
  browser.assertNoFailures();
});

test("dashboard reflows at narrow and 400-percent-equivalent widths in RTL with reduced motion", async ({
  browser,
}) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { height: 844, width: 390 },
  });
  await authenticate(context, owner.jar);
  const page = await context.newPage();
  const monitored = monitorBrowser(page);
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Research dashboard" }),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.lang = "ar";
    document.querySelector("#main-content")?.setAttribute("dir", "rtl");
  });

  for (const width of [390, 320]) {
    await page.setViewportSize({ height: 844, width });
    const overflow = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      offenders: [...document.querySelectorAll("body *")]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < -1 || box.right > window.innerWidth + 1;
        })
        .slice(0, 8)
        .map((element) => `${element.tagName}.${element.className}`),
    }));
    expect(
      overflow.overflow,
      `dashboard overflowed at ${width}px: ${overflow.offenders.join(" | ")}`,
    ).toBe(false);
  }
  await expect(page.locator("#main-content")).toHaveAttribute("dir", "rtl");
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await expect(page.getByText(longName)).toBeVisible();
  await monitored.assertNoLeakage();
  monitored.assertNoFailures();
  await context.close();
});
