import { expect, it } from "vitest";
import { redactUngovernedFact } from "@/components/facts/person-fact-disclosure";
import { fictionalProfile } from "../support/fixtures";

it("removes non-public values, provenance, temporal values and mutation selection before serialization", () => {
  const fact = {
    ...fictionalProfile.facts[0]!,
    value: "PRIVATE VALUE",
    selected: true,
    revisionNextHref: "/sensitive-revision",
    evidence: [{ id: "e", title: "PRIVATE SOURCE", excerpt: "PRIVATE QUOTE" }],
  };
  const serialized = JSON.stringify(redactUngovernedFact(fact));
  expect(serialized).not.toContain("PRIVATE");
  expect(serialized).not.toContain("/sensitive-revision");
  expect(redactUngovernedFact(fact).selected).toBe(false);
  expect(redactUngovernedFact(fact).temporalLabel).toBeNull();
});

it("preserves already-authorized public projection data", () => {
  const fact = { ...fictionalProfile.facts[0]!, sensitivity: "PUBLIC" };
  expect(redactUngovernedFact(fact)).toEqual(fact);
});
