// @vitest-environment node

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { people } from "@/db/schema/people";

describe("graph workspace read indexes", () => {
  it("indexes the exact visible-person sort used by bounded graph reads", () => {
    const indexes = getTableConfig(people).indexes;
    const index = indexes.find(
      (candidate) => candidate.config.name === "people_workspace_sort_idx",
    );

    expect(index).toBeDefined();
    expect(index?.config.where).toBeDefined();
    expect(index?.config.columns).toHaveLength(3);
  });
});
