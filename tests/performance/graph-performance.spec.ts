import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import IORedis from "ioredis";

import { newId } from "@/db/id";
import { graphViews } from "@/db/schema/graph";
import { people } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { GraphPageDocument } from "@/graphql/generated/graphql";
import { createPerformanceDiagnosticSignature } from "@/graphql/query-instrumentation";

import type { CookieJar } from "../support/auth";
import { ResearchFixture } from "../support/research-fixture";

test.skip(
  process.env.GRAPH_PERFORMANCE !== "1",
  "Set GRAPH_PERFORMANCE=1 for the opt-in production 10k/25k reference run.",
);
test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const BASE_URL = "http://127.0.0.1:3106";
const INITIAL_ROUTE_JS_BUDGET = 250 * 1024;
const COLD_AUTHENTICATED_SQL_QUERY_BUDGET = 24;
const PERFORMANCE_DIAGNOSTIC_SECRET =
  "graph-reference-diagnostic-secret-2026-isolated-runtime";
const fixture = new ResearchFixture();
let actor: Awaited<ReturnType<ResearchFixture["createActor"]>>;
let concurrentActors: Array<
  Awaited<ReturnType<ResearchFixture["createWorkspaceMember"]>>
> = [];
let viewId = "";

function personId(index: number) {
  return `018f1000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function relationshipId(index: number) {
  return `018f2000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

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

type GraphApiSample = {
  bytes: number;
  durationMs: number;
  edgeCount: number;
  nodeCount: number;
  queryCount: number;
};

async function sampleGraphApi(
  request: APIRequestContext,
  filter: { nodeLimit: number; edgeLimit: number },
  principalId: string,
): Promise<GraphApiSample> {
  const started = performance.now();
  const response = await request.post("/api/graphql", {
    data: {
      query: GraphPageDocument.toString(),
      variables: {
        filter: {
          mode: "WORKSPACE",
          nodeLimit: filter.nodeLimit,
          edgeLimit: filter.edgeLimit,
          includeIsolates: false,
        },
      },
    },
    headers: {
      origin: BASE_URL,
      "x-humans-performance": "graph-reference-v1",
      "x-humans-performance-principal": principalId,
      "x-humans-performance-signature": createPerformanceDiagnosticSignature(
        principalId,
        PERFORMANCE_DIAGNOSTIC_SECRET,
      ),
    },
  });
  const durationMs = performance.now() - started;
  const body = await response.body();
  const payload = JSON.parse(body.toString("utf8")) as {
    data?: { graph?: { edges?: unknown[]; nodes?: unknown[] } };
    errors?: unknown[];
  };
  expect(response.ok(), JSON.stringify(payload.errors ?? [])).toBe(true);
  expect(payload.errors).toBeUndefined();
  const queryCount = Number(response.headers()["x-humans-db-query-count"]);
  expect(Number.isSafeInteger(queryCount)).toBe(true);
  expect(queryCount).toBeGreaterThan(0);
  return {
    bytes: body.byteLength,
    durationMs,
    edgeCount: payload.data?.graph?.edges?.length ?? -1,
    nodeCount: payload.data?.graph?.nodes?.length ?? -1,
    queryCount,
  };
}

function percentile95(samples: readonly number[]) {
  const ordered = [...samples].sort((left, right) => left - right);
  return (
    ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  );
}

async function encodedRouteJavaScript(page: Page, path: string) {
  await page.goto(path, { waitUntil: "networkidle" });
  return page.evaluate(() => {
    const resources = performance.getEntriesByType(
      "resource",
    ) as PerformanceResourceTiming[];
    const scripts = resources.filter(
      (entry) =>
        entry.initiatorType === "script" &&
        new URL(entry.name).pathname.includes("/_next/static/"),
    );
    return {
      bytes: scripts.reduce(
        (total, entry) => total + (entry.encodedBodySize || entry.transferSize),
        0,
      ),
      urls: scripts.map((entry) => entry.name),
    };
  });
}

async function measureAuthenticatedRoute(
  browser: Browser,
  path: string,
  heading: string,
) {
  const context = await browser.newContext();
  await authenticate(context, actor.jar);
  const page = await context.newPage();
  const result = await encodedRouteJavaScript(page, path);
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await context.close();
  return result;
}

test.beforeAll(async () => {
  if (process.env.TEST_REDIS_URL) {
    const redis = new IORedis(process.env.TEST_REDIS_URL, {
      maxRetriesPerRequest: 0,
    });
    await redis.flushdb();
    await redis.quit();
  }
  await fixture.reset();
  actor = await fixture.createActor();
  concurrentActors = [];
  for (let index = 0; index < 20; index += 1) {
    concurrentActors.push(await fixture.createWorkspaceMember(actor, "viewer"));
  }
  const typeId = "018f3000-0000-7000-8000-000000000001";
  for (let start = 1; start <= 10_000; start += 500) {
    await fixture.database.insert(people).values(
      Array.from({ length: Math.min(500, 10_001 - start) }, (_, offset) => {
        const index = start + offset;
        return {
          id: personId(index),
          workspaceId: actor.workspaceId,
          displayName: `Reference Person ${index.toString().padStart(5, "0")}`,
          sortName: index.toString().padStart(5, "0"),
          sensitivity: "internal" as const,
          createdBy: actor.principalId,
          updatedBy: actor.principalId,
        };
      }),
    );
  }
  await fixture.database.insert(relationshipTypes).values({
    id: typeId,
    workspaceId: actor.workspaceId,
    key: "reference_edge",
    forwardLabel: "connected to",
    inverseLabel: "connected to",
    directed: false,
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
  for (let start = 1; start <= 25_000; start += 500) {
    await fixture.database.insert(relationships).values(
      Array.from({ length: Math.min(500, 25_001 - start) }, (_, offset) => {
        const index = start + offset;
        const sourceIndex = ((index - 1) % 10_000) + 1;
        const candidateTarget = ((index * 7 + 17) % 10_000) + 1;
        const targetIndex =
          candidateTarget === sourceIndex
            ? (candidateTarget % 10_000) + 1
            : candidateTarget;
        return {
          id: relationshipId(index),
          workspaceId: actor.workspaceId,
          sourcePersonId: personId(sourceIndex),
          targetPersonId: personId(targetIndex),
          relationshipTypeId: typeId,
          sensitivity: "internal" as const,
          createdBy: actor.principalId,
          updatedBy: actor.principalId,
        };
      }),
    );
  }
  viewId = newId();
  await fixture.database.insert(graphViews).values({
    id: viewId,
    workspaceId: actor.workspaceId,
    ownerId: actor.userId,
    name: "10k reference",
    filters: {
      mode: "WORKSPACE",
      rootPersonIds: [],
      depth: 0,
      relationshipTypeIds: [],
      relationshipStates: [],
      sensitivities: [],
      minimumConfidence: null,
      at: null,
      from: null,
      until: null,
      nodeLimit: 10_000,
      edgeLimit: 25_000,
      includeIsolates: false,
    },
    layout: {
      version: "graph-layout-v1",
      algorithm: "CIRCLE",
      settings: {
        barnesHutOptimize: true,
        gravity: 1,
        scalingRatio: 2,
        slowDown: 4,
      },
    },
    appearance: {
      version: "graph-appearance-v1",
      palette: "DEFAULT",
      showLabels: true,
    },
    sharing: "private",
    createdBy: actor.principalId,
    updatedBy: actor.principalId,
  });
});

test.afterAll(async () => fixture.close());

test("production GraphQL reports p95, response bytes, and bounded SQL query count", async ({
  browser,
  context,
  page,
}, testInfo) => {
  await authenticate(context, actor.jar);
  const full = await sampleGraphApi(
    page.request,
    {
      nodeLimit: 10_000,
      edgeLimit: 25_000,
    },
    actor.principalId,
  );
  expect(full.nodeCount).toBe(10_000);
  expect(full.edgeCount).toBe(25_000);
  expect(full.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(full.queryCount).toBeLessThanOrEqual(12);

  const loadContexts: BrowserContext[] = [];
  let samples: GraphApiSample[];
  try {
    for (const loadActor of concurrentActors) {
      const loadContext = await browser.newContext();
      await authenticate(loadContext, loadActor.jar);
      loadContexts.push(loadContext);
    }
    samples = await Promise.all(
      loadContexts.map((loadContext, index) =>
        sampleGraphApi(
          loadContext.request,
          {
            nodeLimit: 100,
            edgeLimit: 400,
          },
          concurrentActors[index]!.principalId,
        ),
      ),
    );
  } finally {
    await Promise.all(loadContexts.map((loadContext) => loadContext.close()));
  }
  const p95Ms = percentile95(samples.map((sample) => sample.durationMs));
  const maxQueryCount = Math.max(...samples.map((sample) => sample.queryCount));
  const maxBytes = Math.max(...samples.map((sample) => sample.bytes));
  await testInfo.attach("graph-api-performance.json", {
    body: Buffer.from(
      JSON.stringify({ concurrent: { maxBytes, maxQueryCount, p95Ms }, full }),
    ),
    contentType: "application/json",
  });
  testInfo.annotations.push({
    type: "graph-api-performance",
    description: JSON.stringify({
      concurrent: { maxBytes, maxQueryCount, p95Ms },
      full,
    }),
  });
  expect(p95Ms).toBeLessThanOrEqual(500);
  expect(maxQueryCount).toBeLessThanOrEqual(
    COLD_AUTHENTICATED_SQL_QUERY_BUDGET,
  );
  expect(maxBytes).toBeLessThanOrEqual(512 * 1024);
});

test("exact 10k/25k graph marks transform and first Sigma render, sustains camera FPS, and recovers WebGL", async ({
  context,
  page,
}, testInfo) => {
  await authenticate(context, actor.jar);
  await page.goto(`/graph?view=${viewId}`, { waitUntil: "domcontentloaded" });
  const headingVisible = await page
    .getByRole("heading", { name: "Social graph" })
    .waitFor({ state: "visible" })
    .then(
      () => true,
      () => false,
    );
  const exactNodeCountVisible = await page
    .getByText("10000 people loaded", { exact: true })
    .waitFor({ state: "visible" })
    .then(
      () => true,
      () => false,
    );
  const exactEdgeCountVisible = await page
    .getByText("25000 relationships loaded", { exact: true })
    .waitFor({ state: "visible" })
    .then(
      () => true,
      () => false,
    );
  const canvas = page.locator(".sigma-container canvas").first();
  const canvasVisible = await canvas.waitFor({ state: "visible" }).then(
    () => true,
    () => false,
  );

  const renderMarks = await page.evaluate(() => {
    const mark = (name: string) =>
      performance.getEntriesByName(name, "mark").at(-1)?.startTime ?? -1;
    return {
      firstSigma: mark("humans:graph-sigma-first-render"),
      transformEnd: mark("humans:graph-transform-end"),
      transformStart: mark("humans:graph-transform-start"),
    };
  });
  type PerformanceProbe = {
    camera: { angle: number; ratio: number; x: number; y: number };
    firstVisualEdgeCount?: number;
    firstVisualNodeCount?: number;
    fullDetailRestoredAt?: number;
    lastFrameAt: number;
    motionDetailActive: boolean;
    motionDetailSampledAt?: number;
    motionDetailStartedAt?: number;
    motionInputStartedAt?: number;
    rendererFrames: number;
    visualEdgeCount: number;
    visualNodeCount: number;
  };
  const readProbe = () =>
    page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __HUMANS_GRAPH_PERFORMANCE__?: PerformanceProbe;
          }
        ).__HUMANS_GRAPH_PERFORMANCE__ ?? null,
    );
  const probeAvailable = await page
    .waitForFunction(() =>
      Boolean(
        (
          globalThis as typeof globalThis & {
            __HUMANS_GRAPH_PERFORMANCE__?: PerformanceProbe;
          }
        ).__HUMANS_GRAPH_PERFORMANCE__,
      ),
    )
    .then(
      () => true,
      () => false,
    );
  const initialFullDetailRestored = await page
    .waitForFunction(
      () => {
        const probe = (
          globalThis as typeof globalThis & {
            __HUMANS_GRAPH_PERFORMANCE__?: PerformanceProbe;
          }
        ).__HUMANS_GRAPH_PERFORMANCE__;
        return (
          typeof probe?.fullDetailRestoredAt === "number" &&
          probe.visualEdgeCount === 25_000 &&
          probe.visualNodeCount === 10_000
        );
      },
      undefined,
      { timeout: 15_000 },
    )
    .then(
      () => true,
      () => false,
    );
  const initialDetailProbe = await readProbe();
  const initialProbe = await readProbe();
  const interactionStart = performance.now();
  const cameraDrive = await page.evaluate(() => {
    const performanceGlobal = globalThis as typeof globalThis & {
      __HUMANS_GRAPH_PERFORMANCE_DRIVER__?: (input: {
        duration: number;
        ratioFactor: number;
        xDelta: number;
        yDelta: number;
      }) => void;
      __HUMANS_GRAPH_PERFORMANCE_PREPARE_MOTION__?: () => void;
    };
    const driver = performanceGlobal.__HUMANS_GRAPH_PERFORMANCE_DRIVER__;
    if (!driver) {
      return {
        cameraDriven: false,
        prepareMotionHookPresent: Boolean(
          performanceGlobal.__HUMANS_GRAPH_PERFORMANCE_PREPARE_MOTION__,
        ),
      };
    }
    driver({
      duration: 1_800,
      ratioFactor: 0.72,
      xDelta: 0.08,
      yDelta: 0.05,
    });
    return {
      cameraDriven: true,
      prepareMotionHookPresent: Boolean(
        performanceGlobal.__HUMANS_GRAPH_PERFORMANCE_PREPARE_MOTION__,
      ),
    };
  });
  const motionDetailReached = await page
    .waitForFunction(
      () => {
        const probe = (
          globalThis as typeof globalThis & {
            __HUMANS_GRAPH_PERFORMANCE__?: PerformanceProbe;
          }
        ).__HUMANS_GRAPH_PERFORMANCE__;
        return (
          probe?.motionDetailActive === true &&
          probe.visualEdgeCount === 0 &&
          probe.visualNodeCount === 100
        );
      },
      undefined,
      { timeout: 10_000 },
    )
    .then(
      () => true,
      () => false,
    );
  const motionProbe = await readProbe();
  await page.waitForTimeout(1_900);
  const interactionElapsedMs = performance.now() - interactionStart;
  const finalProbe = await readProbe();
  const afterRenderFrames =
    initialProbe && finalProbe
      ? finalProbe.rendererFrames - initialProbe.rendererFrames
      : -1;
  const afterRenderFps = (afterRenderFrames * 1_000) / interactionElapsedMs;
  const inputLatencyMs =
    typeof motionProbe?.motionInputStartedAt === "number" &&
    typeof motionProbe.motionDetailSampledAt === "number"
      ? motionProbe.motionDetailSampledAt - motionProbe.motionInputStartedAt
      : -1;
  const cameraDelta = {
    ratio:
      initialProbe && finalProbe
        ? Math.abs(finalProbe.camera.ratio - initialProbe.camera.ratio)
        : -1,
    x:
      initialProbe && finalProbe
        ? Math.abs(finalProbe.camera.x - initialProbe.camera.x)
        : -1,
    y:
      initialProbe && finalProbe
        ? Math.abs(finalProbe.camera.y - initialProbe.camera.y)
        : -1,
  };
  const memory = await page.evaluate(
    () =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } })
        .memory?.usedJSHeapSize ?? null,
  );
  const frameSample = {
    cameraDelta,
    inputLatencyMs,
    interactionElapsedMs,
    memory,
    afterRenderFps,
    afterRenderFrames,
  };
  const fullDetailRestored = await page
    .waitForFunction(
      () => {
        const probe = (
          globalThis as typeof globalThis & {
            __HUMANS_GRAPH_PERFORMANCE__?: PerformanceProbe;
          }
        ).__HUMANS_GRAPH_PERFORMANCE__;
        return (
          probe?.motionDetailActive === false &&
          probe.visualEdgeCount === 25_000 &&
          probe.visualNodeCount === 10_000
        );
      },
      undefined,
      { timeout: 15_000 },
    )
    .then(
      () => true,
      () => false,
    );
  const restoredProbe = await readProbe();
  const framesBeforeContextLoss =
    restoredProbe?.rendererFrames ?? finalProbe?.rendererFrames ?? -1;

  const lostWithExtension = await page
    .locator(".sigma-container canvas")
    .evaluateAll((canvases) => {
      for (const canvas of canvases) {
        const element = canvas as HTMLCanvasElement;
        const context =
          element.getContext("webgl2") ?? element.getContext("webgl");
        const extension = context?.getExtension("WEBGL_lose_context");
        if (!extension) continue;
        const performanceGlobal = globalThis as typeof globalThis & {
          __HUMANS_WEBGL_CONTEXT_LOSS_EVENTS__?: number;
          __HUMANS_WEBGL_LOSS_EXTENSION__?: WEBGL_lose_context;
        };
        performanceGlobal.__HUMANS_WEBGL_CONTEXT_LOSS_EVENTS__ = 0;
        element.addEventListener(
          "webglcontextlost",
          () => {
            performanceGlobal.__HUMANS_WEBGL_CONTEXT_LOSS_EVENTS__ =
              (performanceGlobal.__HUMANS_WEBGL_CONTEXT_LOSS_EVENTS__ ?? 0) + 1;
          },
          { once: true },
        );
        (
          globalThis as typeof globalThis & {
            __HUMANS_WEBGL_LOSS_EXTENSION__?: WEBGL_lose_context;
          }
        ).__HUMANS_WEBGL_LOSS_EXTENSION__ = extension;
        extension.loseContext();
        return true;
      }
      return false;
    });
  const retry = page.getByRole("button", { name: "Retry WebGL" });
  const retryVisible = await retry.waitFor({ state: "visible" }).then(
    () => true,
    () => false,
  );
  const contextLossEventObserved = await page
    .waitForFunction(
      () =>
        ((
          globalThis as typeof globalThis & {
            __HUMANS_WEBGL_CONTEXT_LOSS_EVENTS__?: number;
          }
        ).__HUMANS_WEBGL_CONTEXT_LOSS_EVENTS__ ?? 0) > 0,
      undefined,
      { timeout: 10_000 },
    )
    .then(
      () => true,
      () => false,
    );
  const restoredWithExtension = await page.evaluate(() => {
    const performanceGlobal = globalThis as typeof globalThis & {
      __HUMANS_WEBGL_LOSS_EXTENSION__?: WEBGL_lose_context;
    };
    const extension = performanceGlobal.__HUMANS_WEBGL_LOSS_EXTENSION__;
    if (!extension) return false;
    extension.restoreContext();
    delete performanceGlobal.__HUMANS_WEBGL_LOSS_EXTENSION__;
    return true;
  });
  const retryClicked = retryVisible
    ? await retry.click().then(
        () => true,
        () => false,
      )
    : false;
  const canvasRestored = await page
    .locator(".sigma-container canvas")
    .first()
    .waitFor({ state: "visible" })
    .then(
      () => true,
      () => false,
    );
  const rendererAdvancedAfterRestore = await page
    .waitForFunction(
      (minimumFrames) => {
        const probe = (
          globalThis as typeof globalThis & {
            __HUMANS_GRAPH_PERFORMANCE__?: PerformanceProbe;
          }
        ).__HUMANS_GRAPH_PERFORMANCE__;
        return (probe?.rendererFrames ?? -1) > minimumFrames;
      },
      framesBeforeContextLoss,
      { timeout: 15_000 },
    )
    .then(
      () => true,
      () => false,
    );
  const postRestoreProbe = await readProbe();
  const contextRecovery = {
    canvasRestored,
    contextLossEventObserved,
    framesAfterRestore: postRestoreProbe?.rendererFrames ?? -1,
    framesBeforeContextLoss,
    lostWithExtension,
    rendererAdvancedAfterRestore,
    restoredWithExtension,
    retryClicked,
    retryVisible,
  };
  const exactRestore = {
    motionDetailActive: restoredProbe?.motionDetailActive ?? null,
    reached: fullDetailRestored,
    visualEdgeCount: restoredProbe?.visualEdgeCount ?? -1,
    visualNodeCount: restoredProbe?.visualNodeCount ?? -1,
  };
  const readiness = {
    canvasVisible,
    exactEdgeCountVisible,
    exactNodeCountVisible,
    headingVisible,
    initialFullDetailRestored,
    motionDetailReached,
    probeAvailable,
    prepareMotionHookPresent: cameraDrive.prepareMotionHookPresent,
  };
  const measurements = {
    contextRecovery,
    exactRestore,
    frameSample,
    initialDetailProbe,
    readiness,
    renderMarks,
  };
  await testInfo.attach("graph-render-performance.json", {
    body: Buffer.from(JSON.stringify(measurements)),
    contentType: "application/json",
  });
  testInfo.annotations.push({
    type: "graph-render-performance",
    description: JSON.stringify(measurements),
  });

  expect(readiness).toMatchObject({
    canvasVisible: true,
    exactEdgeCountVisible: true,
    exactNodeCountVisible: true,
    headingVisible: true,
    motionDetailReached: true,
    probeAvailable: true,
    initialFullDetailRestored: true,
  });
  expect(renderMarks.transformStart).toBeGreaterThanOrEqual(0);
  expect(
    renderMarks.transformEnd - renderMarks.transformStart,
  ).toBeLessThanOrEqual(2_000);
  expect(renderMarks.firstSigma).toBeGreaterThan(renderMarks.transformEnd);
  expect(renderMarks.firstSigma).toBeLessThanOrEqual(3_000);
  expect(initialDetailProbe?.firstVisualNodeCount).toBeGreaterThan(0);
  expect(initialDetailProbe?.firstVisualNodeCount).toBeLessThanOrEqual(100);
  expect(initialDetailProbe?.firstVisualEdgeCount).toBeGreaterThan(0);
  expect(initialDetailProbe?.fullDetailRestoredAt).toBeGreaterThan(
    renderMarks.firstSigma,
  );
  expect(initialProbe).not.toBeNull();
  expect(finalProbe).not.toBeNull();
  expect(cameraDrive.cameraDriven).toBe(true);
  expect(readiness.prepareMotionHookPresent).toBe(false);
  expect(motionProbe?.motionInputStartedAt).toBeGreaterThan(0);
  expect(motionProbe?.motionDetailStartedAt).toBeGreaterThanOrEqual(
    motionProbe?.motionInputStartedAt ?? Number.POSITIVE_INFINITY,
  );
  expect(motionProbe?.motionDetailSampledAt).toBeGreaterThanOrEqual(
    motionProbe?.motionDetailStartedAt ?? Number.POSITIVE_INFINITY,
  );
  expect(inputLatencyMs).toBeGreaterThanOrEqual(0);
  expect(inputLatencyMs).toBeLessThanOrEqual(750);
  expect(interactionElapsedMs).toBeGreaterThanOrEqual(1_500);
  expect(afterRenderFrames).toBeGreaterThanOrEqual(30);
  expect(afterRenderFps).toBeGreaterThanOrEqual(30);
  expect(cameraDelta.ratio).toBeGreaterThan(0.001);
  expect(cameraDelta.x > 0.001 || cameraDelta.y > 0.001).toBe(true);
  if (frameSample.memory !== null) {
    expect(frameSample.memory).toBeLessThan(512 * 1024 * 1024);
  }
  expect(exactRestore).toEqual({
    motionDetailActive: false,
    reached: true,
    visualEdgeCount: 25_000,
    visualNodeCount: 10_000,
  });
  expect(contextRecovery).toMatchObject({
    canvasRestored: true,
    contextLossEventObserved: true,
    lostWithExtension: true,
    rendererAdvancedAfterRestore: true,
    restoredWithExtension: true,
    retryClicked: true,
    retryVisible: true,
  });
});

test("public, dashboard, people, and editor route boundaries stay inside compressed JavaScript budgets", async ({
  browser,
}, testInfo) => {
  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  const publicRoute = await encodedRouteJavaScript(publicPage, "/");
  await expect(
    publicPage.getByRole("heading", { name: "Humans" }),
  ).toBeVisible();
  await publicContext.close();

  const dashboard = await measureAuthenticatedRoute(
    browser,
    "/dashboard",
    "Research dashboard",
  );
  const peopleRoute = await measureAuthenticatedRoute(
    browser,
    "/people",
    "People",
  );
  for (const route of [publicRoute, dashboard, peopleRoute]) {
    expect(route.urls.length).toBeGreaterThan(0);
    expect(route.bytes).toBeLessThanOrEqual(INITIAL_ROUTE_JS_BUDGET);
  }

  const editorContext = await browser.newContext();
  await authenticate(editorContext, actor.jar);
  const editorPage = await editorContext.newPage();
  await editorPage.goto(`/graph?view=${viewId}`, { waitUntil: "networkidle" });
  const before = new Set(
    await editorPage.evaluate(() =>
      (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .filter((entry) => entry.initiatorType === "script")
        .map((entry) => entry.name),
    ),
  );
  await editorPage
    .getByRole("button", { name: /Details for Reference Person/u })
    .first()
    .click();
  await editorPage
    .getByRole("button", { name: "Edit selected neighborhood" })
    .click();
  await expect(
    editorPage.getByRole("dialog", { name: "Edit neighborhood" }),
  ).toBeVisible();
  const editorChunk = await editorPage.evaluate(
    (known) => {
      const previous = new Set(known);
      return (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      )
        .filter(
          (entry) =>
            entry.initiatorType === "script" && !previous.has(entry.name),
        )
        .reduce(
          (total, entry) =>
            total + (entry.encodedBodySize || entry.transferSize),
          0,
        );
    },
    [...before],
  );
  expect(editorChunk).toBeGreaterThan(0);
  expect(editorChunk).toBeLessThanOrEqual(INITIAL_ROUTE_JS_BUDGET);
  await testInfo.attach("graph-route-javascript.json", {
    body: Buffer.from(
      JSON.stringify({ dashboard, editorChunk, peopleRoute, publicRoute }),
    ),
    contentType: "application/json",
  });
  testInfo.annotations.push({
    type: "graph-route-javascript",
    description: JSON.stringify({
      dashboardBytes: dashboard.bytes,
      editorChunk,
      peopleBytes: peopleRoute.bytes,
      publicBytes: publicRoute.bytes,
    }),
  });
  await editorContext.close();
});
