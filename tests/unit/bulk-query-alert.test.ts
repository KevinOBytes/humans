import { describe, expect, it } from "vitest";

import {
  BULK_QUERY_ALERT_RESULT_THRESHOLD,
  bulkQueryAlertResourceId,
} from "@/modules/search/service";

describe("bulk search audit alert contract", () => {
  it("uses the capped page size as the alert threshold", () => {
    expect(BULK_QUERY_ALERT_RESULT_THRESHOLD).toBe(100);
  });

  it("derives a stable opaque UUID without embedding the query", () => {
    const first = bulkQueryAlertResourceId("a".repeat(64));
    const second = bulkQueryAlertResourceId("b".repeat(64));

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(second).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first).not.toBe(second);
    expect(first).not.toContain("a".repeat(16));
    expect(bulkQueryAlertResourceId("a".repeat(64))).toBe(first);
  });
});
