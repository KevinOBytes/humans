import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("representative performance budget contract", () => {
  it("keeps the opt-in production graph reference workload and thresholds reviewable", () => {
    const packageJson = read("package.json");
    const harness = read("tests/performance/graph-performance.spec.ts");
    const playwright = read("playwright.config.ts");

    expect(packageJson).toContain('"test:performance:graph"');
    expect(packageJson).toContain("GRAPH_PERFORMANCE=1");
    expect(playwright).toContain('"corepack pnpm build && PORT=3106');
    expect(harness).toContain('GRAPH_PERFORMANCE !== "1"');
    expect(harness).toContain("10_000");
    expect(harness).toContain("25_000");
    expect(harness).toContain("concurrentActors.push");
    expect(harness).toContain("index < 20");
    expect(harness).toContain("expect(p95Ms).toBeLessThanOrEqual(500)");
    expect(harness).toContain("toBeLessThanOrEqual(3_000)");
    expect(harness).toContain(
      "expect(afterRenderFps).toBeGreaterThanOrEqual(30)",
    );
    expect(harness).toContain("INITIAL_ROUTE_JS_BUDGET = 250 * 1024");
    expect(harness).toContain("graph-api-performance.json");
    expect(harness).toContain("graph-render-performance.json");
    expect(harness).toContain("graph-route-javascript.json");
  });

  it("records the bounded evidence and does not misrepresent unmeasured upload or Web Vitals budgets", () => {
    const requirements = read("docs/REQUIREMENTS.md");
    const release = read("docs/releases/SELF_HOSTED_ALPHA.md");
    const runbook = read("docs/releases/PERFORMANCE_RUNBOOK.md");
    const todo = read("TODO.md");

    expect(requirements).toContain("HUM-NFR-020");
    expect(requirements).toContain(
      "Repeatable latency, concurrency, Web Vitals",
    );
    expect(release).toContain("Current representative performance harness");
    expect(release).toContain("upload-path latency");
    expect(release).toContain("Web Vitals");
    expect(release).toMatch(/mutation p95 at or\s+below 750 ms/i);
    for (const target of [
      "PostgreSQL 18",
      "Redis",
      "MinIO",
      "8 physical CPU cores",
      "32 GiB RAM",
      "ALLOW_TEST_DATABASE_RESET=true",
      "graph-api-performance.json",
      "graph-render-performance.json",
      "graph-route-javascript.json",
      "authenticated mutations",
      "750 ms",
    ]) {
      expect(runbook).toContain(target);
    }
    expect(todo).toMatch(/^- \[ \] `HUM-NFR-020`/m);
  });
});
