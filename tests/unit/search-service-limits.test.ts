import { describe, expect, it } from "vitest";

import type { Database } from "@/modules/auth/bootstrap-admin";
import { OperationLimiter } from "@/graphql/operation-limiter";
import type {
  RedisStore,
  TokenBucketInput,
  TokenBucketResult,
} from "@/lib/redis";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import {
  createTask12Metrics,
  disabledMetricsSink,
  type MetricsSink,
} from "@/modules/search/metrics";
import {
  buildSearchSnippet,
  createSearchService,
} from "@/modules/search/service";

const actorId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7001";
const principalId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7002";
const memberId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7003";
const workspaceId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7004";

class ControlledStore {
  readonly calls: TokenBucketInput[] = [];
  constructor(
    private readonly outcome:
      "ACTOR_DENIED" | "CLIENT_DENIED" | "ACTOR_OUTAGE" | "CLIENT_OUTAGE",
  ) {}

  async consumeTokenBucket(
    input: TokenBucketInput,
  ): Promise<TokenBucketResult> {
    this.calls.push(input);
    const call = this.calls.length;
    if (
      (this.outcome === "ACTOR_OUTAGE" && call === 1) ||
      (this.outcome === "CLIENT_OUTAGE" && call === 2)
    ) {
      throw new Error("redis://private-user:private-password@example.test");
    }
    if (
      (this.outcome === "ACTOR_DENIED" && call === 1) ||
      (this.outcome === "CLIENT_DENIED" && call === 2)
    ) {
      return { allowed: false, remainingMicrotokens: 0, retryAfterMs: 1_000 };
    }
    return {
      allowed: true,
      remainingMicrotokens: (input.capacity - input.cost) * 1_000_000,
      retryAfterMs: 0,
    };
  }
}

function createDeniedService(
  outcome: ConstructorParameters<typeof ControlledStore>[0],
) {
  let databaseReads = 0;
  const database = new Proxy(
    {},
    {
      get() {
        databaseReads += 1;
        throw new Error(
          "Search touched the database before its budgets passed.",
        );
      },
    },
  ) as Database;
  const events: unknown[] = [];
  const store = new ControlledStore(outcome);
  const limiter = new OperationLimiter(
    store as Pick<RedisStore, "consumeTokenBucket">,
    { log: (event) => events.push(event) },
    "59".repeat(32),
  ).forRequest({
    actor: { id: actorId, principalId, type: "user" },
    clientAddress: {
      family: 4,
      prefix: "203.0.113.0/24",
      source: "vercel",
      trust: "trusted",
    },
    requestId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7005",
    workspaceId,
  });
  const metricCalls: unknown[] = [];
  const metrics = createTask12Metrics({
    increment: (...args) => metricCalls.push(["increment", ...args]),
    observe: (...args) => metricCalls.push(["observe", ...args]),
  } satisfies MetricsSink);
  const service = createSearchService(
    {
      actor: {
        type: "user",
        id: actorId,
        principalId,
        sessionId: "session",
        memberId,
        role: "owner",
      },
      database,
      metrics,
      operationLimiter: limiter,
      permissions: new Set(["search:read", "person:read"]),
      requestId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7005",
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId,
    },
    {
      cursorHmacKey: "45".repeat(32),
      protectedLookupHmacKey: "43".repeat(32),
    },
  );
  return {
    databaseReads: () => databaseReads,
    events,
    metricCalls,
    service,
    store,
  };
}

const searchInput = {
  version: 1,
  match: { type: "text", query: "bounded" },
  kinds: ["PERSON"],
  filters: {},
  first: 10,
};

describe("Task 12 search operation budgets", () => {
  it.each(["ACTOR_DENIED", "CLIENT_DENIED"] as const)(
    "fails closed on %s without database work",
    async (outcome) => {
      const fixture = createDeniedService(outcome);
      await expect(fixture.service.search(searchInput)).rejects.toMatchObject({
        extensions: { code: "RATE_LIMITED" },
      });
      expect(fixture.store.calls).toHaveLength(
        outcome === "ACTOR_DENIED" ? 1 : 2,
      );
      expect(fixture.databaseReads()).toBe(0);
      expect(JSON.stringify(fixture.metricCalls)).not.toMatch(
        /bounded|203\.0\.113|018f5c90/u,
      );
      expect(fixture.metricCalls).toContainEqual([
        "increment",
        "search_requests_total",
        { mode: "TEXT", outcome: "DENIED" },
        1,
      ]);
    },
  );

  it.each(["ACTOR_OUTAGE", "CLIENT_OUTAGE"] as const)(
    "fails closed and redacts %s without database work",
    async (outcome) => {
      const fixture = createDeniedService(outcome);
      await expect(fixture.service.search(searchInput)).rejects.toMatchObject({
        extensions: { code: "PROVIDER_UNAVAILABLE" },
      });
      expect(fixture.store.calls).toHaveLength(
        outcome === "ACTOR_OUTAGE" ? 1 : 2,
      );
      expect(fixture.databaseReads()).toBe(0);
      expect(JSON.stringify(fixture.events)).not.toMatch(
        /redis:|private|203\.0\.113/u,
      );
      expect(JSON.stringify(fixture.metricCalls)).not.toMatch(
        /bounded|203\.0\.113|018f5c90/u,
      );
    },
  );

  it("maps a PostgreSQL statement timeout to a neutral provider error", async () => {
    const database = {
      transaction: async (
        callback: (transaction: Database) => Promise<unknown>,
      ) =>
        callback({
          execute: async () => {
            throw Object.assign(new Error("query leaked secret contents"), {
              code: "57014",
            });
          },
        } as unknown as Database),
    } as unknown as Database;
    const service = createSearchService(
      {
        actor: {
          type: "user",
          id: actorId,
          principalId,
          sessionId: "session",
          memberId,
          role: "owner",
        },
        database,
        metrics: createTask12Metrics(disabledMetricsSink),
        operationLimiter: {
          consume: async () => ({
            allowed: true,
            remainingMicrotokens: 1,
            retryAfterMs: 0,
          }),
        },
        permissions: new Set(["search:read", "person:read"]),
        requestId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7005",
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        workspaceId,
      },
      {
        cursorHmacKey: "45".repeat(32),
        protectedLookupHmacKey: "43".repeat(32),
      },
    );

    const error = await service.search(searchInput).catch((value) => value);
    expect(error).toMatchObject({
      extensions: { code: "PROVIDER_UNAVAILABLE" },
      message: "A required provider is unavailable.",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  });
});

describe("Task 12 structured snippets", () => {
  it.each([
    ["alpha beta", ["alpha", "beta"]],
    ["alpha -beta", ["alpha"]],
    ['"alpha beta" -"gamma delta"', ["alpha", "beta"]],
    ["alpha OR beta -gamma", ["alpha", "beta"]],
    ["Ångström OR 東京 -秘密", ["Ångström", "東京"]],
  ])("highlights only positive terms for %s", (query, expected) => {
    const parts = buildSearchSnippet(
      "alpha beta gamma delta Ångström 東京 秘密",
      query,
    );
    expect(
      parts.filter(({ matched }) => matched).map(({ text }) => text),
    ).toEqual(expected);
  });

  it("preserves original UTF-16 ranges when case folding expands", () => {
    const text = "İstanbul research";
    const parts = buildSearchSnippet(text, "İstanbul");
    expect(parts.map(({ text: part }) => part).join("")).toBe(text);
    expect(parts).toEqual([
      { text: "İstanbul", matched: true },
      { text: " research", matched: false },
    ]);
  });

  it('highlights quoted "or" while excluding bare Boolean OR', () => {
    expect(buildSearchSnippet("or token", '"or"')).toEqual([
      { text: "or", matched: true },
      { text: " token", matched: false },
    ]);
    expect(buildSearchSnippet("alpha or beta", "alpha or beta")).toEqual([
      { text: "alpha", matched: true },
      { text: " or ", matched: false },
      { text: "beta", matched: true },
    ]);
  });
});
