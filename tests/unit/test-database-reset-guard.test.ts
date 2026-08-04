// @vitest-environment node

import { describe, expect, it } from "vitest";

import { assertTestDatabaseResetAllowed } from "../support/database-reset-guard";

const safeInput = {
  allowReset: "true",
  currentDatabase: "humans_test",
  databaseUrl: "postgresql://humans:password@127.0.0.1:5432/humans_test",
};

describe("assertTestDatabaseResetAllowed", () => {
  it("allows an explicit reset of an exactly matching test database", () => {
    expect(assertTestDatabaseResetAllowed(safeInput)).toBe("humans_test");
  });

  it.each([undefined, "", "false", "TRUE", "1"])(
    "rejects reset flag %s",
    (allowReset) => {
      expect(() =>
        assertTestDatabaseResetAllowed({ ...safeInput, allowReset }),
      ).toThrow(/ALLOW_TEST_DATABASE_RESET=true/);
    },
  );

  it.each(["contest", "latest", "test", "humans_test_shadow", "humans-test"])(
    "rejects unsafe database name %s",
    (databaseName) => {
      expect(() =>
        assertTestDatabaseResetAllowed({
          ...safeInput,
          currentDatabase: databaseName,
          databaseUrl: `postgresql://humans:password@127.0.0.1:5432/${databaseName}`,
        }),
      ).toThrow(/must end exactly in _test/);
    },
  );

  it("rejects a missing database URL", () => {
    expect(() =>
      assertTestDatabaseResetAllowed({
        ...safeInput,
        databaseUrl: undefined,
      }),
    ).toThrow(/TEST_DATABASE_URL is required/);
  });

  it("rejects an invalid database URL", () => {
    expect(() =>
      assertTestDatabaseResetAllowed({
        ...safeInput,
        databaseUrl: "not-a-url",
      }),
    ).toThrow(/valid PostgreSQL URL/);
  });

  it("rejects a URL and connection database mismatch", () => {
    expect(() =>
      assertTestDatabaseResetAllowed({
        ...safeInput,
        currentDatabase: "other_test",
      }),
    ).toThrow(/does not match current_database/);
  });
});
