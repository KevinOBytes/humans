// @vitest-environment node

import { apiKeys } from "@/db/schema/auth";
import { canonicalizeTrustedOrigins } from "@/graphql/context";
import { ViewerDocument } from "@/graphql/generated/graphql";
import { createPerformanceDiagnosticSignature } from "@/graphql/query-instrumentation";
import { defaultKeyHasher } from "@better-auth/api-key";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  GraphQLFixture,
  VIEWER_QUERY,
  expectGraphQLError,
} from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("GraphQL authentication context", () => {
  let fixture: GraphQLFixture;

  beforeAll(() => {
    fixture = new GraphQLFixture();
  });
  beforeEach(async () => fixture.reset());
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => fixture.close());

  it("rejects unauthenticated viewer queries", async () => {
    expectGraphQLError(
      await fixture.execute({ query: VIEWER_QUERY }),
      "UNAUTHENTICATED",
    );
    expectGraphQLError(
      await fixture.execute({
        headers: { cookie: "unrelated=value" },
        query: `query Viewer($apiKey: String) { viewer { id } }`,
        variables: { apiKey: "hum_not-a-header" },
      }),
      "UNAUTHENTICATED",
    );
  });

  it("resolves a real session actor and its server-selected active workspace", async () => {
    const actor = await fixture.createSessionActor({ name: "Session Tenant" });
    const result = await fixture.execute<{
      viewer: {
        actorType: string;
        id: string;
        permissions: string[];
        role: string;
        workspace: { id: string; name: string };
      };
      workspace: { id: string };
    }>({ jar: actor.jar, query: ViewerDocument });

    expect(result.status).toBe(200);
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data).toMatchObject({
      viewer: {
        actorType: "USER",
        id: actor.userId,
        role: "owner",
        workspace: { id: actor.workspaceId, name: "Session Tenant" },
      },
      workspace: { id: actor.workspaceId },
    });
    expect(result.body?.data?.viewer.permissions).toContain(
      "graphql:introspect",
    );
  });

  it("emits SQL diagnostics only for a signed authenticated test principal", async () => {
    const secret = "isolated-performance-secret-with-sufficient-entropy";
    const diagnosticFixture = new GraphQLFixture({
      databaseQueryDiagnostics: {
        enabled: true,
        isolatedTestRuntime: true,
        secret,
      },
    });
    try {
      await diagnosticFixture.reset();
      const actor = await diagnosticFixture.createSessionActor();
      const baseHeaders = {
        "x-humans-performance": "graph-reference-v1",
        "x-humans-performance-principal": actor.principalId,
      };

      const absent = await diagnosticFixture.execute({
        jar: actor.jar,
        query: VIEWER_QUERY,
      });
      expect(absent.headers.get("x-humans-db-query-count")).toBeNull();

      const spoofed = await diagnosticFixture.execute({
        headers: {
          ...baseHeaders,
          "x-humans-performance-signature": "0".repeat(64),
        },
        jar: actor.jar,
        query: VIEWER_QUERY,
      });
      expect(spoofed.headers.get("x-humans-db-query-count")).toBeNull();

      const other = await diagnosticFixture.createSessionActor({
        name: "Other diagnostic principal",
      });
      const crossPrincipal = await diagnosticFixture.execute({
        headers: {
          ...baseHeaders,
          "x-humans-performance-signature":
            createPerformanceDiagnosticSignature(actor.principalId, secret),
        },
        jar: other.jar,
        query: VIEWER_QUERY,
      });
      expect(crossPrincipal.headers.get("x-humans-db-query-count")).toBeNull();

      const unauthenticated = await diagnosticFixture.execute({
        headers: {
          ...baseHeaders,
          "x-humans-performance-signature":
            createPerformanceDiagnosticSignature(actor.principalId, secret),
        },
        query: VIEWER_QUERY,
      });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("x-humans-db-query-count")).toBeNull();

      const signed = await diagnosticFixture.execute({
        headers: {
          ...baseHeaders,
          "x-humans-performance-signature":
            createPerformanceDiagnosticSignature(actor.principalId, secret),
        },
        jar: actor.jar,
        query: VIEWER_QUERY,
      });
      expect(signed.body?.errors).toBeUndefined();
      expect(
        Number(signed.headers.get("x-humans-db-query-count")),
      ).toBeGreaterThan(0);
    } finally {
      await diagnosticFixture.close();
    }
  });

  it("resolves a real organization API key without a browser origin", async () => {
    const actor = await fixture.createSessionActor();
    const key = await fixture.provisionKey(actor, {
      fact: ["read"],
      person: ["read"],
    });
    const result = await fixture.execute<{
      viewer: {
        actorType: string;
        id: string;
        permissions: string[];
        role: null;
      };
      workspace: { id: string };
    }>({ apiKey: key.key, origin: null });

    expect(result.status).toBe(200);
    expect(result.body?.data).toMatchObject({
      viewer: {
        actorType: "API_KEY",
        id: key.id,
        permissions: ["fact:read", "person:read"],
        role: null,
      },
      workspace: { id: actor.workspaceId },
    });
  });

  it("rejects a session cookie combined with an API key", async () => {
    const actor = await fixture.createSessionActor();
    const key = await fixture.provisionKey(actor);
    expectGraphQLError(
      await fixture.execute({ apiKey: key.key, jar: actor.jar }),
      "UNAUTHENTICATED",
    );
  });

  it("rejects an invalid session and oversized or duplicate API-key headers", async () => {
    const invalidSession = await fixture.execute({
      headers: {
        cookie: "better-auth.session_token=not-a-session",
        origin: "http://127.0.0.1:3106",
        "sec-fetch-site": "same-origin",
      },
    });
    expectGraphQLError(invalidSession, "UNAUTHENTICATED");

    for (const apiKey of ["x".repeat(513), "é".repeat(300), "first, second"]) {
      expectGraphQLError(
        await fixture.execute({ apiKey, origin: null }),
        "UNAUTHENTICATED",
      );
    }
  });

  it("rejects invalid, expired, disabled, and deleted API keys", async () => {
    const actor = await fixture.createSessionActor();
    const invalid = await fixture.execute({
      apiKey: "hum_invalid",
      origin: null,
    });
    expectGraphQLError(invalid, "UNAUTHENTICATED");

    for (const state of ["expired", "disabled", "deleted"] as const) {
      const key = await fixture.provisionKey(actor);
      if (state === "expired") {
        await fixture.database
          .update(apiKeys)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(apiKeys.id, key.id));
      } else if (state === "disabled") {
        await fixture.database
          .update(apiKeys)
          .set({ enabled: false })
          .where(eq(apiKeys.id, key.id));
      } else {
        await fixture.database.delete(apiKeys).where(eq(apiKeys.id, key.id));
      }
      expectGraphQLError(
        await fixture.execute({ apiKey: key.key, origin: null }),
        "UNAUTHENTICATED",
      );
    }
  });

  it("rejects sessions with no active organization or current membership", async () => {
    const noActive = await fixture.createSessionActor();
    await fixture.clearActiveOrganization(noActive);
    expectGraphQLError(
      await fixture.execute({ jar: noActive.jar }),
      "PRECONDITION_FAILED",
    );

    const offboarded = await fixture.createSessionActor();
    await fixture.removeMembership(offboarded);
    expectGraphQLError(
      await fixture.execute({ jar: offboarded.jar }),
      "PRECONDITION_FAILED",
    );
  });

  it("does not let a global administrator bypass workspace membership", async () => {
    const owner = await fixture.createSessionActor();
    const administrator = await fixture.createUser({
      email: "global-admin@example.test",
      globalRole: "admin",
      username: "GlobalAdmin",
    });
    const result = await fixture.execute({
      headers: { "x-workspace-id": owner.workspaceId },
      jar: administrator.jar,
      variables: { workspaceId: owner.workspaceId },
    });
    expectGraphQLError(result, "PRECONDITION_FAILED");
  });

  it("enforces trusted origins for sessions and supplied API-key origins", async () => {
    const actor = await fixture.createSessionActor();
    expectGraphQLError(
      await fixture.execute({ jar: actor.jar, origin: null }),
      "FORBIDDEN",
    );
    expectGraphQLError(
      await fixture.execute({
        jar: actor.jar,
        origin: "https://attacker.example",
      }),
      "FORBIDDEN",
    );
    expectGraphQLError(
      await fixture.execute({
        headers: { "sec-fetch-site": "cross-site" },
        jar: actor.jar,
        origin: new URL("http://127.0.0.1:3106").origin,
      }),
      "FORBIDDEN",
    );

    const key = await fixture.provisionKey(actor);
    expect(
      (await fixture.execute({ apiKey: key.key, origin: null })).status,
    ).toBe(200);
    expectGraphQLError(
      await fixture.execute({
        apiKey: key.key,
        origin: "https://attacker.example",
      }),
      "FORBIDDEN",
    );

    for (const origin of [
      "http://127.0.0.1:3106/",
      "http://127.0.0.1:3106/path",
      "http://127.0.0.1:3106?query=yes",
      "http://user:password@127.0.0.1:3106",
      "HTTP://127.0.0.1:3106",
      "not an origin",
    ]) {
      expectGraphQLError(
        await fixture.execute({ apiKey: key.key, origin }),
        "FORBIDDEN",
      );
    }
  });

  it("canonicalizes configured HTTP URLs and de-duplicates origins deterministically", () => {
    expect(
      canonicalizeTrustedOrigins([
        "HTTP://EXAMPLE.TEST:80/config/path",
        "https://B.EXAMPLE.TEST:443/anything?query=yes",
        "http://example.test/another-path",
        "HTTPS://b.example.test/#fragment",
        "ftp://example.test/path",
        "http://user:password@example.test/path",
      ]),
    ).toEqual(["http://example.test", "https://b.example.test"]);
  });

  it("trusts the canonical origin of a configured URL with a path", async () => {
    const canonicalFixture = new GraphQLFixture({
      trustedOrigins: [
        "  HTTP://127.0.0.1:3106/config/path  ",
        "http://127.0.0.1:3106/duplicate",
      ],
    });
    try {
      await canonicalFixture.reset();
      const actor = await canonicalFixture.createSessionActor();
      const result = await canonicalFixture.execute({
        jar: actor.jar,
        origin: "http://127.0.0.1:3106",
      });
      expect(result.status).toBe(200);
      expect(result.body?.errors).toBeUndefined();
    } finally {
      await canonicalFixture.close();
    }
  });

  it("classifies a real API-key adapter outage as masked internal without log disclosure", async () => {
    const outageFixture = new GraphQLFixture();
    await outageFixture.reset();
    const actor = await outageFixture.createSessionActor();
    const key = await outageFixture.provisionKey(actor);
    const keyHash = await defaultKeyHasher(key.key);
    const databasePassword = decodeURIComponent(
      new URL(process.env.TEST_DATABASE_URL!).password,
    );
    const consoleEvents: unknown[][] = [];
    for (const method of ["error", "warn", "log"] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        consoleEvents.push(values);
      });
    }

    await outageFixture.connection.end();
    const result = await outageFixture.execute({
      apiKey: key.key,
      origin: null,
    });

    expect(result.status).toBe(500);
    expectGraphQLError(result, "INTERNAL");
    const logs = [...outageFixture.capturedLogs, ...consoleEvents]
      .flat()
      .map((value) =>
        value instanceof Error
          ? `${value.name}:${value.message}:${value.stack ?? ""}`
          : JSON.stringify(value),
      )
      .join("\n");
    expect(logs).not.toContain(key.key);
    expect(logs).not.toContain(keyHash);
    expect(logs).not.toContain(databasePassword);
    expect(logs).not.toMatch(
      /failed query|select .*api[_ ]?key|parameters?:/iu,
    );
  });

  it("permits trusted unauthenticated CORS preflight", async () => {
    const result = await fixture.execute({
      headers: {
        "access-control-request-headers": "content-type,x-api-key",
        "access-control-request-method": "POST",
      },
      method: "OPTIONS",
      origin: "http://127.0.0.1:3106",
    });
    expect(result.status).toBe(204);
    expect(result.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:3106",
    );
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/iu);
  });
});
