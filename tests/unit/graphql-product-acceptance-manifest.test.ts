import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

type MatrixDomain = {
  domain: string;
  generatedOperations: string[];
};

type AcceptanceMatrix = {
  contracts: Record<string, { evidence: string[] }>;
  domains: MatrixDomain[];
  version: number;
};

const requiredDomains = [
  "people",
  "facts",
  "relationships",
  "evidence",
  "files",
  "imports",
  "search",
  "graph-and-saved-views",
  "ai-analysis",
];

const requiredContracts = [
  "strict-scalars",
  "tagged-input-unions",
  "cursor-and-page-bounds",
  "batching",
  "typed-issues-and-stable-codes",
  "production-introspection",
];

describe("whole-product GraphQL acceptance manifest", () => {
  it("maps every MVP GraphQL domain and cross-cutting contract to durable evidence", async () => {
    const raw = await readFile(
      "tests/acceptance/graphql-product-matrix.json",
      "utf8",
    );
    const matrix = JSON.parse(raw) as AcceptanceMatrix;
    const generated = await readFile(
      "src/graphql/generated/graphql.ts",
      "utf8",
    );

    expect(matrix.version).toBe(1);
    expect(matrix.domains.map(({ domain }) => domain)).toEqual(requiredDomains);
    expect(Object.keys(matrix.contracts)).toEqual(requiredContracts);

    for (const entry of matrix.domains) {
      expect(entry.generatedOperations.length).toBeGreaterThan(0);
      for (const operation of entry.generatedOperations) {
        expect(generated).toContain(`export const ${operation}Document`);
      }
    }

    for (const contract of Object.values(matrix.contracts)) {
      expect(contract.evidence.length).toBeGreaterThan(0);
      for (const evidence of contract.evidence) {
        await expect(readFile(evidence, "utf8")).resolves.not.toHaveLength(0);
      }
    }
  });

  it("keeps generated client scalars explicit and strict", async () => {
    const codegen = await readFile("codegen.ts", "utf8");

    expect(codegen).toContain("strictScalars: true");
    for (const scalar of ["Date", "DateTime", "JSON", "UUID"]) {
      expect(codegen).toMatch(new RegExp(`\\b${scalar}: \\{ input:`));
    }
  });
});
