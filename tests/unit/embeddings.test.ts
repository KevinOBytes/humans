import { describe, expect, it } from "vitest";

import { validateEmbedding } from "@/modules/search/embeddings";

describe("optional embedding contract", () => {
  it("accepts finite vectors with exact bounded dimensions", () => {
    expect(validateEmbedding([0.1, -0.2], 2)).toEqual([0.1, -0.2]);
  });

  it.each([
    [[0.1], 2],
    [[Number.NaN], 1],
    [[Number.POSITIVE_INFINITY], 1],
    [[], 0],
    [Array.from({ length: 4097 }, () => 0), 4097],
  ])("rejects invalid vector %#", (vector, dimensions) => {
    expect(() => validateEmbedding(vector as number[], dimensions)).toThrow(
      "Embedding dimensions or values are invalid",
    );
  });
});
