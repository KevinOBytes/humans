// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createSchemaBuilder } from "@/graphql/builder";
import type { GraphQLContext } from "@/graphql/context";
import {
  OperationLimiter,
  type OperationLimitPolicy,
} from "@/graphql/operation-limiter";
import type {
  RedisStore,
  TokenBucketInput,
  TokenBucketResult,
} from "@/lib/redis";

import {
  expectGraphQLError,
  GraphQLFixture,
  type GraphQLResponseBody,
} from "../support/graphql";

const policy: OperationLimitPolicy = {
  capacity: 2,
  refillAmount: 2,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
};

class ControlledBucketStore {
  readonly calls: TokenBucketInput[] = [];
  error: Error | undefined;
  errorAtCall: number | undefined;
  readonly results: TokenBucketResult[] = [];
  result: TokenBucketResult = {
    allowed: true,
    remainingMicrotokens: 1_000_000,
    retryAfterMs: 0,
  };

  async consumeTokenBucket(input: TokenBucketInput) {
    this.calls.push(input);
    if (
      this.error &&
      (!this.errorAtCall || this.calls.length === this.errorAtCall)
    ) {
      throw this.error;
    }
    return this.results.shift() ?? this.result;
  }
}

function createLimitedSchema(onWork: (context: GraphQLContext) => string) {
  const builder = createSchemaBuilder();
  builder.queryType({
    fields: (t) => ({
      cheapActor: t.string({
        resolve: (_root, _args, context) => context.actor.type,
      }),
      limitedResearch: t.string({
        resolve: async (_root, _args, context) => {
          await context.operationLimiter.consume({
            clientPolicy: policy,
            cost: 1,
            operationClass: "research.expensive",
            policy,
          });
          return onWork(context);
        },
      }),
    }),
  });
  return builder.toSchema();
}

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("GraphQL operation limiter context", () => {
  const limiterEvents: unknown[] = [];
  const store = new ControlledBucketStore();
  let fixture: GraphQLFixture;
  let workCount = 0;

  beforeAll(() => {
    fixture = new GraphQLFixture({
      clientAddressConfig: { deploymentMode: "vercel", mode: "vercel" },
      operationLimiter: new OperationLimiter(
        store as Pick<RedisStore, "consumeTokenBucket">,
        { log: (event) => limiterEvents.push(event) },
        "59".repeat(32),
      ),
      schema: createLimitedSchema((context) => {
        workCount += 1;
        return context.actor.type;
      }),
    });
  });

  beforeEach(async () => {
    await fixture.reset();
    store.calls.length = 0;
    store.error = undefined;
    store.errorAtCall = undefined;
    store.results.length = 0;
    store.result = {
      allowed: true,
      remainingMicrotokens: 1_000_000,
      retryAfterMs: 0,
    };
    limiterEvents.length = 0;
    workCount = 0;
  });

  afterAll(async () => fixture.close());

  it("consumes only after session and stored API-key authentication resolve", async () => {
    const actor = await fixture.createSessionActor();
    const invalid = await fixture.execute({
      headers: {
        "x-forwarded-for": "10.0.0.1",
        "x-vercel-forwarded-for": "203.0.113.10",
      },
      query: "query { limitedResearch }",
    });
    expectGraphQLError(invalid, "UNAUTHENTICATED");
    expect(store.calls).toEqual([]);

    const session = await fixture.execute<{ limitedResearch: string }>({
      headers: {
        "x-forwarded-for": "10.0.0.1",
        "x-vercel-forwarded-for": "203.0.113.10",
      },
      jar: actor.jar,
      query: "query { limitedResearch }",
    });
    expect(session.body).toEqual({ data: { limitedResearch: "user" } });
    const sameSession = await fixture.execute<{ limitedResearch: string }>({
      headers: {
        "x-forwarded-for": "10.0.0.2",
        "x-vercel-forwarded-for": "203.0.113.30",
      },
      jar: actor.jar,
      query: "query { limitedResearch }",
    });
    expect(sameSession.body).toEqual({ data: { limitedResearch: "user" } });

    const apiKey = await fixture.provisionKey(actor);
    const api = await fixture.execute<{ limitedResearch: string }>({
      apiKey: apiKey.key,
      headers: {
        "x-forwarded-for": "10.0.0.3",
        "x-vercel-forwarded-for": "198.51.100.20",
      },
      origin: null,
      query: "query { limitedResearch }",
    });
    expect(api.body).toEqual({ data: { limitedResearch: "apiKey" } });
    expect(store.calls).toHaveLength(6);
    expect(store.calls[0]?.key).toMatch(
      /^humans:operation-limit:v2:[a-f0-9]{64}$/u,
    );
    expect(store.calls[2]?.key).toBe(store.calls[0]?.key);
    expect(store.calls[3]?.key).toBe(store.calls[1]?.key);
    expect(store.calls[4]?.key).toMatch(
      /^humans:operation-limit:v2:[a-f0-9]{64}$/u,
    );
    expect(store.calls[4]?.key).not.toBe(store.calls[0]?.key);
    expect(store.calls[5]?.key).not.toBe(store.calls[1]?.key);
    expect(JSON.stringify(store.calls)).not.toMatch(
      /203\.0\.113\.10|192\.0\.2\.30|198\.51\.100\.20|hum_/u,
    );
    expect(workCount).toBe(3);
  });

  it("spends the primary budget then stops resolver work on client denial", async () => {
    const actor = await fixture.createSessionActor();
    store.results.push(
      {
        allowed: true,
        remainingMicrotokens: 1_000_000,
        retryAfterMs: 0,
      },
      { allowed: false, remainingMicrotokens: 0, retryAfterMs: 30_000 },
    );

    const result = await fixture.execute({
      headers: { "x-vercel-forwarded-for": "203.0.113.10" },
      jar: actor.jar,
      query: "query { limitedResearch }",
    });

    expectGraphQLError(result, "RATE_LIMITED");
    expect(result.body?.errors?.[0]?.extensions).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 30_000,
    });
    expect(store.calls).toHaveLength(2);
    expect(workCount).toBe(0);
  });

  it("fails closed before resolver work when the client bucket provider fails", async () => {
    const actor = await fixture.createSessionActor();
    store.error = new Error("redis://private client prefix secret");
    store.errorAtCall = 2;

    const result = await fixture.execute({
      headers: { "x-vercel-forwarded-for": "2001:db8::1" },
      jar: actor.jar,
      query: "query { limitedResearch }",
    });

    expectGraphQLError(result, "PROVIDER_UNAVAILABLE");
    expect(store.calls).toHaveLength(2);
    expect(workCount).toBe(0);
    expect(JSON.stringify(limiterEvents)).not.toMatch(/private|redis:|2001:/u);
  });

  it("stops resolver work with request-correlated RATE_LIMITED on exhaustion", async () => {
    const actor = await fixture.createSessionActor();
    store.result = {
      allowed: false,
      remainingMicrotokens: 0,
      retryAfterMs: 30_000,
    };
    const requestId = "0198f27a-87e8-7fc6-b82f-97db38e9a694";

    const result = await fixture.execute({
      headers: { "x-request-id": requestId },
      jar: actor.jar,
      query: "query { limitedResearch }",
    });

    expectGraphQLError(result, "RATE_LIMITED");
    expect(result.requestId).toBe(requestId);
    expect(result.body?.errors?.[0]?.message).toBe("Too many requests.");
    expect(result.body?.errors?.[0]?.extensions).toMatchObject({
      code: "RATE_LIMITED",
      requestId,
      retryAfterMs: 30_000,
    });
    expect(workCount).toBe(0);
  });

  it("stops resolver work and redacts provider outages", async () => {
    const actor = await fixture.createSessionActor();
    store.error = new Error("redis://user:password@private raw-api-key");
    const requestId = "0198f27b-d63e-726b-801c-dc751c05390d";

    const result = await fixture.execute({
      headers: { "x-request-id": requestId },
      jar: actor.jar,
      query: "query { limitedResearch }",
    });

    expectGraphQLError(result, "PROVIDER_UNAVAILABLE");
    expect(result.body?.errors?.[0]?.message).toBe(
      "A required provider is unavailable.",
    );
    expect(workCount).toBe(0);
    expect(limiterEvents).toEqual([
      {
        event: "graphql.operation_limiter.unavailable",
        requestId,
        severity: "error",
      },
    ]);
    expect(JSON.stringify(limiterEvents)).not.toMatch(
      /password|private|raw-api-key|redis:/iu,
    );
  });

  it("does not contact Redis for cheap fields", async () => {
    const actor = await fixture.createSessionActor();
    store.error = new Error("Redis unavailable");

    const result = await fixture.execute<{ cheapActor: string }>({
      jar: actor.jar,
      query: "query { cheapActor }",
    });

    expect(result.body as GraphQLResponseBody).toEqual({
      data: { cheapActor: "user" },
    });
    expect(store.calls).toEqual([]);
    expect(limiterEvents).toEqual([]);
  });
});
