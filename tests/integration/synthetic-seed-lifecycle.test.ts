// @vitest-environment node

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { seedDatabase } from "@/db/seed";

const databaseUrl = process.env.TEST_DATABASE_URL;
const live = databaseUrl ? describe : describe.skip;
const sql = databaseUrl
  ? postgres(databaseUrl, { max: 1, onnotice: () => undefined, prepare: false })
  : undefined;

live("fictional seed PostgreSQL lifecycle", () => {
  it("is repeatable and keeps Atlas/Sandbox tenant counts isolated", async () => {
    process.env.ALLOW_DATABASE_SEED = "true";
    await seedDatabase(databaseUrl!);
    await seedDatabase(databaseUrl!);

    const atlas = await sql!`
      SELECT count(*)::int AS count FROM people
      WHERE workspace_id = '01900000-0000-7000-8000-000000000001'
    `;
    const sandbox = await sql!`
      SELECT count(*)::int AS count FROM people
      WHERE workspace_id = '01900000-0000-7000-8000-000000000002'
    `;
    expect(atlas[0]?.count).toBe(4);
    expect(sandbox[0]?.count).toBe(1);
  });
});

afterAll(async () => {
  await sql?.end();
});
