// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { testAdminEnv } from "../support/auth";

const requestIds = [
  "A4E128F2-C057-43E9-BF32-7B0E30CC2CF1",
  "78F8B3AE-2DF4-45D4-8383-6E88E01F4466",
];

const cases = [
  { route: "graphql", method: "POST", failed: 500, recovered: 401 },
  { route: "auth/get-session", method: "GET", failed: 503, recovered: 401 },
  { route: "storage/objects", method: "GET", failed: 503, recovered: 401 },
] as const;

describe("production route loader recovery", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/env/server");
    vi.doUnmock("@/db/client");
    vi.doUnmock("@/modules/auth/auth");
    vi.doUnmock("@/lib/observability/security-events");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each(cases)(
    "$route evicts failed initialization, shares concurrent work, and retains recovered authorization",
    async ({ route, method, failed, recovered }) => {
      // A retained rejected production promise makes the recovered batch fail;
      // removing successful caching makes the initialization count exceed two.
      let initializationAttempts = 0;
      const log = vi.fn();
      vi.resetModules();
      vi.spyOn(console, "error").mockImplementation(log);
      vi.doMock("@/lib/env/server", () => ({
        getServerEnv: () => {
          initializationAttempts += 1;
          if (initializationAttempts === 1) {
            throw new Error("initialization password=private-provider-secret");
          }
          return testAdminEnv;
        },
      }));
      // These are the external persistence/session boundaries. Keep the real
      // GraphQL handler, storage grant validation and auth request decoration.
      vi.doMock("@/db/client", () => ({
        db: new Proxy(
          {},
          {
            get: () => {
              throw new Error("unauthorized database access");
            },
          },
        ),
      }));
      vi.doMock("@/modules/auth/auth", () => ({
        auth: {
          api: { getSession: async () => null },
          handler: async () =>
            Response.json({ code: "UNAUTHORIZED" }, { status: 401 }),
        },
        createHumansAuth: () => {
          throw new Error("unexpected auth creation");
        },
      }));
      vi.doMock("@/lib/observability/security-events", () => ({
        productionSecurityEventLogger: { log },
      }));

      const handle =
        route === "graphql"
          ? (await import("@/app/api/graphql/route")).POST
          : route === "auth/get-session"
            ? (await import("@/app/api/auth/[...all]/route")).GET
            : (await import("@/app/api/storage/objects/route")).GET;
      const request = (id: string) =>
        new Request(`http://127.0.0.1:3106/api/${route}`, {
          method,
          headers: {
            "x-request-id": id,
            ...(method === "POST"
              ? {
                  "content-type": "application/json",
                  "x-graphql-yoga-csrf": "1",
                }
              : {}),
          },
          ...(method === "POST"
            ? { body: JSON.stringify({ query: "{ viewer { id } }" }) }
            : {}),
        });

      const failures = await Promise.all(
        requestIds.map((id) => handle(request(id))),
      );
      expect(initializationAttempts).toBe(1);
      for (const [index, response] of failures.entries()) {
        expect(response.status).toBe(failed);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-request-id")).toBe(
          requestIds[index].toLowerCase(),
        );
        const body = await response.text();
        expect(body).toContain(requestIds[index].toLowerCase());
        expect(body).not.toContain("private-provider-secret");
        expect(JSON.parse(body)).toMatchObject(
          route === "graphql"
            ? { errors: [{ extensions: { code: "INTERNAL" } }] }
            : {
                code:
                  route === "auth/get-session"
                    ? "AUTH_SERVICE_UNAVAILABLE"
                    : "INTERNAL",
              },
        );
      }
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "private-provider-secret",
      );

      const recoveredResponses = await Promise.all(
        requestIds.map((id) => handle(request(id))),
      );
      for (const [index, response] of recoveredResponses.entries()) {
        expect(response.status).toBe(recovered);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-request-id")).toBe(
          requestIds[index].toLowerCase(),
        );
        expect(JSON.parse(await response.text())).toMatchObject(
          route === "graphql"
            ? { errors: [{ extensions: { code: "UNAUTHENTICATED" } }] }
            : { code: "UNAUTHORIZED" },
        );
      }
      expect(initializationAttempts).toBe(2);
      expect((await handle(request(requestIds[0]))).status).toBe(recovered);
      expect(initializationAttempts).toBe(2);
    },
  );
});
