import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { schema as graphqlSchema } from "@/graphql/schema";

describe("workspace teams domain", () => {
  it("keeps team records and membership workspace-bound with safe role checks", () => {
    expect(schema.teams.workspaceId.notNull).toBe(true);
    expect(schema.teamMembers.workspaceId.notNull).toBe(true);
    expect(schema.caseTeamLinks.workspaceId.notNull).toBe(true);
    expect(schema.teamMembers.principalId.notNull).toBe(true);
    expect(
      getTableConfig(schema.teams).checks.map((check) => check.name),
    ).toEqual(
      expect.arrayContaining([
        "teams_state_check",
        "teams_text_check",
        "teams_version_check",
      ]),
    );
    expect(
      getTableConfig(schema.teamMembers).checks.map((check) => check.name),
    ).toEqual(
      expect.arrayContaining([
        "team_members_role_check",
        "team_members_version_check",
      ]),
    );
    expect(
      getTableConfig(schema.teamMembers).uniqueConstraints.map(
        (constraint) => constraint.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "team_members_workspace_id_unique",
        "team_members_principal_unique",
      ]),
    );
    expect(
      getTableConfig(schema.caseTeamLinks).uniqueConstraints.map(
        (constraint) => constraint.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "case_team_links_workspace_id_unique",
        "case_team_links_case_team_unique",
      ]),
    );
  });

  it("exposes read and least-privilege membership mutations through GraphQL", () => {
    expect(graphqlSchema.getQueryType()?.getFields()).toEqual(
      expect.objectContaining({
        team: expect.anything(),
        teams: expect.anything(),
        teamMembers: expect.anything(),
        caseTeams: expect.anything(),
      }),
    );
    expect(graphqlSchema.getMutationType()?.getFields()).toEqual(
      expect.objectContaining({
        createTeam: expect.anything(),
        addTeamMember: expect.anything(),
        removeTeamMember: expect.anything(),
        linkTeamToCase: expect.anything(),
        unlinkTeamFromCase: expect.anything(),
      }),
    );
    expect(graphqlSchema.getType("TeamMember")).toBeDefined();
  });
});
