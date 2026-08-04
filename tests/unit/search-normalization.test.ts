import { describe, expect, it } from "vitest";

import {
  calculateSearchWorkCost,
  hashSavedSearchAst,
  normalizeSearchInput,
  normalizeSearchText,
  parseSavedSearchAst,
  searchLexemes,
} from "@/modules/search/normalization";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchQueryBinding,
} from "@/modules/search/cursor";

const personId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7001";
const workspaceId = "018f5c90-7b9a-7c1f-8e2a-3c4d5e6f7002";
const secret = "11".repeat(32);

describe("Task 12 search contracts", () => {
  it("normalizes bounded web-search text without accepting hidden controls", () => {
    expect(normalizeSearchText("  Ａlice   Ｂob  ")).toBe("Alice Bob");
    expect(() => normalizeSearchText(`Alice\u202eBob`)).toThrowError(
      expect.objectContaining({ extensions: { code: "VALIDATION_FAILED" } }),
    );
    expect(() => normalizeSearchText("🚀".repeat(65))).toThrowError(
      expect.objectContaining({ extensions: { code: "VALIDATION_FAILED" } }),
    );
  });

  it("enforces lexical, phrase, OR, negative, and per-term work bounds", () => {
    expect(() =>
      normalizeSearchText(
        Array.from({ length: 17 }, (_, index) => `term${index}`).join(" "),
      ),
    ).toThrowError(
      expect.objectContaining({ extensions: { code: "VALIDATION_FAILED" } }),
    );
    expect(() => normalizeSearchText('"a" "b" "c" "d" "e"')).toThrow();
    expect(() => normalizeSearchText("a OR b OR c OR d OR e OR f")).toThrow();
    expect(() => normalizeSearchText("-a -b -c -d -e")).toThrow();
    expect(() => normalizeSearchText("a".repeat(65))).toThrow();
  });

  it("folds diacritics and applies PostgreSQL lowercase-OR and hyphen expansion bounds", () => {
    expect(normalizeSearchText("José or JOSE")).toBe("Jose or JOSE");
    expect(() => normalizeSearchText("a or b or c or d or e or f")).toThrow();
    expect(normalizeSearchText("a-b c-d e-f g")).toBe("a-b c-d e-f g");
    expect(() => normalizeSearchText("a-b c-d e-f g-h i-j k l")).toThrow();
  });

  it("counts OR only in PostgreSQL operator context", () => {
    expect(
      searchLexemes('"a or b"').map(({ operator, value }) => ({
        operator,
        value,
      })),
    ).toEqual([
      { operator: false, value: "a" },
      { operator: false, value: "or" },
      { operator: false, value: "b" },
    ]);
    expect(
      searchLexemes("-or x").map(({ operator, value }) => ({
        operator,
        value,
      })),
    ).toEqual([
      { operator: false, value: "or" },
      { operator: false, value: "x" },
    ]);
    expect(
      searchLexemes("a or b").map(({ operator, value }) => ({
        operator,
        value,
      })),
    ).toEqual([
      { operator: false, value: "a" },
      { operator: true, value: "or" },
      { operator: false, value: "b" },
    ]);
    expect(
      searchLexemes("a-b").map(({ operator, value }) => ({
        operator,
        value,
      })),
    ).toEqual([
      { operator: false, value: "a-b" },
      { operator: false, value: "a" },
      { operator: false, value: "b" },
    ]);

    expect(normalizeSearchText('"a or b" c or d or e or f or g')).toBe(
      '"a or b" c or d or e or f or g',
    );
    expect(normalizeSearchText("-or a or b or c or d or e")).toBe(
      "-or a or b or c or d or e",
    );
    const sixteenTerms = Array.from(
      { length: 16 },
      (_, index) => `t${index}`,
    ).join(" ");
    expect(() => normalizeSearchText(`${sixteenTerms} "or"`)).toThrow();
    expect(() => normalizeSearchText(`${sixteenTerms} -or`)).toThrow();
  });

  it("accepts each parser ceiling and rejects the immediately adjacent boundary", () => {
    const maximumBytes = [64, 64, 64, 61]
      .map((length, index) => String.fromCharCode(97 + index).repeat(length))
      .join(" ");
    expect(normalizeSearchText("a".repeat(64))).toBe("a".repeat(64));
    expect(normalizeSearchText("x ".repeat(15) + "x")).toBe(
      "x ".repeat(15) + "x",
    );
    expect(normalizeSearchText('"a" "b" "c" "d"')).toBe('"a" "b" "c" "d"');
    expect(normalizeSearchText("a OR b OR c OR d OR e")).toBe(
      "a OR b OR c OR d OR e",
    );
    expect(normalizeSearchText("-a -b -c -d e")).toBe("-a -b -c -d e");
    expect(new TextEncoder().encode(maximumBytes)).toHaveLength(256);
    expect(normalizeSearchText(maximumBytes)).toBe(maximumBytes);

    expect(() => normalizeSearchText(`${maximumBytes}e`)).toThrow();
    expect(() => normalizeSearchText("a\u0000b")).toThrow();
    expect(() => normalizeSearchText("a\u2066b")).toThrow();
    expect(() => normalizeSearchText('"a" "b" "c" "d" "e"')).toThrow();
    expect(() => normalizeSearchText("a OR b OR c OR d OR e OR f")).toThrow();
    expect(() => normalizeSearchText("-a -b -c -d -e f")).toThrow();
    expect(() => normalizeSearchText("-only -negative")).toThrow();
    expect(normalizeSearchText("positive -negative")).toBe(
      "positive -negative",
    );
  });

  it("charges bounded terms, filters, kinds, and page work centrally", () => {
    const cheap = calculateSearchWorkCost({
      filterLeaves: 0,
      first: 1,
      kinds: 1,
      terms: 1,
    });
    const expensive = calculateSearchWorkCost({
      filterLeaves: 20,
      first: 100,
      kinds: 5,
      terms: 16,
    });
    expect(expensive.budget).toBeGreaterThan(cheap.budget);
    expect(expensive.complexity).toBeGreaterThan(cheap.complexity);
    expect(
      calculateSearchWorkCost({
        filterLeaves: 10_000,
        first: 10_000,
        kinds: 10_000,
        terms: 10_000,
      }),
    ).toEqual(
      calculateSearchWorkCost({
        filterLeaves: 256,
        first: 100,
        kinds: 5,
        terms: 16,
      }),
    );
  });

  it("normalizes the closed text branch, filters, times, and page bound", () => {
    expect(
      normalizeSearchInput({
        version: 1,
        match: { type: "text", query: "  Ａlice  " },
        kinds: ["FACT", "PERSON", "FACT"],
        filters: {
          personIds: [personId.toUpperCase(), personId],
          sensitivities: ["internal", "public", "internal"],
          from: "2026-08-03T01:00:00-04:00",
          until: "2026-08-03T06:00:00Z",
        },
        first: 101,
      }),
    ).toEqual({
      version: 1,
      match: { type: "text", query: "Alice" },
      kinds: ["FACT", "PERSON"],
      filters: {
        personIds: [personId],
        sensitivities: ["internal", "public"],
        from: "2026-08-03T05:00:00.000Z",
        until: "2026-08-03T06:00:00.000Z",
      },
      first: 100,
      after: null,
    });
  });

  it("rejects unknown search keys and invalid temporal combinations", () => {
    expect(() =>
      normalizeSearchInput({
        version: 1,
        match: { type: "text", query: "Alice" },
        kinds: ["PERSON"],
        filters: {},
        first: 25,
        workspaceId,
      }),
    ).toThrowError(
      expect.objectContaining({ extensions: { code: "VALIDATION_FAILED" } }),
    );
    expect(() =>
      normalizeSearchInput({
        version: 1,
        match: { type: "text", query: "Alice" },
        kinds: ["PERSON"],
        filters: { at: "2026-08-03T05:00:00Z", from: "2026-08-03T04:00:00Z" },
      }),
    ).toThrow();
  });

  it("canonicalizes and hashes only a strict versioned savable AST", () => {
    const left = parseSavedSearchAst({
      schema: "humans.search-query",
      version: 1,
      match: { type: "text", query: "  Alice  " },
      kinds: ["PERSON", "FACT", "PERSON"],
      filters: { personIds: [personId.toUpperCase(), personId] },
      pageSize: 25,
    });
    const right = parseSavedSearchAst({
      pageSize: 25,
      filters: { personIds: [personId] },
      kinds: ["FACT", "PERSON"],
      match: { query: "Alice", type: "text" },
      version: 1,
      schema: "humans.search-query",
    });
    expect(left).toEqual(right);
    expect(hashSavedSearchAst(left)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashSavedSearchAst(left)).toBe(hashSavedSearchAst(right));
    expect(() =>
      parseSavedSearchAst({
        ...left,
        match: { type: "protectedExact", kind: "PHONE", value: "+15551234567" },
      }),
    ).toThrow();
    expect(() => parseSavedSearchAst({ ...left, after: "cursor" })).toThrow();
  });

  it("authenticates and purpose-binds text and protected cursors", () => {
    const queryHash = searchQueryBinding(secret, {
      branch: "text",
      query: "Alice",
      workspaceId,
    });
    const cursor = encodeSearchCursor(
      {
        branch: "text",
        kind: "PERSON",
        queryHash,
        rank: 0.5,
        resourceId: personId,
        updatedAt: "2026-08-03T05:00:00.000Z",
        workspaceId,
      },
      secret,
    );
    expect(
      decodeSearchCursor(cursor, {
        branch: "text",
        queryHash,
        secret,
        workspaceId,
      }),
    ).toEqual({
      branch: "text",
      kind: "PERSON",
      queryHash,
      rank: 0.5,
      resourceId: personId,
      updatedAt: "2026-08-03T05:00:00.000Z",
      workspaceId,
    });
    expect(() =>
      decodeSearchCursor(`${cursor.slice(0, -1)}A`, {
        branch: "text",
        queryHash,
        secret,
        workspaceId,
      }),
    ).toThrowError(
      expect.objectContaining({ extensions: { code: "VALIDATION_FAILED" } }),
    );
    expect(() =>
      decodeSearchCursor(cursor, {
        branch: "protectedExact",
        queryHash,
        secret,
        workspaceId,
      }),
    ).toThrow();
  });
});
