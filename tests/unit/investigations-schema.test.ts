import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { schema as graphqlSchema } from "@/graphql/schema";

describe("workspace investigations domain", () => {
  it("keeps investigations and case links workspace-scoped and temporal", () => {
    expect(schema.investigations.workspaceId.notNull).toBe(true);
    expect(schema.investigationCaseLinks.workspaceId.notNull).toBe(true);
    expect(schema.investigations.number.notNull).toBe(true);
    expect(schema.investigations.leadPrincipalId.notNull).toBe(true);
    expect(
      getTableConfig(schema.investigations).checks.map((check) => check.name),
    ).toEqual(
      expect.arrayContaining([
        "investigations_state_check",
        "investigations_dates_check",
        "investigations_deleted_attribution_check",
      ]),
    );
    expect(
      getTableConfig(schema.investigations).uniqueConstraints.map(
        (constraint) => constraint.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "investigations_workspace_id_unique",
        "investigations_workspace_number_unique",
        "investigations_workspace_slug_unique",
      ]),
    );
  });

  it("exposes investigation reads and idempotent case-link creation", () => {
    expect(graphqlSchema.getQueryType()?.getFields()).toEqual(
      expect.objectContaining({
        investigation: expect.anything(),
        investigations: expect.anything(),
        investigationCases: expect.anything(),
      }),
    );
    expect(graphqlSchema.getMutationType()?.getFields()).toEqual(
      expect.objectContaining({
        createInvestigation: expect.anything(),
        linkCaseToInvestigation: expect.anything(),
      }),
    );
    expect(graphqlSchema.getType("Investigation")).toBeDefined();
  });
});
