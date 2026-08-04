import { describe, expect, it } from "vitest";

import { OperationLimiter } from "@/graphql/operation-limiter";
import type {
  RedisStore,
  TokenBucketInput,
  TokenBucketResult,
} from "@/lib/redis";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";
import { createSavedQueryService } from "@/modules/search/saved-query";

const actorId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7001";
const principalId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7002";
const memberId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7003";
const workspaceId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7004";
const savedQueryId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7005";

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
    )
      throw new Error("redis://private:secret@example.test");
    if (
      (this.outcome === "ACTOR_DENIED" && call === 1) ||
      (this.outcome === "CLIENT_DENIED" && call === 2)
    )
      return { allowed: false, remainingMicrotokens: 0, retryAfterMs: 1_000 };
    return {
      allowed: true,
      remainingMicrotokens: (input.capacity - input.cost) * 1_000_000,
      retryAfterMs: 0,
    };
  }
}

function serviceFor(outcome: ConstructorParameters<typeof ControlledStore>[0]) {
  let databaseReads = 0;
  const database = new Proxy(
    {},
    {
      get() {
        databaseReads += 1;
        throw new Error(
          "Saved-query run touched the database before its budgets passed.",
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
    requestId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7006",
    workspaceId,
  });
  return {
    databaseReads: () => databaseReads,
    events,
    service: createSavedQueryService(
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
        operationLimiter: limiter,
        permissions: new Set([
          "savedQuery:read",
          "savedQuery:run",
          "search:read",
          "search:run",
          "person:read",
        ]),
        requestId: "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7006",
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        workspaceId,
      },
      { cursorHmacKey: "45".repeat(32) },
      async () => {
        throw new Error("Search execution must not start.");
      },
    ),
    store,
  };
}

describe("Task 12 saved-query operation budgets", () => {
  it.each(["ACTOR_DENIED", "CLIENT_DENIED"] as const)(
    "fails closed on %s with zero database work",
    async (outcome) => {
      const fixture = serviceFor(outcome);
      await expect(fixture.service.run(savedQueryId)).rejects.toMatchObject({
        extensions: { code: "RATE_LIMITED" },
      });
      expect(fixture.store.calls).toHaveLength(
        outcome === "ACTOR_DENIED" ? 1 : 2,
      );
      expect(fixture.databaseReads()).toBe(0);
    },
  );

  it.each(["ACTOR_OUTAGE", "CLIENT_OUTAGE"] as const)(
    "fails closed and redacts %s with zero database work",
    async (outcome) => {
      const fixture = serviceFor(outcome);
      await expect(fixture.service.run(savedQueryId)).rejects.toMatchObject({
        extensions: { code: "PROVIDER_UNAVAILABLE" },
      });
      expect(fixture.store.calls).toHaveLength(
        outcome === "ACTOR_OUTAGE" ? 1 : 2,
      );
      expect(fixture.databaseReads()).toBe(0);
      expect(JSON.stringify(fixture.events)).not.toMatch(
        /redis:|private|secret|203\.0\.113/u,
      );
    },
  );
});
