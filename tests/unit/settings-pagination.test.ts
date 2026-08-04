import { describe, expect, it } from "vitest";

import {
  SETTINGS_PAGE_SIZE,
  buildSafeSettingsPage,
  normalizeSettingsOffset,
  readSettingsOffset,
} from "@/modules/settings/pagination";

describe("settings pagination", () => {
  it.each([undefined, "", "-25", "1", "25.5", "100000000", ["25"]])(
    "falls back safely for invalid offset %j",
    (value) => expect(readSettingsOffset(value)).toBe(0),
  );

  it("accepts bounded page-aligned offsets", () => {
    expect(readSettingsOffset("25")).toBe(SETTINGS_PAGE_SIZE);
    expect(readSettingsOffset("100")).toBe(100);
    expect(normalizeSettingsOffset(100)).toBe(100);
    expect(normalizeSettingsOffset(-25)).toBe(0);
    expect(normalizeSettingsOffset(1)).toBe(0);
  });

  it("projects explicit total and continuation state", () => {
    expect(buildSafeSettingsPage(["row"], 100, 102)).toEqual({
      nodes: ["row"],
      offset: 100,
      limit: SETTINGS_PAGE_SIZE,
      total: 102,
      hasPrevious: true,
      hasMore: true,
    });
  });
});
