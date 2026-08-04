import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

type MatrixDomain = {
  domain: string;
  evidence: string[];
  generatedOperations: string[];
};

type AcceptanceMatrix = {
  contracts: Record<string, { evidence: string[] }>;
  domains: MatrixDomain[];
  inventorySource: string;
  remainingDomains: string[];
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
  "contacts-and-locations",
  "settings-members-api-keys-audit",
  "dashboard",
  "graph-explorer-and-saved-views",
  "graph-analysis",
  "ai-analysis",
];

const expectedRemainingDomains: string[] = [];

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

    expect(matrix.version).toBe(2);
    expect(matrix.inventorySource).toBe(
      "docs/REQUIREMENTS.md HUM-FR-007 and HUM-FR-025",
    );
    expect(matrix.remainingDomains).toEqual(expectedRemainingDomains);
    expect(
      [
        ...matrix.domains.map(({ domain }) => domain),
        ...matrix.remainingDomains,
      ].sort(),
    ).toEqual([...requiredDomains].sort());
    expect(
      matrix.domains
        .map(({ domain }) => domain)
        .filter((domain) => matrix.remainingDomains.includes(domain)),
    ).toEqual([]);
    expect(Object.keys(matrix.contracts)).toEqual(requiredContracts);

    for (const entry of matrix.domains) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.generatedOperations.length).toBeGreaterThan(0);
      const evidenceSources = await Promise.all(
        entry.evidence.map((evidence) => readFile(evidence, "utf8")),
      );
      for (const operation of entry.generatedOperations) {
        expect(generated).toContain(`export const ${operation}Document`);
        expect(
          evidenceSources.some((source) => {
            const operationThenDocument = new RegExp(
              `operationName:\\s*["']${operation}["'][\\s\\S]{0,500}query:\\s*${operation}Document`,
              "u",
            );
            const documentThenOperation = new RegExp(
              `query:\\s*${operation}Document[\\s\\S]{0,500}operationName:\\s*["']${operation}["']`,
              "u",
            );
            const wrappedRun = new RegExp(
              `name:\\s*["']${operation}["'][\\s\\S]{0,500}query:\\s*${operation}Document`,
              "u",
            );
            return (
              operationThenDocument.test(source) ||
              documentThenOperation.test(source) ||
              wrappedRun.test(source)
            );
          }),
          `${entry.domain}:${operation} must be executed by its evidence suite`,
        ).toBe(true);
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
