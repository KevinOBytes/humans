// @vitest-environment node

import IORedis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GraphPageDocument } from "@/graphql/generated/graphql";
import { OperationLimiter } from "@/graphql/operation-limiter";
import { createPerformanceDiagnosticSignature } from "@/graphql/query-instrumentation";
import { LocalRedisStore } from "@/lib/redis";

import { expectGraphQLError, GraphQLFixture } from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const redisUrl = process.env.REDIS_TEST_URL ?? process.env.TEST_REDIS_URL;

liveDescribe("GraphQL security boundaries", () => {
  let boundaryFixture: GraphQLFixture;

  beforeAll(() => {
    boundaryFixture = new GraphQLFixture();
  });

  beforeEach(async () => boundaryFixture.reset());
  afterAll(async () => boundaryFixture.close());

  it("fails closed for malformed browser origins, cookies, and request bodies", async () => {
    const actor = await boundaryFixture.createSessionActor();
    const malformedOrigins = [
      "http://127.0.0.1:3106%00",
      "http://127.0.0.1:3106.evil.example",
      "http://127.0.0.1:3106:80",
      "null",
    ];

    for (const origin of malformedOrigins) {
      const result = await boundaryFixture.execute({
        jar: actor.jar,
        origin,
        query: "query { viewer { id } }",
      });
      expectGraphQLError(result, "FORBIDDEN");
      expect(result.status).toBe(403);
    }

    const malformedCookieHeaders = [
      "better-auth.session_token=%ZZ",
      "better-auth.session_token=valid%00",
      "better-auth.session_token=valid; better-auth.session_token=",
    ];
    for (const cookie of malformedCookieHeaders) {
      const request = new Request(
        new URL("/api/graphql", "http://127.0.0.1:3106"),
        {
          body: JSON.stringify({ query: "query { viewer { id } }" }),
          headers: {
            cookie,
            "content-type": "application/json",
            origin: "http://127.0.0.1:3106",
            "sec-fetch-site": "same-origin",
          },
          method: "POST",
        },
      );
      const result = await boundaryFixture.executeRequest(request);
      expectGraphQLError(result, "UNAUTHENTICATED");
      expect(result.status).toBe(401);
    }

    const malformedBody = await boundaryFixture.execute({
      body: '{"query":"query { viewer { id } }"',
      jar: actor.jar,
    });
    expectGraphQLError(malformedBody, "VALIDATION_FAILED");
    expect(malformedBody.status).toBe(400);
    expect(malformedBody.body?.errors?.[0]?.message).not.toContain("viewer");
  });

  it("rejects malformed API-key header boundaries before authentication", async () => {
    for (const apiKey of ["", "hum_valid,hum_other", "x".repeat(513)]) {
      const result = await boundaryFixture.execute({
        headers: { "x-api-key": apiKey },
        origin: null,
        query: "query { viewer { id } }",
      });
      expectGraphQLError(result, "UNAUTHENTICATED");
      expect(result.status).toBe(401);
    }
  });
});

const redisDescribe =
  process.env.TEST_DATABASE_URL && redisUrl ? describe : describe.skip;

redisDescribe("GraphQL Redis-backed operation budgets", () => {
  let fixture: GraphQLFixture;
  let redis: IORedis;
  const diagnosticSecret =
    "graphql-security-boundary-diagnostic-secret-2026-isolated";

  beforeAll(async () => {
    redis = new IORedis(redisUrl!, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
    });
    await redis.ping();
    fixture = new GraphQLFixture({
      databaseQueryDiagnostics: {
        enabled: true,
        isolatedTestRuntime: true,
        secret: diagnosticSecret,
      },
      operationLimiter: new OperationLimiter(
        new LocalRedisStore(redis),
        { log: () => undefined },
        "7a".repeat(32),
      ),
    });
  });

  beforeEach(async () => {
    await fixture.reset();
    await redis.flushdb();
  });

  afterAll(async () => {
    await fixture.close();
    await redis.quit();
  });

  it("enforces the real graph.read operation class before resolver work", async () => {
    const actor = await fixture.createSessionActor();
    const diagnosticHeaders = {
      "x-humans-performance": "graph-reference-v1",
      "x-humans-performance-principal": actor.principalId,
      "x-humans-performance-signature": createPerformanceDiagnosticSignature(
        actor.principalId,
        diagnosticSecret,
      ),
    };
    const results = [];

    for (let attempt = 0; attempt < 7; attempt += 1) {
      results.push(
        await fixture.execute({
          headers: diagnosticHeaders,
          jar: actor.jar,
          operationName: "GraphPage",
          query: GraphPageDocument,
          variables: {
            filter: {
              edgeLimit: 1,
              mode: "WORKSPACE",
              nodeLimit: 1,
            },
          },
        }),
      );
    }

    for (const result of results.slice(0, 6)) {
      expect(result.body?.errors).toBeUndefined();
      expect(result.body?.data?.graph).toBeDefined();
    }
    const denied = results[6];
    if (!denied) throw new Error("Missing final graph budget result");
    expectGraphQLError(denied, "RATE_LIMITED");
    expect(denied.body?.data?.graph).toBeNull();
    const allowedQueryCount = Number(
      results[0]?.headers.get("x-humans-db-query-count"),
    );
    const deniedQueryCount = Number(
      denied.headers.get("x-humans-db-query-count"),
    );
    expect(Number.isSafeInteger(allowedQueryCount)).toBe(true);
    expect(Number.isSafeInteger(deniedQueryCount)).toBe(true);
    expect(deniedQueryCount).toBeLessThan(allowedQueryCount);

    const keys = await redis.keys("humans:operation-limit:v2:*");
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(actor.principalId);
    expect(keys[0]).not.toContain(actor.workspaceId);
  });
});
