// @vitest-environment node

import { describe, expect, it } from "vitest";

import { decodeResearchCursor } from "@/graphql/limits";
import { decodeCursor } from "@/modules/people/service";

describe("research connection cursors", () => {
  const validCursor = Buffer.from(
    JSON.stringify({
      v: 1,
      o: "people-name-asc",
      s: "alice",
      i: "01986d1f-6c57-7f08-91ff-7203dc200722",
    }),
  ).toString("base64url");

  it("accepts only canonical unpadded base64url wrappers", () => {
    expect(decodeResearchCursor(validCursor, "people-name-asc")).toMatchObject({
      s: "alice",
    });
    for (const cursor of [
      "",
      `${validCursor}=`,
      ` ${validCursor}`,
      `${validCursor} `,
      `${validCursor}!`,
      `${validCursor.slice(0, 4)}\n${validCursor.slice(4)}`,
    ]) {
      expect(() =>
        decodeResearchCursor(cursor, "people-name-asc"),
      ).toThrowError(/cursor is invalid/iu);
    }
  });

  it("rejects a structured cursor whose tie-breaker is not a strict UUID", () => {
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        o: "people-name-asc",
        s: "alice",
        i: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    ).toString("base64url");

    expect(() => decodeCursor(cursor, "people-name-asc")).toThrowError(
      /cursor is invalid/iu,
    );
  });

  it.each([
    ["fact-definition-key-asc", { n: "person", k: "name" }],
    ["facts-asserted-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["fact-revision-desc", { r: 1 }],
    ["fact-relationship-created-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["relationship-type-key-asc", { n: "person", k: "knows" }],
    ["relationship-created-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["source-created-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["evidence-created-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["excerpt-created-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["fact-evidence-created-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["relationship-evidence-created-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["note-updated-desc", { t: "2026-08-01T00:00:00.000Z" }],
    ["tag-name-asc", { n: "safe" }],
    ["subject-tag-name-asc", { n: "safe" }],
    ["audit-occurred-desc", { t: "2026-08-01T00:00:00.000Z" }],
  ] as const)("rejects a malformed UUID for %s", (order, sort) => {
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        o: order,
        ...sort,
        i: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    ).toString("base64url");

    expect(() => decodeResearchCursor(cursor, order)).toThrowError(
      /cursor is invalid/iu,
    );
  });

  it("rejects a non-canonical or invalid timestamp before query construction", () => {
    for (const timestamp of [
      "not-a-date",
      "2026-08-01",
      "2026-13-01T00:00:00Z",
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({
          v: 1,
          o: "audit-occurred-desc",
          t: timestamp,
          i: "01986d1f-6c57-7f08-91ff-7203dc200722",
        }),
      ).toString("base64url");
      expect(() =>
        decodeResearchCursor(cursor, "audit-occurred-desc"),
      ).toThrowError(/cursor is invalid/iu);
    }
  });

  it("accepts only bounded canonical selection keys", () => {
    const selectionCursor = (namespace: string, fieldKey: string) =>
      Buffer.from(
        JSON.stringify({
          v: 1,
          o: "person-field-selection-key-asc",
          n: namespace,
          k: fieldKey,
          i: "01986d1f-6c57-7f08-91ff-7203dc200722",
        }),
      ).toString("base64url");

    expect(
      decodeResearchCursor(
        selectionCursor("profile", "birth_place"),
        "person-field-selection-key-asc",
      ),
    ).toMatchObject({ n: "profile", k: "birth_place" });
    for (const [namespace, fieldKey] of [
      ["profile\u0000hidden", "birth_place"],
      ["Profile", "birth_place"],
      ["a".repeat(65), "birth_place"],
      ["profile", "birth place"],
      ["profile", "a".repeat(65)],
    ]) {
      expect(() =>
        decodeResearchCursor(
          selectionCursor(namespace, fieldKey),
          "person-field-selection-key-asc",
        ),
      ).toThrowError(/cursor is invalid/iu);
    }
  });
});
