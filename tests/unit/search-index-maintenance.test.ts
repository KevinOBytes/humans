// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/modules/auth/bootstrap-admin";
import type { ResearchServiceContext } from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  withResearchWriteTransaction,
} from "@/modules/audit/transactions";
import {
  disabledSearchIndexMaintenance,
  type SearchIndexMaintenance,
  type SearchIndexMutation,
} from "@/modules/search/index-maintenance";

const workspaceId = "019d1d34-a5a5-7c98-b8fc-24f9058ec0d1";
const sourceId = "019d1d34-a5a5-7c98-b8fc-24f9058ec0d2";
const mutation: SearchIndexMutation = {
  action: "upsert",
  sourceId,
  sourceKind: "person",
  sourceVersion: 1,
  workspaceId,
};

function fixture(maintenance: SearchIndexMaintenance) {
  const transactionDatabase = {} as Database;
  const rootDatabase = {
    transaction: vi.fn(
      async (write: (database: Database) => Promise<unknown>) =>
        write(transactionDatabase),
    ),
  } as unknown as Database;
  const context: ResearchServiceContext = {
    actor: {
      type: "user",
      id: "user-1",
      principalId: "019d1d34-a5a5-7c98-b8fc-24f9058ec0d3",
      sessionId: "session-1",
      memberId: "member-1",
      role: "owner",
    },
    database: rootDatabase,
    permissions: new Set(),
    requestId: "019d1d34-a5a5-7c98-b8fc-24f9058ec0d4",
    searchIndexMaintenance: maintenance,
    workspaceId,
  };
  return { context, rootDatabase, transactionDatabase };
}

describe("search index maintenance transaction contract", () => {
  it("dispatches only on the active yielded transaction and retires it", async () => {
    const apply = vi.fn(async () => {});
    const { context, rootDatabase, transactionDatabase } = fixture({
      mode: "transactional",
      apply,
    });
    let escaped: Database | undefined;

    await expect(
      applySearchIndexMaintenance(context, rootDatabase, [mutation]),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });

    await withResearchWriteTransaction(context, async (database) => {
      escaped = database;
      await applySearchIndexMaintenance(context, database, [mutation]);
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(transactionDatabase, [mutation]);
    await expect(
      applySearchIndexMaintenance(context, escaped!, [mutation]),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });

  it.each([
    [null],
    [42],
    [[]],
    [{ ...mutation, workspaceId: sourceId }],
    [{ ...mutation, sourceId: "not-a-uuid" }],
    [{ ...mutation, sourceVersion: 0 }],
    [{ ...mutation, sourceKind: "file" }],
    [{ ...mutation, action: "refresh" }],
    [{ ...mutation, rawText: "must never cross the seam" }],
    [mutation, mutation],
  ])(
    "rejects malformed, foreign, duplicate, or raw-bearing events",
    async (...events) => {
      const apply = vi.fn(async () => {});
      const { context } = fixture({ mode: "transactional", apply });
      await expect(
        withResearchWriteTransaction(context, (database) =>
          applySearchIndexMaintenance(
            context,
            database,
            events as unknown as readonly SearchIndexMutation[],
          ),
        ),
      ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["non-enumerable", "rawText"],
    ["symbol", Symbol("policy")],
  ] as const)("rejects a %s extra own key", async (_kind, extraKey) => {
    const event = { ...mutation } as SearchIndexMutation;
    Object.defineProperty(event, extraKey, {
      configurable: true,
      enumerable: false,
      value: "must never cross the seam",
    });
    const apply = vi.fn(async () => {});
    const { context } = fixture({ mode: "transactional", apply });

    await expect(
      withResearchWriteTransaction(context, (database) =>
        applySearchIndexMaintenance(context, database, [event]),
      ),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps disabled mode explicit and side-effect free", async () => {
    const { context } = fixture(disabledSearchIndexMaintenance);
    await expect(
      withResearchWriteTransaction(context, (database) =>
        applySearchIndexMaintenance(context, database, [mutation]),
      ),
    ).resolves.toBeUndefined();
  });
});
