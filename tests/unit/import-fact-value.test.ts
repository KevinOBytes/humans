import { describe, expect, it } from "vitest";

import { importFactValue } from "@/modules/imports/fact-value";

const uuid = "01900000-0000-7000-8000-000000000001";

describe("typed import fact conversion", () => {
  it.each([
    ["text", " Ada ", { text: "Ada" }],
    ["rich_text", "Line one\nLine two", { text: "Line one\nLine two" }],
    ["integer", 42, { decimal: "42" }],
    ["decimal", "12.50", { decimal: "12.50" }],
    ["boolean", "FALSE", { boolean: false }],
    ["date", "2026-08-01", { dateStart: "2026-08-01" }],
    [
      "date_range",
      '{"dateStart":"2026-08-01","dateEnd":"2026-08-31"}',
      { dateStart: "2026-08-01", dateEnd: "2026-08-31" },
    ],
    [
      "timestamp",
      "2026-08-01T12:00:00Z",
      { timestamp: "2026-08-01T12:00:00Z" },
    ],
    [
      "duration",
      { decimal: "3", unit: "days" },
      { decimal: "3", unit: "days" },
    ],
    [
      "quantity",
      '{"decimal":"12.5","unit":"kg"}',
      { decimal: "12.5", unit: "kg" },
    ],
    [
      "uri",
      "https://example.test/person",
      { text: "https://example.test/person" },
    ],
    ["json", { verified: true }, { json: { verified: true } }],
    ["person_reference", uuid, { referencedPersonId: uuid }],
    ["place_reference", uuid, { placeId: uuid }],
    ["file_reference", uuid, { fileId: uuid }],
  ] as const)("converts %s values", (type, value, expected) => {
    expect(importFactValue(type, value)).toEqual(expected);
  });

  it.each([
    ["text", 12],
    ["integer", Number.MAX_SAFE_INTEGER + 1],
    ["boolean", "yes"],
    ["date_range", '{"dateStart":"2026-08-01"}'],
    ["duration", '{"decimal":"3"}'],
    ["json", "not-json"],
    ["unsupported", "value"],
  ] as const)("rejects invalid %s values", (type, value) => {
    expect(() => importFactValue(type, value)).toThrow(
      /fact|safe|expected|unsupported/i,
    );
  });
});
