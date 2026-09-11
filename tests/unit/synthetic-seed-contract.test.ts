import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const seedPath = "src/db/seed.ts";

describe("fictional demo seed contract", () => {
  it("is guarded, deterministic, and contains no real-person fixture", async () => {
    const seed = await readFile(seedPath, "utf8");

    expect(seed).toContain("ALLOW_DATABASE_SEED=true");
    expect(seed).toContain("connection.begin");
    expect(seed).toContain("ON CONFLICT");
    expect(seed).not.toContain("Ada Lovelace");
    expect(seed).not.toContain("Lovelace");
    expect(seed).not.toContain("Newton");
    expect(seed).toMatch(/\.invalid/);
    expect(seed).toMatch(/Northstar Atlas/);
    expect(seed).toMatch(/fictional/i);
  });

  it("declares every required rich demo record family", async () => {
    const seed = await readFile(seedPath, "utf8");

    for (const table of [
      "people",
      "person_names",
      "person_identifiers",
      "person_events",
      "fact_definitions",
      "facts",
      "sources",
      "evidence_items",
      "evidence_excerpts",
      "evidence_assertions",
      "relationship_types",
      "relationships",
      "relationship_evidence",
      "cases",
      "case_members",
      "consent_records",
      "ai_review_suggestions",
      "person_web_research_runs",
      "legal_holds",
    ]) {
      expect(seed, table).toMatch(new RegExp(`INSERT INTO ${table}\\b`));
    }

    expect(seed).toMatch(/Northstar Atlas[\s\S]*Northstar Sandbox/);
    expect(seed).toMatch(/status.*withdrawn/);
    expect(seed).toMatch(/status.*pending/);
    expect(seed).toMatch(/state.*active/);
    expect(seed).toMatch(/documented/);
    expect(seed).toMatch(/hypothesis/);
    expect(seed).toMatch(/contradicts/);
  });
});
