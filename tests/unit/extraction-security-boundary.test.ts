// @vitest-environment node

import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import type { GraphQLContext } from "@/graphql/context";
import { schema } from "@/graphql/schema";
import type { ObjectStore } from "@/lib/storage/types";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { createExtractionService } from "@/modules/files/extraction-service";

const id = "01984e93-7644-72c6-82d0-fda7f590580e";
const secret = "private-person-text password=secret sk-provider-secret";
const { graphql } = createRequire(import.meta.url)(
  "graphql",
) as typeof import("graphql");

describe("extraction security boundary", () => {
  it("denies cancellation without read authority before mutation or content disclosure", async () => {
    const cancel = vi.fn(async () => ({
      id,
      structuredOutput: { text: secret },
    }));
    const result = await graphql({
      schema,
      source: `mutation { cancelExtraction(runId: "${id}") { id structuredOutput } }`,
      contextValue: {
        permissions: new Set(["file:update"]),
        services: { extraction: { cancel } },
      } as unknown as GraphQLContext,
    });
    expect(result.errors?.[0]?.extensions.code).toBe("FORBIDDEN");
    expect(cancel).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["user", "apiKey"] as const)(
    "denies cancellation by a %s without read authority before database work",
    async (type) => {
      const select = vi.fn(() => {
        throw new Error("Database must not be reached");
      });
      const service = createExtractionService(
        {
          actor: { type },
          database: { select },
          permissions: new Set(["file:update"]),
        } as unknown as ResearchServiceContext,
        {
          encryptionKey: "ab".repeat(32),
          objectStore: {} as ObjectStore,
        },
      );
      await expect(service.cancel(id)).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
      expect(select).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["requestExtraction", `fileId: "${id}"`, "request"],
    ["retryExtraction", `runId: "${id}"`, "retry"],
  ])(
    "denies %s without read authority before enqueueing",
    async (field, args, method) => {
      const enqueue = vi.fn(async () => ({ runId: id, fileId: id }));
      const list = vi.fn(async () => [{ id }]);
      const result = await graphql({
        schema,
        source: `mutation { ${field}(${args}) { id } }`,
        contextValue: {
          permissions: new Set(["file:update"]),
          services: { extraction: { [method]: enqueue, list } },
        } as unknown as GraphQLContext,
      });
      expect(result.errors?.[0]?.extensions.code).toBe("FORBIDDEN");
      expect(enqueue).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("keeps the GraphQL permission gate ahead of extraction service work", async () => {
    const list = vi.fn();
    const result = await graphql({
      schema,
      source: `query { extractionRuns(fileId: "${id}") { errorSummary } }`,
      contextValue: {
        permissions: new Set(["file:update"]),
        services: { extraction: { list } },
      } as unknown as GraphQLContext,
    });
    expect(result.errors?.[0]?.extensions.code).toBe("FORBIDDEN");
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["user", "apiKey"] as const)(
    "denies a %s without file:read before database access",
    async (type) => {
      const select = vi.fn(() => {
        throw new Error("Database must not be reached");
      });
      const context = {
        actor: { type },
        database: { select },
        permissions: new Set(["file:update"]),
      } as unknown as ResearchServiceContext;
      const service = createExtractionService(context, {
        encryptionKey: "ab".repeat(32),
        objectStore: {} as ObjectStore,
      });

      await expect(service.list(id)).rejects.toMatchObject({
        extensions: { code: "FORBIDDEN" },
      });
      expect(select).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, null],
    [
      { code: "extraction_failed", message: secret, stack: secret },
      { code: "extraction_failed" },
    ],
    [
      { code: "PROVIDER_TIMEOUT", credentials: secret },
      { code: "provider_timeout" },
    ],
    [
      { code: secret, nested: { token: secret } },
      { code: "dependency_unavailable" },
    ],
    [{ message: secret }, { code: "dependency_unavailable" }],
    [secret, { code: "dependency_unavailable" }],
    [
      [{ code: "extraction_failed", message: secret }],
      { code: "dependency_unavailable" },
    ],
  ])(
    "projects persisted diagnostic %j to a closed code",
    async (stored, expected) => {
      const list = vi.fn(async () => [{ errorSummary: stored }]);
      const contextValue = {
        permissions: new Set(["file:read"]),
        services: { extraction: { list } },
      } as unknown as GraphQLContext;
      const result = await graphql({
        schema,
        source: `query { extractionRuns(fileId: "${id}") { errorSummary } }`,
        contextValue,
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.extractionRuns).toEqual([{ errorSummary: expected }]);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(list).toHaveBeenCalledWith(id);
    },
  );
});
