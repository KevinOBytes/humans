import { GraphQLError } from "graphql";
import { describe, expect, it, vi } from "vitest";

import { createGraphQLError } from "@/graphql/errors";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  ANALYSIS_READ_OPERATION_CLASS,
  ANALYSIS_READ_CLIENT_POLICY,
  ANALYSIS_READ_POLICY,
  analysisResultReadCost,
  analysisRunListReadCost,
  analysisRunReadCost,
} from "@/modules/graph/analysis-read-limits";
import { createGraphService } from "@/modules/graph/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";

const metrics = createTask12Metrics(disabledMetricsSink);

function createRateLimitedGraphService() {
  const transaction = vi.fn(() => {
    throw new Error("database work must not start");
  });
  const consume = vi.fn(async () => {
    throw createGraphQLError("RATE_LIMITED", "Too many requests.");
  });
  const service = createGraphService({
    actor: {
      type: "user",
      id: "user-1",
      principalId: "principal-1",
      sessionId: "session-1",
      memberId: "member-1",
      role: "owner",
    },
    cursorHmacKey: "45".repeat(32),
    database: { transaction } as unknown as Database,
    metrics,
    operationLimiter: { consume },
    permissions: new Set(),
    requestId: "request-1",
    searchIndexMaintenance: disabledSearchIndexMaintenance,
    workspaceId: "018f0000-0000-7000-8000-000000000001",
  });
  return { consume, service, transaction };
}

function createStatementTimeoutGraphService() {
  const execute = vi.fn(async () => {
    throw Object.assign(new Error("private query text"), { code: "57014" });
  });
  const transaction = vi.fn(
    async (callback: (database: Database) => Promise<unknown>) =>
      callback({ execute } as unknown as Database),
  );
  const service = createGraphService({
    actor: {
      type: "user",
      id: "user-1",
      principalId: "018f0000-0000-7000-8000-000000000011",
      sessionId: "session-1",
      memberId: "member-1",
      role: "owner",
    },
    cursorHmacKey: "45".repeat(32),
    database: { transaction } as unknown as Database,
    metrics,
    operationLimiter: {
      consume: async () => ({
        allowed: true,
        remainingMicrotokens: 1,
        retryAfterMs: 0,
      }),
    },
    permissions: new Set(),
    requestId: "request-1",
    searchIndexMaintenance: disabledSearchIndexMaintenance,
    workspaceId: "018f0000-0000-7000-8000-000000000001",
  });
  return { execute, service, transaction };
}

describe("graph service preflight", () => {
  it("maps statistics timeouts to one neutral error without partial counts", async () => {
    const { execute, service, transaction } =
      createStatementTimeoutGraphService();

    const error = await service.statistics().catch((value: unknown) => value);

    expect(error).toMatchObject({
      extensions: { code: "RATE_LIMITED", requestId: "request-1" },
    });
    expect(JSON.stringify(error)).not.toContain("private query text");
    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("maps snapshot create/read/replay statement timeouts to neutral bounded errors", async () => {
    const { service } = createStatementTimeoutGraphService();
    const attempts = [
      () =>
        service.createSnapshot({
          algorithm: "DEGREE",
          filter: { mode: "WORKSPACE", nodeLimit: 10, edgeLimit: 10 },
        }),
      () => service.getSnapshot("018f0000-0000-7000-8000-000000000010"),
      () => service.replaySnapshot("018f0000-0000-7000-8000-000000000010"),
    ];
    for (const attempt of attempts) {
      const error = await attempt().catch((value: unknown) => value);
      expect(error).toMatchObject({ extensions: { code: "RATE_LIMITED" } });
      expect(JSON.stringify(error)).not.toContain("private query text");
    }
  });

  it("rejects an analysis request above the algorithm cap before database work", async () => {
    const transaction = vi.fn(() => {
      throw new Error("database work must not start");
    });
    const consume = vi.fn(async () => ({
      allowed: true,
      remainingMicrotokens: 1_000_000,
      retryAfterMs: 0,
    }));
    const service = createGraphService({
      actor: {
        type: "user",
        id: "user-1",
        principalId: "principal-1",
        sessionId: "session-1",
        memberId: "member-1",
        role: "owner",
      },
      cursorHmacKey: "45".repeat(32),
      database: { transaction } as unknown as Database,
      metrics,
      operationLimiter: { consume },
      permissions: new Set(),
      requestId: "request-1",
      searchIndexMaintenance: disabledSearchIndexMaintenance,
      workspaceId: "018f0000-0000-7000-8000-000000000001",
    });

    const rejection = await service
      .runAnalysis({
        algorithm: "PAGERANK",
        filter: {
          mode: "WORKSPACE",
          nodeLimit: 2_001,
          edgeLimit: 10_000,
        },
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(GraphQLError);
    expect((rejection as GraphQLError).extensions.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledOnce();
  });

  it("charges the dedicated maximum-manifest cost before an analysis point read", async () => {
    const { consume, service, transaction } = createRateLimitedGraphService();

    const rejection = await service
      .getAnalysisRun("018f0000-0000-7000-8000-000000000010")
      .catch((error: unknown) => error);

    expect((rejection as GraphQLError).extensions.code).toBe("RATE_LIMITED");
    expect(consume).toHaveBeenCalledWith({
      clientPolicy: ANALYSIS_READ_CLIENT_POLICY,
      operationClass: ANALYSIS_READ_OPERATION_CLASS,
      cost: analysisRunReadCost(),
      policy: ANALYSIS_READ_POLICY,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([1, 10, 100])(
    "charges every possible analysis-list candidate for first=%i",
    async (first) => {
      const { consume, service, transaction } = createRateLimitedGraphService();

      const rejection = await service
        .listAnalysisRuns({ first })
        .catch((error: unknown) => error);

      expect((rejection as GraphQLError).extensions.code).toBe("RATE_LIMITED");
      expect(consume).toHaveBeenCalledWith({
        clientPolicy: ANALYSIS_READ_CLIENT_POLICY,
        operationClass: ANALYSIS_READ_OPERATION_CLASS,
        cost: analysisRunListReadCost(first),
        policy: ANALYSIS_READ_POLICY,
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each([1, 100])(
    "adds the bounded result-page cost for first=%i",
    async (first) => {
      const { consume, service, transaction } = createRateLimitedGraphService();

      const rejection = await service
        .getAnalysisResults({
          runId: "018f0000-0000-7000-8000-000000000010",
          first,
        })
        .catch((error: unknown) => error);

      expect((rejection as GraphQLError).extensions.code).toBe("RATE_LIMITED");
      expect(consume).toHaveBeenCalledWith({
        clientPolicy: ANALYSIS_READ_CLIENT_POLICY,
        operationClass: ANALYSIS_READ_OPERATION_CLASS,
        cost: analysisResultReadCost(first),
        policy: ANALYSIS_READ_POLICY,
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it("keeps public analysis validation errors ahead of the limiter", async () => {
    const { consume, service, transaction } = createRateLimitedGraphService();

    const invalidId = await service
      .getAnalysisRun("not-a-uuid")
      .catch((error: unknown) => error);
    const invalidPage = await service
      .listAnalysisRuns({ first: 101 })
      .catch((error: unknown) => error);
    const invalidCursor = await service
      .getAnalysisResults({
        runId: "018f0000-0000-7000-8000-000000000010",
        after: "not-a-cursor",
        first: 100,
      })
      .catch((error: unknown) => error);

    expect((invalidId as GraphQLError).extensions.code).toBe(
      "VALIDATION_FAILED",
    );
    expect((invalidPage as GraphQLError).extensions.code).toBe(
      "VALIDATION_FAILED",
    );
    expect((invalidCursor as GraphQLError).extensions.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(consume).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
