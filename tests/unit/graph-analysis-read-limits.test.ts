import { describe, expect, it } from "vitest";

import {
  ANALYSIS_MANIFEST_AUTHORIZATION_COST,
  ANALYSIS_READ_OPERATION_CLASS,
  ANALYSIS_READ_POLICY,
  analysisExportComplexity,
  analysisResultReadComplexity,
  analysisResultReadCost,
  analysisRunListComplexity,
  analysisRunListReadCost,
  analysisRunReadComplexity,
  analysisRunReadCost,
} from "@/modules/graph/analysis-read-limits";

describe("analysis manifest read limits", () => {
  it("uses an isolated class and policy large enough for one bounded maximum page", () => {
    expect(ANALYSIS_READ_OPERATION_CLASS).toBe("graph.analysis.read");
    expect(ANALYSIS_MANIFEST_AUTHORIZATION_COST).toBe(4_800);
    expect(ANALYSIS_READ_POLICY).toEqual({
      capacity: 500_000,
      refillAmount: 500_000,
      refillIntervalMs: 60_000,
      ttlMs: 60_000,
    });
    expect(analysisRunListReadCost(100)).toBe(484_800);
    expect(analysisRunListReadCost(100)).toBeLessThanOrEqual(
      ANALYSIS_READ_POLICY.capacity,
    );
  });

  it("charges maximum manifest authorization for point reads and every list candidate", () => {
    expect(analysisRunReadCost()).toBe(4_800);
    expect(analysisRunListReadCost(1)).toBe(9_600);
    expect(analysisRunListReadCost(10)).toBe(52_800);
    expect(analysisRunListReadCost(100)).toBe(484_800);
    expect(analysisRunListReadCost(1)).toBeLessThan(
      analysisRunListReadCost(10),
    );
    expect(analysisRunListReadCost(10)).toBeLessThan(
      analysisRunListReadCost(100),
    );
  });

  it("adds the bounded result page cost without making the supported first=100 unusable", () => {
    expect(analysisResultReadCost(1)).toBe(4_801);
    expect(analysisResultReadCost(100)).toBe(4_900);
    expect(analysisResultReadCost(1)).toBeLessThan(analysisResultReadCost(100));
    expect(analysisResultReadCost(100)).toBeLessThan(
      ANALYSIS_READ_POLICY.capacity,
    );
  });

  it("assigns monotonic GraphQL complexity while allowing each supported UI page", () => {
    expect(analysisRunReadComplexity()).toBe(240);
    expect(analysisRunListComplexity(1)).toBe(244);
    expect(analysisRunListComplexity(10)).toBe(262);
    expect(analysisRunListComplexity(100)).toBe(442);
    expect(analysisResultReadComplexity(1)).toBe(241);
    expect(analysisResultReadComplexity(100)).toBe(340);
    expect(analysisRunListComplexity(10)).toBeLessThan(
      analysisRunListComplexity(100),
    );
    expect(analysisResultReadComplexity(1)).toBeLessThan(
      analysisResultReadComplexity(100),
    );
  });

  it("allows the bounded analysis export while rejecting invalid page sizes", () => {
    expect(analysisExportComplexity(1)).toBe(351);
    expect(analysisExportComplexity(100)).toBe(360);
    expect(analysisExportComplexity(1_000)).toBe(450);
    expect(analysisExportComplexity(1)).toBeLessThan(
      analysisExportComplexity(1_000),
    );
    expect(analysisExportComplexity()).toBe(450);
    expect(analysisExportComplexity(0)).toBe(501);
    expect(analysisExportComplexity(1_001)).toBe(501);
  });
});
