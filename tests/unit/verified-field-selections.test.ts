import { describe, expect, it, vi } from "vitest";

import {
  readVerifiedFieldSelections,
  type FieldSelectionPage,
} from "@/lib/verified-field-selections";

const cursor = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url");

describe("readVerifiedFieldSelections", () => {
  it("finds the displayed field selection on a later page", async () => {
    const next = cursor("selection-page-2");
    const pages = new Map<string | undefined, FieldSelectionPage>([
      [
        undefined,
        {
          nodes: [
            {
              namespace: "profile",
              fieldKey: "other",
              factId: "fact-other",
              version: 1,
            },
          ],
          hasNextPage: true,
          endCursor: next,
        },
      ],
      [
        next,
        {
          nodes: [
            {
              namespace: "profile",
              fieldKey: "birth_date",
              factId: "fact-selected",
              version: 7,
            },
          ],
          hasNextPage: false,
        },
      ],
    ]);
    const loadPage = vi.fn(async (after: string | undefined) =>
      Promise.resolve(pages.get(after) ?? null),
    );

    const result = await readVerifiedFieldSelections(
      [{ namespace: "profile", fieldKey: "birth_date" }],
      loadPage,
    );

    expect(result).toEqual({
      byField: new Map([
        ["profile:other", { factId: "fact-other", version: 1 }],
        ["profile:birth_date", { factId: "fact-selected", version: 7 }],
      ]),
      verified: true,
    });
    expect(loadPage).toHaveBeenNthCalledWith(2, next);
  });

  it("exhausts pages before verifying an absent selection", async () => {
    const next = cursor("selection-page-2");
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [],
        hasNextPage: true,
        endCursor: next,
      })
      .mockResolvedValueOnce({ nodes: [], hasNextPage: false });

    const result = await readVerifiedFieldSelections(
      [{ namespace: "profile", fieldKey: "birth_date" }],
      loadPage,
    );

    expect(result.verified).toBe(true);
    expect(result.byField).toEqual(new Map());
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["repeated", cursor("same-page")],
    ["malformed", "not a valid opaque cursor!"],
  ])("fails closed for a %s next cursor", async (_label, endCursor) => {
    const loadPage = vi.fn(async () =>
      Promise.resolve({ nodes: [], hasNextPage: true, endCursor }),
    );

    const result = await readVerifiedFieldSelections(
      [{ namespace: "profile", fieldKey: "birth_date" }],
      loadPage,
      2,
    );

    expect(result.verified).toBe(false);
  });

  it("fails closed at the defensive page ceiling", async () => {
    const cursors = [cursor("page-2"), cursor("page-3")];
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [],
        hasNextPage: true,
        endCursor: cursors[0],
      })
      .mockResolvedValueOnce({
        nodes: [],
        hasNextPage: true,
        endCursor: cursors[1],
      });

    const result = await readVerifiedFieldSelections(
      [{ namespace: "profile", fieldKey: "birth_date" }],
      loadPage,
      2,
    );

    expect(result.verified).toBe(false);
    expect(loadPage).toHaveBeenCalledTimes(2);
  });
});
