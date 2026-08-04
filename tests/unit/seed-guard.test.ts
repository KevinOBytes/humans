// @vitest-environment node

import { describe, expect, it } from "vitest";

import { assertDatabaseSeedAllowed } from "@/db/seed-guard";

const productionDatabase = "postgresql://humans:password@postgres:5432/humans";
const testDatabase = "postgresql://humans:password@127.0.0.1:5432/humans_test";

describe("assertDatabaseSeedAllowed", () => {
  it("refuses an arbitrary production database without explicit authorization", () => {
    expect(() =>
      assertDatabaseSeedAllowed({
        allowSeed: undefined,
        databaseUrl: productionDatabase,
        nodeEnv: "production",
      }),
    ).toThrow(/ALLOW_DATABASE_SEED=true/);
  });

  it.each(["", "false", "TRUE", "1"])(
    "refuses non-exact authorization %s for a non-test database",
    (allowSeed) => {
      expect(() =>
        assertDatabaseSeedAllowed({
          allowSeed,
          databaseUrl: productionDatabase,
          nodeEnv: "development",
        }),
      ).toThrow(/ALLOW_DATABASE_SEED=true/);
    },
  );

  it("allows an exactly named development test database without the override", () => {
    expect(
      assertDatabaseSeedAllowed({
        allowSeed: undefined,
        databaseUrl: testDatabase,
        nodeEnv: "development",
      }),
    ).toBe("humans_test");
  });

  it("allows an explicit production seed operation", () => {
    expect(
      assertDatabaseSeedAllowed({
        allowSeed: "true",
        databaseUrl: productionDatabase,
        nodeEnv: "production",
      }),
    ).toBe("humans");
  });
});
