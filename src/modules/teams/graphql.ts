import { builder } from "@/graphql/builder";
import { normalizePagination } from "@/graphql/limits";
import type { CaseTeamLinkRow, TeamMemberRow, TeamRow } from "./types";

const Team = builder.objectRef<TeamRow>("Team").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    state: t.exposeString("state"),
    version: t.exposeInt("version"),
    createdAt: t.field({
      type: "DateTime",
      resolve: (row) => row.createdAt.toISOString(),
    }),
  }),
});

const TeamMember = builder.objectRef<TeamMemberRow>("TeamMember").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    teamId: t.expose("teamId", { type: "UUID" }),
    principalId: t.expose("principalId", { type: "UUID" }),
    role: t.exposeString("role"),
    version: t.exposeInt("version"),
    deletedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (row) => row.deletedAt?.toISOString() ?? null,
    }),
  }),
});

const CaseTeamLink = builder
  .objectRef<CaseTeamLinkRow>("CaseTeamLink")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      caseId: t.expose("caseId", { type: "UUID" }),
      teamId: t.expose("teamId", { type: "UUID" }),
      version: t.exposeInt("version"),
      deletedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.deletedAt?.toISOString() ?? null,
      }),
    }),
  });

const PageInfo = builder
  .objectRef<{ hasNextPage: boolean; endCursor: string | null }>("TeamPageInfo")
  .implement({
    fields: (t) => ({
      hasNextPage: t.exposeBoolean("hasNextPage"),
      endCursor: t.exposeString("endCursor", { nullable: true }),
    }),
  });

const TeamConnection = builder
  .objectRef<{
    nodes: TeamRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>("TeamConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [Team], resolve: (row) => row.nodes }),
      pageInfo: t.field({ type: PageInfo, resolve: (row) => row.pageInfo }),
    }),
  });

const TeamMemberConnection = builder
  .objectRef<{
    nodes: TeamMemberRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>("TeamMemberConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [TeamMember], resolve: (row) => row.nodes }),
      pageInfo: t.field({ type: PageInfo, resolve: (row) => row.pageInfo }),
    }),
  });

export function registerTeamsGraphQL(): void {
  builder.queryFields((t) => ({
    team: t.field({
      type: Team,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) =>
        context.services.teams.getTeam(args.id),
    }),
    teams: t.field({
      type: TeamConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 1,
        multiplier: normalizePagination(args).first,
      }),
      resolve: (_root, args, context) => context.services.teams.listTeams(args),
    }),
    teamMembers: t.field({
      type: TeamMemberConnection,
      args: {
        teamId: t.arg({ type: "UUID", required: true }),
        first: t.arg.int(),
        after: t.arg.string(),
      },
      complexity: (args) => ({
        field: 1,
        multiplier: normalizePagination(args).first,
      }),
      resolve: (_root, args, context) => context.services.teams.members(args),
    }),
    caseTeams: t.field({
      type: [Team],
      args: { caseId: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) =>
        context.services.teams.caseTeams(args.caseId),
    }),
  }));

  builder.mutationFields((t) => ({
    createTeam: t.field({
      type: Team,
      args: {
        name: t.arg.string({ required: true }),
        description: t.arg.string(),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) =>
        context.services.teams.createTeam(args),
    }),
    addTeamMember: t.field({
      type: TeamMember,
      args: {
        teamId: t.arg({ type: "UUID", required: true }),
        principalId: t.arg({ type: "UUID", required: true }),
        role: t.arg.string(),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) => context.services.teams.addMember(args),
    }),
    removeTeamMember: t.field({
      type: TeamMember,
      args: {
        teamId: t.arg({ type: "UUID", required: true }),
        memberId: t.arg({ type: "UUID", required: true }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) =>
        context.services.teams.removeMember(args),
    }),
    linkTeamToCase: t.field({
      type: CaseTeamLink,
      args: {
        caseId: t.arg({ type: "UUID", required: true }),
        teamId: t.arg({ type: "UUID", required: true }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) => context.services.teams.linkCase(args),
    }),
    unlinkTeamFromCase: t.field({
      type: CaseTeamLink,
      args: {
        caseId: t.arg({ type: "UUID", required: true }),
        linkId: t.arg({ type: "UUID", required: true }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_root, args, context) =>
        context.services.teams.unlinkCase(args),
    }),
  }));
}
