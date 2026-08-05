import { describe, expect, it } from "vitest";

import {
  parseFactDraft,
  supportedFactValueType,
} from "@/components/facts/fact-value";
import { factDisplayValue } from "@/components/facts/fact-display-value";

describe("fact draft parsing", () => {
  it("parses Boolean values explicitly without coercing arbitrary text", () => {
    expect(parseFactDraft("BOOLEAN", { value: "true" })).toEqual({
      value: { boolean: true },
    });
    expect(parseFactDraft("BOOLEAN", { value: "false" })).toEqual({
      value: { boolean: false },
    });
    expect(parseFactDraft("BOOLEAN", { value: "not-a-boolean" })).toEqual({
      error: "Choose true or false.",
      field: "value",
    });
  });

  it("keeps invalid JSON and incomplete date ranges as actionable drafts", () => {
    expect(parseFactDraft("JSON", { value: '{"open":' })).toEqual({
      error: "Enter valid JSON.",
      field: "value",
    });
    expect(
      parseFactDraft("DATE_RANGE", {
        value: "1815-12-10",
        valueEnd: "",
      }),
    ).toEqual({
      error: "Choose an end date.",
      field: "valueEnd",
    });
    expect(
      parseFactDraft("DATE_RANGE", {
        value: "1815-12-10",
        valueEnd: "1815-12-12",
      }),
    ).toEqual({
      value: { dateStart: "1815-12-10", dateEnd: "1815-12-12" },
    });
  });

  it("only advertises types implemented with safe controls", () => {
    expect(supportedFactValueType("TEXT")).toBe(true);
    expect(supportedFactValueType("QUANTITY")).toBe(true);
    expect(supportedFactValueType("PERSON_REFERENCE")).toBe(false);
    expect(supportedFactValueType("PLACE_REFERENCE")).toBe(false);
    expect(supportedFactValueType("FILE_REFERENCE")).toBe(false);
  });

  it("renders a file-backed claim as a safe reference label", () => {
    expect(
      factDisplayValue({
        fileId: "018f5f39-9ca7-7b67-a2f1-b8a82ca894d1",
        text: null,
        dateStart: null,
        dateEnd: null,
        decimal: null,
        boolean: null,
        timestamp: null,
        json: null,
        referencedPersonId: null,
        placeId: null,
        unit: null,
      }),
    ).toBe("Referenced file");
  });
});
