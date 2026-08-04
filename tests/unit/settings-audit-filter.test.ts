import { describe, expect, it } from "vitest";

import { parseAuditDateTimeRange } from "@/modules/settings/audit-filter";

describe("settings audit UTC datetime-local filters", () => {
  it("converts valid minute-local controls to canonical UTC ISO values", () => {
    expect(
      parseAuditDateTimeRange("2026-08-03T12:34", "2026-08-03T13:45"),
    ).toEqual({
      from: { input: "2026-08-03T12:34", iso: "2026-08-03T12:34:00.000Z" },
      until: { input: "2026-08-03T13:45", iso: "2026-08-03T13:45:00.000Z" },
      rangeError: null,
    });
  });

  it.each([
    ["2026-02-30T12:00", "Enter a valid UTC date and time."],
    ["2026-08-03T12:00Z", "Enter a valid UTC date and time."],
    [" 2026-08-03T12:00", "Enter a valid UTC date and time."],
    ["2026-08-03T24:00", "Enter a valid UTC date and time."],
  ])("rejects invalid or ambiguous value %s", (value, error) => {
    expect(parseAuditDateTimeRange(value, undefined).from).toEqual({
      input: value,
      error,
    });
  });

  it("accepts leap-day boundaries and rejects an inverted range", () => {
    expect(
      parseAuditDateTimeRange("2028-02-29T00:00", undefined).from.iso,
    ).toBe("2028-02-29T00:00:00.000Z");
    expect(
      parseAuditDateTimeRange("2026-08-03T13:46", "2026-08-03T13:45")
        .rangeError,
    ).toBe("From must be earlier than or equal to Until.");
  });
});
