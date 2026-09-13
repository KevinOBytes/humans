// @vitest-environment node

import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = [
  { path: "account/invitations/accept", allowed: ["POST"] },
  { path: "account/invitations/handoff", allowed: ["DELETE", "GET", "POST"] },
  { path: "account/two-factor/disable", allowed: ["POST"] },
  { path: "auth/[...all]", allowed: ["DELETE", "GET", "PATCH", "POST", "PUT"] },
  { path: "graphql", allowed: ["GET", "POST"] },
  { path: "health/live", allowed: ["GET"] },
  { path: "health/ready", allowed: ["GET"] },
  { path: "jobs/run", allowed: ["GET"] },
  { path: "storage/objects", allowed: ["GET", "PUT"] },
  { path: "storage/objects/[...path]", allowed: ["GET", "PUT"] },
];
const methods = ["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"];
const correlationId = "a4e128f2-c057-43e9-bf32-7b0e30cc2cf1";
type Route = Record<string, (request: Request) => Response | Promise<Response>>;
const loaders: Record<string, () => Promise<unknown>> = {
  "account/invitations/accept": () =>
    import("@/app/api/account/invitations/accept/route"),
  "account/invitations/handoff": () =>
    import("@/app/api/account/invitations/handoff/route"),
  "account/two-factor/disable": () =>
    import("@/app/api/account/two-factor/disable/route"),
  "auth/[...all]": () => import("@/app/api/auth/[...all]/route"),
  graphql: () => import("@/app/api/graphql/route"),
  "health/live": () => import("@/app/api/health/live/route"),
  "health/ready": () => import("@/app/api/health/ready/route"),
  "jobs/run": () => import("@/app/api/jobs/run/route"),
  "storage/objects": () => import("@/app/api/storage/objects/route"),
  "storage/objects/[...path]": () =>
    import("@/app/api/storage/objects/[...path]/route"),
};

describe("complete direct route method boundary", () => {
  it("inventories every API route so new routes require explicit coverage", () => {
    expect(globSync("src/app/api/**/route.ts").sort()).toEqual(
      routes.map(({ path }) => `src/app/api/${path}/route.ts`).sort(),
    );
  });

  for (const { path, allowed } of routes) {
    const advertised = [
      ...allowed,
      ...(allowed.includes("GET") ? ["HEAD"] : []),
      "OPTIONS",
    ].sort();
    for (const method of methods.filter(
      (method) => !advertised.includes(method),
    )) {
      it(`${path} ${method} fails closed with a redacted correlated 405`, async () => {
        const route = (await loaders[path]()) as Route;
        expect(route[method]).toBeTypeOf("function");
        const response = await route[method](
          new Request(`https://humans.example/api/${path}`, {
            method,
            headers: {
              "x-request-id": correlationId.toUpperCase(),
              authorization: "Bearer private-secret",
            },
          }),
        );
        expect(response.status).toBe(405);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-request-id")).toBe(correlationId);
        expect(response.headers.get("allow")?.split(", ").sort()).toEqual(
          path === "graphql" ? ["OPTIONS", "POST"] : advertised,
        );
        if (method === "HEAD") {
          expect(await response.text()).toBe("");
        } else {
          const body = await response.json();
          expect(JSON.stringify(body)).not.toContain("private-secret");
          expect(
            path === "graphql" ? body.errors[0].extensions : body,
          ).toMatchObject({
            code:
              path === "graphql" ? "VALIDATION_FAILED" : "METHOD_NOT_ALLOWED",
            requestId: correlationId,
          });
        }
      });
    }

    if (path !== "graphql") {
      it(`${path} OPTIONS preserves method discovery without dependencies or CORS grants`, async () => {
        const route = (await loaders[path]()) as Route;
        expect(route.OPTIONS).toBeTypeOf("function");
        const response = await route.OPTIONS(
          new Request(`https://humans.example/api/${path}`, {
            method: "OPTIONS",
            headers: {
              "x-request-id": "private-invalid-id",
              origin: "https://untrusted.example",
            },
          }),
        );
        expect(response.status).toBe(204);
        expect(response.headers.get("allow")?.split(", ").sort()).toEqual(
          advertised,
        );
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-request-id")).toMatch(
          /^[0-9a-f-]{36}$/u,
        );
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
        expect(await response.text()).toBe("");
      });
    }
  }
});
