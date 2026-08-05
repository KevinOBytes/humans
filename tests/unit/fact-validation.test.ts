// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createLoaders,
  invalidateVisibilityDependentLoaders,
  type GraphQLServices,
} from "@/graphql/loaders";
import { schema } from "@/graphql/schema";
import * as validation from "@/modules/facts/validation";

describe("research GraphQL validation contract", () => {
  it("accepts the typed person creation contract", () => {
    const mutation = schema.getMutationType();
    expect(mutation).toBeDefined();
    expect(mutation?.getFields()).toHaveProperty("createPerson");
    expect(schema.getType("CreatePersonInput")).toBeDefined();
    const personType = schema.getType("Person") as
      { getFields?: () => Record<string, unknown> } | undefined;
    expect(typeof personType?.getFields).toBe("function");
    expect(personType?.getFields?.()).toHaveProperty("contradictoryFacts");
  });
});

describe("research value validation", () => {
  it("normalizes governed keys, tags, and undirected UUID endpoints", () => {
    expect(validation.normalizeNamespaceKey("  custom.person-name  ")).toEqual({
      issues: [],
      value: "custom.person-name",
    });
    expect(validation.normalizeTagName("  Résumé   Review ")).toEqual({
      issues: [],
      value: "résumé review",
    });
    expect(
      validation.canonicalizeRelationshipEndpoints(
        "0198a3c0-0000-7000-8000-000000000002",
        "0198a3c0-0000-7000-8000-000000000001",
        false,
      ),
    ).toEqual([
      "0198a3c0-0000-7000-8000-000000000001",
      "0198a3c0-0000-7000-8000-000000000002",
    ]);
  });

  it("rejects decimal overflow, silent rounding, and malformed checksums", () => {
    expect(
      validation.validateDecimal("1.0001", { maxScale: 3 }).issues,
    ).not.toEqual([]);
    expect(
      validation.validateDecimal("1e3", { maxScale: 12 }).issues,
    ).not.toEqual([]);
    expect(
      validation.validateChecksum(`sha256:${"A".repeat(64)}`).issues,
    ).not.toEqual([]);
  });

  it("enforces bounded plain JSON without prototype values", () => {
    expect(
      validation.validateBoundedJson({ safe: [1, true, null] }).issues,
    ).toEqual([]);
    expect(
      validation.validateBoundedJson({ nested: { value: BigInt(1) } }).issues,
    ).not.toEqual([]);
  });

  it("enforces exact temporal semantics", () => {
    expect(
      validation.validateTemporal({
        earliest: "2026-01-01T00:00:00.000Z",
        latest: null,
        precision: "day",
        semantics: "exact",
      }).issues,
    ).toEqual([]);
    expect(
      validation.validateTemporal({
        earliest: null,
        latest: null,
        precision: "day",
        semantics: "unknown",
      }).issues,
    ).not.toEqual([]);
  });

  it.each([
    ["unknown", "unknown", null, null],
    ["exact", "second", "2026-01-01T00:00:00Z", null],
    ["before", "day", null, "2026-01-01T00:00:00Z"],
    ["after", "day", "2026-01-01T00:00:00Z", null],
    ["between", "range", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
    ["approximate", "day", "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"],
    [
      "year_only",
      "year",
      "2026-01-01T00:00:00.000Z",
      "2026-12-31T23:59:59.999Z",
    ],
  ])(
    "accepts valid %s temporal bounds",
    (semantics, precision, earliest, latest) => {
      expect(
        validation.validateTemporal({ semantics, precision, earliest, latest })
          .issues,
      ).toEqual([]);
    },
  );

  it.each([
    ["unknown", "unknown", "2026-01-01T00:00:00Z", null],
    ["exact", "second", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
    ["before", "day", "2026-01-01T00:00:00Z", null],
    ["after", "day", null, "2026-01-01T00:00:00Z"],
    ["between", "day", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
    ["approximate", "unknown", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
    ["year_only", "year", "2026-02-01T00:00:00Z", "2026-12-31T23:59:59Z"],
    ["between", "range", "2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z"],
  ])(
    "rejects invalid %s temporal bounds",
    (semantics, precision, earliest, latest) => {
      expect(
        validation.validateTemporal({ semantics, precision, earliest, latest })
          .issues,
      ).not.toEqual([]);
    },
  );

  it("distinguishes valid values, schema mismatches, and unusable stored schemas", () => {
    const schema = {
      type: "object",
      required: ["approved"],
      properties: { approved: { const: true } },
      additionalProperties: false,
    };
    expect(
      validation.validateJsonSchema("unit-valid", schema, { approved: true }),
    ).toEqual({ value: { approved: true }, issues: [] });
    expect(
      validation.validateJsonSchema("unit-mismatch", schema, {
        approved: false,
      }).issues,
    ).toEqual([expect.objectContaining({ code: "SCHEMA_VALIDATION" })]);
    expect(
      validation.validateJsonSchema(
        "unit-invalid-schema",
        { type: "definitely-not-a-json-schema-type" },
        {},
      ).issues,
    ).toEqual([expect.objectContaining({ code: "INVALID_STORED_SCHEMA" })]);
  });

  it("sanitizes Markdown HTML and enforces the note content one-of", () => {
    expect(
      validation.validateNoteContent({
        markdown: "hello <script>secret()</script> **world**",
      }),
    ).toEqual({
      issues: [],
      value: { plainText: null, sanitizedMarkdown: "hello  **world**" },
    });
    expect(
      validation.validateNoteContent({ markdown: "x", plainText: "y" }).issues,
    ).not.toEqual([]);
  });

  it.each([
    "[x](javascript:alert(1))",
    "![x](data:image/svg+xml,<svg/onload=alert(1)>)",
    "[x](java%73cript:alert(1))",
    "[x](jav&#x61;script&#58;alert(1))",
    "[x](java\\script:alert(1))",
    "[x](java\nscript:alert(1))",
    "[x](java\u0000script:alert(1))",
    "[x]: jAvAsCrIp:alert(1)",
    "<data:text/html,alert(1)>",
    "[x](//attacker.example/path)",
    "[x](&sol;&sol;attacker.example/path)",
    "![x](&sol;&sol;attacker.example/image.svg)",
    "[x][unsafe]\n\n[unsafe]: &sol;&sol;attacker.example/path",
    "[x](java&Tab;script&colon;alert&lpar;1&rpar;)",
    "[x](%25252525256a%252525252561vascript%25252525253Aalert(1))",
    "[x](ja&#118;ascript&#58;alert&#40;1&#41;)",
  ])("rejects an unsafe or obfuscated Markdown destination: %s", (markdown) => {
    expect(validation.validateNoteContent({ markdown }).issues).toEqual([
      expect.objectContaining({ code: "UNSAFE_MARKDOWN_DESTINATION" }),
    ]);
  });

  it.each([
    "[web](https://example.test/path?q=1#x)",
    "[mail](mailto:person@example.test)",
    "[root](/safe/path)",
    "[local](./safe/path)",
    "[parent](../safe/path)",
    "[anchor](#safe)",
    "[query](?safe=1)",
    "[reference][safe]\n\n[safe]: https://example.test",
    '[title](https://example.test/a_(b) "Safe title")',
    "![relative](images/example.png)",
  ])("accepts a safe Markdown destination: %s", (markdown) => {
    expect(validation.validateNoteContent({ markdown }).issues).toEqual([]);
  });

  it.each([
    "`literal ](javascript:alert(1)) example`",
    "```text\nliteral ](data:text/html,example)\n```",
    String.raw`escaped literal \[label\]\(javascript:example\)`,
    String.raw`\[x](javascript:alert(1))`,
  ])(
    "accepts an unsafe-looking destination outside CommonMark links: %s",
    (markdown) => {
      expect(validation.validateNoteContent({ markdown }).issues).toEqual([]);
    },
  );

  it.each([
    ["text", { text: "value" }],
    ["rich_text", { text: "**value**" }],
    ["integer", { decimal: "42" }],
    ["decimal", { decimal: "42.125" }],
    ["boolean", { boolean: false }],
    ["date", { dateStart: "2026-07-31" }],
    ["date_range", { dateStart: "2026-07-01", dateEnd: "2026-07-31" }],
    ["timestamp", { timestamp: "2026-07-31T12:00:00Z" }],
    ["duration", { decimal: "90", unit: "minute" }],
    ["uri", { text: "https://example.test/resource" }],
    ["json", { json: { safe: true } }],
    [
      "person_reference",
      { referencedPersonId: "0198a3c0-0000-7000-8000-000000000001" },
    ],
    ["place_reference", { placeId: "0198a3c0-0000-7000-8000-000000000002" }],
    ["file_reference", { fileId: "0198a3c0-0000-7000-8000-000000000003" }],
    ["quantity", { decimal: "12.5", unit: "kg" }],
  ])("accepts the %s fact value representation", (type, value) => {
    expect(validation.validateFactValue(type, value).issues).toEqual([]);
  });

  it.each([
    ["text", { decimal: "1" }],
    ["rich_text", { text: "" }],
    ["integer", { decimal: "1.1" }],
    ["decimal", { decimal: "1e2" }],
    ["boolean", { boolean: true, text: "extra" }],
    ["date", { dateStart: "2026-02-30" }],
    ["date_range", { dateStart: "2026-08-01", dateEnd: "2026-07-31" }],
    ["timestamp", { timestamp: "2026-07-31 12:00:00" }],
    ["duration", { decimal: "90" }],
    ["uri", { text: "javascript:alert(1)" }],
    ["json", { json: BigInt(1) }],
    ["person_reference", { referencedPersonId: "not-a-uuid" }],
    ["place_reference", { placeId: "not-a-uuid" }],
    ["file_reference", { fileId: "not-a-uuid" }],
    ["quantity", { decimal: "12.5" }],
  ])("rejects an invalid %s fact value representation", (type, value) => {
    expect(validation.validateFactValue(type, value).issues).not.toEqual([]);
  });

  it("batches composite nested pages once and preserves parent order", async () => {
    const factPages = vi.fn(async (keys: readonly { personId: string }[]) =>
      keys.map((key) => ({
        nodes: [{ id: `fact-${key.personId}` }],
        pageInfo: { endCursor: null, hasNextPage: false },
      })),
    );
    const relationshipPages = vi.fn(
      async (keys: readonly { personId: string }[]) =>
        keys.map((key) => ({
          nodes: [{ id: `relationship-${key.personId}` }],
          pageInfo: { endCursor: null, hasNextPage: false },
        })),
    );
    const services = {
      facts: { listForPeople: factPages },
      relationships: { listForPeople: relationshipPages },
    } as unknown as GraphQLServices;
    const loaders = createLoaders({
      services,
      workspaceId: "0198a3c0-0000-7000-8000-000000000001",
    });
    const keys = [
      { personId: "b", first: 5, after: null },
      { personId: "a", first: 5, after: null },
    ];
    const [facts, relationships] = await Promise.all([
      Promise.all(keys.map((key) => loaders.factsByPerson.load(key))),
      Promise.all(keys.map((key) => loaders.relationshipsByPerson.load(key))),
    ]);
    expect(factPages).toHaveBeenCalledTimes(1);
    expect(relationshipPages).toHaveBeenCalledTimes(1);
    expect(facts.map((page) => page.nodes[0]?.id)).toEqual([
      "fact-b",
      "fact-a",
    ]);
    expect(relationships.map((page) => page.nodes[0]?.id)).toEqual([
      "relationship-b",
      "relationship-a",
    ]);
  });

  it("caps composite batches at 100 and keeps cursor-bearing cache keys distinct", async () => {
    const factPages = vi.fn(
      async (
        keys: readonly {
          personId: string;
          first: number;
          after: string | null;
        }[],
      ) =>
        keys.map((key) => ({
          nodes: [{ id: `${key.personId}:${key.after ?? "first"}` }],
          pageInfo: { endCursor: null, hasNextPage: false },
        })),
    );
    const services = {
      facts: { listForPeople: factPages },
    } as unknown as GraphQLServices;
    const loaders = createLoaders({
      services,
      workspaceId: "0198a3c0-0000-7000-8000-000000000001",
    });

    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        loaders.factsByPerson.load({
          personId: `person-${index}`,
          first: 1,
          after: null,
        }),
      ),
    );
    expect(factPages.mock.calls.map(([keys]) => keys.length)).toEqual([100, 1]);

    factPages.mockClear();
    loaders.factsByPerson.clearAll();
    const first = loaders.factsByPerson.load({
      personId: "same-parent",
      first: 1,
      after: null,
    });
    const second = loaders.factsByPerson.load({
      personId: "same-parent",
      first: 1,
      after: "second-page-cursor",
    });
    expect((await first).nodes[0]?.id).toBe("same-parent:first");
    expect((await second).nodes[0]?.id).toBe("same-parent:second-page-cursor");
    expect(factPages).toHaveBeenCalledTimes(1);
    expect(factPages.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("clears selection pages when person or fact visibility changes", async () => {
    let selectedFactId = "fact-before";
    const selectionPages = vi.fn(
      async (keys: readonly { personId: string }[]) =>
        keys.map(() => ({
          nodes: [{ factId: selectedFactId }],
          pageInfo: { endCursor: null, hasNextPage: false },
        })),
    );
    const services = {
      facts: { listSelectionsForPeople: selectionPages },
    } as unknown as GraphQLServices;
    const loaders = createLoaders({
      services,
      workspaceId: "0198a3c0-0000-7000-8000-000000000001",
    });
    const key = { personId: "person-1", first: 10, after: null };

    expect((await loaders.fieldSelectionsByPerson.load(key)).nodes).toEqual([
      { factId: "fact-before" },
    ]);
    selectedFactId = "fact-after-sensitivity-change";
    invalidateVisibilityDependentLoaders(loaders, {
      id: "fact-before",
      kind: "fact",
    });
    expect((await loaders.fieldSelectionsByPerson.load(key)).nodes).toEqual([
      { factId: "fact-after-sensitivity-change" },
    ]);
    selectedFactId = "fact-after-person-lifecycle";
    invalidateVisibilityDependentLoaders(loaders, {
      id: "person-1",
      kind: "person",
    });
    expect((await loaders.fieldSelectionsByPerson.load(key)).nodes).toEqual([
      { factId: "fact-after-person-lifecycle" },
    ]);
    expect(selectionPages).toHaveBeenCalledTimes(3);
  });
});
