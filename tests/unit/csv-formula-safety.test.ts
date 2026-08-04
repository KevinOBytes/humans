import { describe, expect, it } from "vitest";

import {
  formulaRisk,
  neutralizeSpreadsheetCell,
} from "@/modules/imports/mapper";

describe("spreadsheet formula safety", () => {
  it("detects ASCII and full-width formula prefixes after whitespace", () => {
    for (const value of ["=1+1", "  +cmd", "\t@SUM(A1)", "\n-2", "  ＝1"]) {
      expect(formulaRisk(value)).toBe(true);
      expect(neutralizeSpreadsheetCell(value)).toMatch(/^'/u);
    }
    expect(formulaRisk("Ada Lovelace")).toBe(false);
  });
});
