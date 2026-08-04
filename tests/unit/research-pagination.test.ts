import { describe, expect, it } from "vitest";

import { profilePageHref, readOpaqueCursor } from "@/lib/research-pagination";

describe("research pagination URL state", () => {
  it("accepts canonical bounded opaque cursors and rejects ambiguous input", () => {
    expect(readOpaqueCursor("eyJpZCI6IjEyMyJ9")).toBe("eyJpZCI6IjEyMyJ9");
    expect(readOpaqueCursor(["cursor-a", "cursor-b"])).toBeUndefined();
    expect(readOpaqueCursor("not/a/cursor")).toBeUndefined();
    expect(readOpaqueCursor("a".repeat(1025))).toBeUndefined();
  });

  it("creates section-specific continuation links without dropping the view", () => {
    expect(
      profilePageHref("person-a", "facts", {
        factAfter: "cursor-next",
        factDetail: "fact-a",
      }),
    ).toBe(
      "/people/person-a?view=facts&factAfter=cursor-next&factDetail=fact-a",
    );
  });
});
