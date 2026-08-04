// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  createPerformanceDiagnosticSignature,
  getPerformanceDiagnosticCandidate,
  isPerformanceDiagnosticRequest,
  measureDatabaseQueries,
  recordDatabaseQuery,
} from "@/graphql/query-instrumentation";

describe("GraphQL database query instrumentation", () => {
  it("counts database calls made inside the measured request", async () => {
    recordDatabaseQuery();

    const measured = await measureDatabaseQueries(async () => {
      recordDatabaseQuery();
      recordDatabaseQuery();
      return "response";
    });

    expect(measured).toEqual({ queryCount: 2, value: "response" });
  });

  it("keeps concurrent request counts isolated", async () => {
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = measureDatabaseQueries(async () => {
      recordDatabaseQuery();
      await firstPaused;
      recordDatabaseQuery();
      return "first";
    });
    const second = measureDatabaseQueries(async () => {
      recordDatabaseQuery();
      recordDatabaseQuery();
      recordDatabaseQuery();
      return "second";
    });

    const secondResult = await second;
    releaseFirst();
    const firstResult = await first;

    expect(firstResult).toEqual({ queryCount: 2, value: "first" });
    expect(secondResult).toEqual({ queryCount: 3, value: "second" });
  });

  it("requires an isolated runtime and a signed authenticated principal", () => {
    const principalId = "0198f260-dd7c-7d8d-852e-41b103d97d8f";
    const secret = "isolated-performance-secret-with-sufficient-entropy";
    const signature = createPerformanceDiagnosticSignature(principalId, secret);
    const request = new Request("http://localhost/api/graphql", {
      headers: {
        "x-humans-performance": "graph-reference-v1",
        "x-humans-performance-principal": principalId,
        "x-humans-performance-signature": signature,
      },
    });

    expect(
      isPerformanceDiagnosticRequest(request, principalId, {
        enabled: true,
        isolatedTestRuntime: true,
        secret,
      }),
    ).toBe(true);
    expect(
      getPerformanceDiagnosticCandidate(request, {
        enabled: true,
        isolatedTestRuntime: true,
        secret,
      }),
    ).toEqual({ principalId });
    expect(
      isPerformanceDiagnosticRequest(request, principalId, {
        enabled: true,
        isolatedTestRuntime: false,
        secret,
      }),
    ).toBe(false);
  });

  it("rejects absent and spoofed performance diagnostic headers", () => {
    const principalId = "0198f260-dd7c-7d8d-852e-41b103d97d8f";
    const attackerId = "0198f260-dd7c-7d8d-852e-41b103d97d90";
    const secret = "isolated-performance-secret-with-sufficient-entropy";
    const settings = {
      enabled: true,
      isolatedTestRuntime: true,
      secret,
    };

    expect(
      isPerformanceDiagnosticRequest(
        new Request("http://localhost/api/graphql"),
        principalId,
        settings,
      ),
    ).toBe(false);

    const signedForAnotherPrincipal = new Request(
      "http://localhost/api/graphql",
      {
        headers: {
          "x-humans-performance": "graph-reference-v1",
          "x-humans-performance-principal": attackerId,
          "x-humans-performance-signature":
            createPerformanceDiagnosticSignature(attackerId, secret),
        },
      },
    );
    expect(
      isPerformanceDiagnosticRequest(
        signedForAnotherPrincipal,
        principalId,
        settings,
      ),
    ).toBe(false);

    const spoofedSignature = new Request("http://localhost/api/graphql", {
      headers: {
        "x-humans-performance": "graph-reference-v1",
        "x-humans-performance-principal": principalId,
        "x-humans-performance-signature": "0".repeat(64),
      },
    });
    expect(
      isPerformanceDiagnosticRequest(spoofedSignature, principalId, settings),
    ).toBe(false);
  });
});
