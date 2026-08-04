import { describe, expect, it } from "vitest";

import { newId } from "@/db/id";

describe("newId", () => {
  it("creates UUIDv7 identifiers", () => {
    const id = newId();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("creates identifiers that sort in generation order", () => {
    const ids = Array.from({ length: 100 }, () => newId());

    expect([...ids].sort()).toEqual(ids);
  });
});
