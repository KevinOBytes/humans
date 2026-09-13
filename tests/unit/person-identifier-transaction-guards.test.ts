// @vitest-environment node
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { people, personIdentifiers } from "@/db/schema/people";
import type { ResearchServiceContext } from "@/modules/audit/service";
import type { PersonIdentifierRow } from "@/modules/people/repository";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";

vi.mock("@/modules/audit/transactions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/audit/transactions")>()),
  runResearchTransaction: async (
    context: ResearchServiceContext,
    _options: unknown,
    write: (scoped: ResearchServiceContext) => Promise<unknown>,
  ) => context.database.transaction(async () => write(context)),
}));
vi.mock("@/modules/audit/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/audit/service")>()),
  createAuditService: () => ({ write: async () => undefined }),
}));
import { createIdentifierService } from "@/modules/people/identifier-service";

const workspaceId = "019fe224-a0cd-76e4-92ac-9d27a5c62cf4";
const personId = "019fe224-a0cd-76e4-92ac-9d27a5c62cf5";
const movedPersonId = "019fe224-a0cd-76e4-92ac-9d27a5c62cf6";
const id = "019fe224-a0cd-76e4-92ac-9d27a5c62cf7";
const now = new Date("2026-09-13T00:00:00.000Z");
const initial: PersonIdentifierRow = {
  id,
  workspaceId,
  personId,
  namespace: "registry",
  identifierType: "profile",
  normalizedValue: "public-42",
  encryptedRawValue: null,
  blindIndex: null,
  blindIndexVersion: 1,
  issuer: null,
  validFrom: null,
  validUntil: null,
  verificationState: "unverified",
  sensitivity: "public",
  version: 1,
  createdAt: now,
  updatedAt: now,
  createdBy: id,
  updatedBy: id,
  deletedAt: null,
  deletedBy: null,
};

// The database double interprets emitted optimistic-write equality predicates;
// policy evaluation and transaction rollback stay at the external DB boundary.
function setup(existing = true, moveAfterRead = false) {
  let row: PersonIdentifierRow | null = existing ? { ...initial } : null;
  let moved = false;
  const database = {
    transaction: async (write: () => Promise<unknown>) => {
      const before = row && { ...row };
      try {
        return await write();
      } catch (error) {
        // A concurrent ownership move belongs to the other transaction.
        row = before && {
          ...before,
          ...(moved ? { personId: movedPersonId } : {}),
        };
        throw error;
      }
    },
    select: () => {
      let table: unknown;
      let predicateSql = "";
      const rows = () => {
        if (table === people) return [{ id: personId }];
        if (
          table !== personIdentifiers ||
          !row ||
          (!["public", "internal"].includes(row.sensitivity) &&
            predicateSql.includes('"person_identifiers"."sensitivity" IN'))
        )
          return [];
        const snapshot = { ...row };
        if (moveAfterRead && !moved) {
          row = { ...row, personId: movedPersonId };
          moved = true;
        }
        return [snapshot];
      };
      const query = {
        from: (value: unknown) => {
          table = value;
          return query;
        },
        where: (predicate: SQL) => {
          predicateSql = new PgDialect().sqlToQuery(predicate).sql;
          return query;
        },
        limit: () => query,
        for: async () => rows(),
        then: (resolve: (value: unknown[]) => unknown) =>
          Promise.resolve(rows()).then(resolve),
      };
      return query;
    },
    insert: () => ({
      values: (values: Partial<PersonIdentifierRow>) => ({
        returning: async () => {
          row = { ...initial, ...values };
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<PersonIdentifierRow>) => ({
        where: (predicate: SQL) => ({
          returning: async () => {
            const query = new PgDialect().sqlToQuery(predicate);
            const columns = {
              id: "id",
              workspace_id: "workspaceId",
              person_id: "personId",
              version: "version",
            } as const;
            for (const match of query.sql.matchAll(
              /"person_identifiers"\."(id|workspace_id|person_id|version)" = \$(\d+)/g,
            )) {
              if (
                !row ||
                row[columns[match[1] as keyof typeof columns]] !==
                  query.params[Number(match[2]) - 1]
              )
                return [];
            }
            if (!row || row.deletedAt) return [];
            row = { ...row, ...patch, version: row.version + 1 };
            return [row];
          },
        }),
      }),
    }),
  };
  const context: ResearchServiceContext = {
    database: database as unknown as ResearchServiceContext["database"],
    workspaceId,
    requestId: "identifier-guard-test",
    permissions: new Set(["person:update", "person:delete"]),
    actor: {
      type: "user",
      id: "synthetic-user",
      principalId: id,
      memberId: id,
      sessionId: "synthetic-session",
      role: "owner",
    },
    searchIndexMaintenance: disabledSearchIndexMaintenance,
    protectedExactRuntime: {
      blindIndexKey: "12".repeat(32),
      encryptionKey: "34".repeat(32),
    },
  };
  return { service: createIdentifierService(context), stored: () => row };
}

describe("identifier transaction guards", () => {
  it("rolls back a confidential creation that is invisible to its caller", async () => {
    const { service, stored } = setup(false);
    expect(
      await service.createIdentifier({
        personId,
        namespace: "registry",
        identifierType: "profile",
        value: "protected-42",
        sensitivity: "confidential",
      }),
    ).toMatchObject({ resource: null, code: "NOT_VISIBLE" });
    expect(stored()).toBeNull();
  });
  it("rolls back a protected reclassification without a matching visibility grant", async () => {
    const { service, stored } = setup();
    expect(
      await service.updateIdentifier({
        id,
        expectedVersion: 1,
        sensitivity: "restricted",
      }),
    ).toMatchObject({ resource: null, code: "NOT_VISIBLE" });
    expect(stored()).toEqual(initial);
  });
  it.each(["updateIdentifier", "archiveIdentifier"] as const)(
    "fences %s against a concurrent parent move that does not increment the identifier version",
    async (method) => {
      const { service, stored } = setup(true, true);
      await expect(
        service[method]({ id, expectedVersion: 1, issuer: "must not persist" }),
      ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
      expect(stored()).toMatchObject({
        personId: movedPersonId,
        version: 1,
        issuer: null,
        deletedAt: null,
      });
    },
  );
});
