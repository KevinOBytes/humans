import { createHmac } from "node:crypto";
import { GraphQLError } from "graphql";
import { describe, expect, it } from "vitest";

import {
  OperationLimiter,
  operationLimitKeyV2,
  type OperationLimitPolicy,
} from "@/graphql/operation-limiter";
import type { ClientAddressClassification } from "@/lib/network/client-address";
import type {
  RedisStore,
  TokenBucketInput,
  TokenBucketResult,
} from "@/lib/redis";

const policy: OperationLimitPolicy = {
  capacity: 10,
  refillAmount: 10,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
};
const operationLimitHmacKey = "64".repeat(32);

class RecordingBucketStore {
  readonly calls: TokenBucketInput[] = [];
  error: Error | undefined;
  errorAtCall: number | undefined;
  readonly results: TokenBucketResult[] = [];
  result: TokenBucketResult | undefined;

  async consumeTokenBucket(
    input: TokenBucketInput,
  ): Promise<TokenBucketResult> {
    this.calls.push(input);
    if (
      this.error &&
      (!this.errorAtCall || this.calls.length === this.errorAtCall)
    ) {
      throw this.error;
    }
    return (
      this.results.shift() ??
      this.result ?? {
        allowed: true,
        remainingMicrotokens: (input.capacity - input.cost) * 1_000_000,
        retryAfterMs: 0,
      }
    );
  }
}

function createRequestLimiter(input: {
  actor:
    | { id: string; principalId: string; type: "apiKey" }
    | { id: string; principalId: string; type: "user" };
  requestId?: string;
  store?: RecordingBucketStore;
  workspaceId?: string;
  clientAddress?: ClientAddressClassification;
  observations?: unknown[];
}) {
  const events: unknown[] = [];
  const store = input.store ?? new RecordingBucketStore();
  const limiter = new OperationLimiter(
    store as Pick<RedisStore, "consumeTokenBucket">,
    { log: (event) => events.push(event) },
    operationLimitHmacKey,
  );
  const requestId = input.requestId ?? "0198f25d-4cbc-7a99-b79b-5bd332874c92";
  return {
    events,
    limiter: limiter.forRequest({
      actor: input.actor,
      clientAddress: input.clientAddress ?? {
        reason: "disabled",
        trust: "unknown",
      },
      requestId,
      workspaceId: input.workspaceId ?? "0198f25f-73fb-73ba-a524-8a33622988db",
      observeBudget: (observation) => input.observations?.push(observation),
    }),
    requestId,
    store,
  };
}

describe("OperationLimiter", () => {
  it("matches the canonical length-prefixed v2 HMAC vector", () => {
    const values = [
      "humans:operation-limit:v2",
      "graph.read",
      "0198f25f-73fb-73ba-a524-8a33622988db",
      "actor",
      "0198f260-dd7c-7d8d-852e-41b103d97d8f",
    ];
    const hmac = createHmac(
      "sha256",
      Buffer.from(operationLimitHmacKey, "hex"),
    );
    for (const value of values) {
      const bytes = Buffer.from(value);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.byteLength);
      hmac.update(length).update(bytes);
    }
    expect(
      operationLimitKeyV2({
        dimension: "actor",
        hmacKey: operationLimitHmacKey,
        operationClass: "graph.read",
        subject: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        workspaceId: "0198f25f-73fb-73ba-a524-8a33622988db",
      }),
    ).toBe(`humans:operation-limit:v2:${hmac.digest("hex")}`);
  });

  it("separates operation, workspace, dimension, subject, and secret", () => {
    const base = {
      dimension: "actor" as const,
      hmacKey: operationLimitHmacKey,
      operationClass: "graph.read",
      subject: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
      workspaceId: "0198f25f-73fb-73ba-a524-8a33622988db",
    };
    const keys = [
      operationLimitKeyV2(base),
      operationLimitKeyV2({ ...base, operationClass: "graph.run" }),
      operationLimitKeyV2({
        ...base,
        workspaceId: "0198f25f-73fb-73ba-a524-8a33622988dc",
      }),
      operationLimitKeyV2({ ...base, dimension: "workspace" }),
      operationLimitKeyV2({
        ...base,
        subject: "0198f260-dd7c-7d8d-852e-41b103d97d80",
      }),
      operationLimitKeyV2({ ...base, hmacKey: "65".repeat(32) }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(JSON.stringify(keys)).not.toMatch(/graph\.read|0198f25f|0198f260/u);
  });

  it("hashes the versioned workspace, operation class, and stable user principal", async () => {
    const first = createRequestLimiter({
      actor: {
        id: "user-visible-id",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
    });
    await first.limiter.consume({
      cost: 3,
      operationClass: "graph.read",
      policy,
    });
    await first.limiter.consume({
      cost: 1,
      operationClass: "graph.analyze",
      policy,
    });

    const [read, analyze] = first.store.calls;
    expect(read).toMatchObject({ cost: 3, ...policy });
    expect(read?.key).toMatch(/^humans:operation-limit:v2:[a-f0-9]{64}$/u);
    expect(analyze?.key).toMatch(/^humans:operation-limit:v2:[a-f0-9]{64}$/u);
    expect(analyze?.key).not.toBe(read?.key);
    expect(JSON.stringify(first.store.calls)).not.toContain("user-visible-id");
    expect(JSON.stringify(first.store.calls)).not.toContain(
      "0198f260-dd7c-7d8d-852e-41b103d97d8f",
    );
    expect(JSON.stringify(first.store.calls)).not.toContain(
      "0198f25f-73fb-73ba-a524-8a33622988db",
    );

    const samePrincipal = createRequestLimiter({
      actor: {
        id: "changed-session-facing-id",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
    });
    await samePrincipal.limiter.consume({
      cost: 3,
      operationClass: "graph.read",
      policy,
    });
    expect(samePrincipal.store.calls[0]?.key).toBe(read?.key);
  });

  it("hashes the verified stored API-key id without accepting raw credentials", async () => {
    const request = createRequestLimiter({
      actor: {
        id: "stored-api-key-id",
        principalId: "api-key-principal",
        type: "apiKey",
      },
    });

    await request.limiter.consume({
      cost: 1,
      operationClass: "graph.read",
      policy,
    });

    expect(request.store.calls[0]?.key).toMatch(
      /^humans:operation-limit:v2:[a-f0-9]{64}$/u,
    );
    expect(JSON.stringify(request.store.calls)).not.toContain(
      "stored-api-key-id",
    );
    expect(JSON.stringify(request.store.calls)).not.toContain(
      "api-key-principal",
    );
  });

  it("consumes actor then client dimensions with only HMAC keys", async () => {
    const observations: unknown[] = [];
    const request = createRequestLimiter({
      actor: {
        id: "user-visible-id",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
      observations,
      clientAddress: {
        family: 4,
        prefix: "203.0.113.0/24",
        source: "vercel",
        trust: "trusted",
      },
    });

    await request.limiter.consume({
      clientPolicy: policy,
      cost: 2,
      operationClass: "search.run",
      policy,
    });

    expect(request.store.calls).toHaveLength(2);
    expect(request.store.calls[0]?.key).toMatch(
      /^humans:operation-limit:v2:[a-f0-9]{64}$/u,
    );
    expect(request.store.calls[1]?.key).toMatch(
      /^humans:operation-limit:v2:[a-f0-9]{64}$/u,
    );
    expect(request.store.calls[1]?.key).not.toBe(request.store.calls[0]?.key);
    expect(JSON.stringify(request.store.calls)).not.toMatch(
      /203\.0\.113|0198f260|search\.run/u,
    );
    expect(observations).toEqual([
      expect.objectContaining({
        dimension: "actor",
        operationClass: "search.run",
        outcome: "allowed",
      }),
      expect.objectContaining({
        dimension: "client_prefix",
        operationClass: "search.run",
        outcome: "allowed",
      }),
    ]);
    expect(
      observations.every(
        (value) =>
          typeof (value as { durationSeconds?: unknown }).durationSeconds ===
          "number",
      ),
    ).toBe(true);
  });

  it("exposes only the validated retry for the dimension that denied", async () => {
    const store = new RecordingBucketStore();
    store.results.push(
      {
        allowed: true,
        remainingMicrotokens: 8_000_000,
        retryAfterMs: 0,
      },
      { allowed: false, remainingMicrotokens: 0, retryAfterMs: 12_345 },
    );
    const request = createRequestLimiter({
      actor: {
        id: "user-visible-id",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
      clientAddress: {
        family: 4,
        prefix: "203.0.113.0/24",
        source: "vercel",
        trust: "trusted",
      },
      store,
    });
    const error = await request.limiter
      .consume({
        clientPolicy: policy,
        cost: 2,
        operationClass: "search.run",
        policy,
      })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      extensions: { code: "RATE_LIMITED", retryAfterMs: 12_345 },
    });
  });

  it("rejects forged client metadata before consuming the primary bucket", async () => {
    const request = createRequestLimiter({
      actor: {
        id: "user-visible-id",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
      clientAddress: {
        family: 4,
        prefix: "999.999.999.0/24",
        source: "vercel",
        trust: "trusted",
      },
    });

    await expect(
      request.limiter.consume({
        clientPolicy: policy,
        cost: 1,
        operationClass: "search.run",
        policy,
      }),
    ).rejects.toThrow(/client prefix/u);
    expect(request.store.calls).toEqual([]);
  });

  it("fails closed on a malformed provider result", async () => {
    const store = new RecordingBucketStore();
    store.result = {
      allowed: true,
      remainingMicrotokens: 10_000_000,
      retryAfterMs: 0,
    };
    const request = createRequestLimiter({
      actor: {
        id: "user",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
      store,
    });

    await expect(
      request.limiter.consume({
        cost: 1,
        operationClass: "search.run",
        policy,
      }),
    ).rejects.toMatchObject({
      extensions: { code: "PROVIDER_UNAVAILABLE" },
    });
    expect(request.events).toHaveLength(1);
  });

  it("spends primary tokens before a generic client denial", async () => {
    const store = new RecordingBucketStore();
    store.results.push(
      {
        allowed: true,
        remainingMicrotokens: 8_000_000,
        retryAfterMs: 0,
      },
      { allowed: false, remainingMicrotokens: 0, retryAfterMs: 1_000 },
    );
    const request = createRequestLimiter({
      actor: {
        id: "user",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
      store,
    });

    await expect(
      request.limiter.consume({
        clientPolicy: policy,
        cost: 2,
        operationClass: "search.run",
        policy,
      }),
    ).rejects.toMatchObject({ extensions: { code: "RATE_LIMITED" } });
    expect(store.calls).toHaveLength(2);
  });

  it("fails closed and logs safely when the second dimension provider fails", async () => {
    const observations: unknown[] = [];
    const store = new RecordingBucketStore();
    store.error = new Error("redis://secret/full-client-address");
    store.errorAtCall = 2;
    const request = createRequestLimiter({
      actor: {
        id: "user",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
      store,
      observations,
    });

    await expect(
      request.limiter.consume({
        clientPolicy: policy,
        cost: 1,
        operationClass: "search.run",
        policy,
      }),
    ).rejects.toMatchObject({
      extensions: { code: "PROVIDER_UNAVAILABLE" },
    });
    expect(store.calls).toHaveLength(2);
    expect(JSON.stringify(request.events)).not.toMatch(/secret|redis:|client/u);
    expect(observations).toEqual([
      expect.objectContaining({ dimension: "actor", outcome: "allowed" }),
      expect.objectContaining({
        dimension: "client_prefix",
        outcome: "unavailable",
      }),
    ]);
  });

  it("throws a safe request-correlated RATE_LIMITED error on exhaustion", async () => {
    const store = new RecordingBucketStore();
    store.result = {
      allowed: false,
      remainingMicrotokens: 0,
      retryAfterMs: 1_000,
    };
    const request = createRequestLimiter({
      actor: {
        id: "user",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
      store,
    });

    const error = await request.limiter
      .consume({ cost: 10, operationClass: "graph.read", policy })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).message).toBe("Too many requests.");
    expect((error as GraphQLError).extensions).toMatchObject({
      code: "RATE_LIMITED",
      requestId: request.requestId,
    });
    expect(request.events).toEqual([]);
  });

  it("fails closed and logs only the allowlisted event and request id on provider errors", async () => {
    const store = new RecordingBucketStore();
    store.error = new Error(
      "redis://secret-user:secret-password@example.test raw-key-value",
    );
    const request = createRequestLimiter({
      actor: {
        id: "user",
        principalId: "0198f260-dd7c-7d8d-852e-41b103d97d8f",
        type: "user",
      },
      store,
    });

    const error = await request.limiter
      .consume({ cost: 1, operationClass: "graph.read", policy })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(GraphQLError);
    expect((error as GraphQLError).message).toBe(
      "A required provider is unavailable.",
    );
    expect((error as GraphQLError).extensions).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      requestId: request.requestId,
    });
    expect(request.events).toEqual([
      {
        event: "graphql.operation_limiter.unavailable",
        requestId: request.requestId,
        severity: "error",
      },
    ]);
    expect(JSON.stringify(request.events)).not.toMatch(
      /secret|password|raw-key|redis:/iu,
    );
  });
});
