import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_FACT_DEFINITIONS,
  createDefaultProfileFactDefinitions,
} from "@/db/profile-fact-definitions";

describe("default profile fact definition catalog", () => {
  it("covers the structured rich-profile fields without introducing sensitive defaults", () => {
    expect(
      DEFAULT_PROFILE_FACT_DEFINITIONS.map(({ fieldKey }) => fieldKey),
    ).toEqual([
      "pronouns",
      "employment",
      "education",
      "language",
      "organization",
      "birth_date",
      "custom_note",
    ]);

    expect(
      DEFAULT_PROFILE_FACT_DEFINITIONS.filter(
        ({ cardinality }) => cardinality === "many",
      ).map(({ fieldKey }) => fieldKey),
    ).toEqual([
      "pronouns",
      "employment",
      "education",
      "language",
      "organization",
      "custom_note",
    ]);

    expect(
      DEFAULT_PROFILE_FACT_DEFINITIONS.filter(
        ({ fieldKey }) => fieldKey !== "birth_date",
      ).every(({ defaultSensitivity }) => defaultSensitivity === "internal"),
    ).toBe(true);
    expect(
      DEFAULT_PROFILE_FACT_DEFINITIONS.find(
        ({ fieldKey }) => fieldKey === "birth_date",
      )?.defaultSensitivity,
    ).toBe("confidential");
  });

  it("binds every catalog row to the new workspace and owner principal", () => {
    const rows = createDefaultProfileFactDefinitions({
      workspaceId: "018f0000-0000-7000-8000-000000000001",
      actorId: "018f0000-0000-7000-8000-000000000002",
      idFactory: (() => {
        let index = 0;
        return () =>
          `018f0000-0000-7000-8000-${String(++index).padStart(12, "0")}`;
      })(),
    });

    expect(rows).toHaveLength(DEFAULT_PROFILE_FACT_DEFINITIONS.length);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "018f0000-0000-7000-8000-000000000001",
          fieldKey: "employment",
          state: "active",
          createdBy: "018f0000-0000-7000-8000-000000000002",
          updatedBy: "018f0000-0000-7000-8000-000000000002",
        }),
      ]),
    );
  });
});
