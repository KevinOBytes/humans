import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";
import { cases } from "./cases";

const time = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

const attribution = () => ({
  version: integer("version").default(1).notNull(),
  createdAt: time("created_at").defaultNow().notNull(),
  createdBy: uuid("created_by").notNull(),
  updatedAt: time("updated_at").defaultNow().notNull(),
  updatedBy: uuid("updated_by").notNull(),
  deletedAt: time("deleted_at"),
  deletedBy: uuid("deleted_by"),
});

/** Workspace-scoped collaboration teams. */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    state: text("state").default("active").notNull(),
    ...attribution(),
  },
  (t) => [
    unique("teams_workspace_id_unique").on(t.workspaceId, t.id),
    unique("teams_workspace_name_unique").on(t.workspaceId, t.name),
    index("teams_workspace_state_idx").on(t.workspaceId, t.state, t.id),
    check("teams_state_check", sql`${t.state} IN ('active', 'archived')`),
    check(
      "teams_text_check",
      sql`length(trim(${t.name})) BETWEEN 1 AND 160 AND (${t.description} IS NULL OR length(${t.description}) <= 2000)`,
    ),
    check("teams_version_check", sql`${t.version} > 0`),
  ],
);

/** Principal membership is independently scoped by both workspace and team. */
export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    /** owner manages membership; reviewer is assigned review work; member can read. */
    role: text("role").default("member").notNull(),
    ...attribution(),
  },
  (t) => [
    unique("team_members_workspace_id_unique").on(t.workspaceId, t.id),
    unique("team_members_principal_unique").on(
      t.workspaceId,
      t.teamId,
      t.principalId,
    ),
    foreignKey({
      name: "team_members_workspace_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "team_members_workspace_principal_fk",
      columns: [t.workspaceId, t.principalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    index("team_members_workspace_team_idx").on(
      t.workspaceId,
      t.teamId,
      t.role,
      t.id,
    ),
    check(
      "team_members_role_check",
      sql`${t.role} IN ('owner', 'reviewer', 'member')`,
    ),
    check("team_members_version_check", sql`${t.version} > 0`),
  ],
);

/** Explicit sharing boundary between a reusable team and a workspace case. */
export const caseTeamLinks = pgTable(
  "case_team_links",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    teamId: uuid("team_id").notNull(),
    ...attribution(),
  },
  (t) => [
    unique("case_team_links_workspace_id_unique").on(t.workspaceId, t.id),
    unique("case_team_links_case_team_unique").on(
      t.workspaceId,
      t.caseId,
      t.teamId,
    ),
    foreignKey({
      name: "case_team_links_workspace_case_fk",
      columns: [t.workspaceId, t.caseId],
      foreignColumns: [cases.workspaceId, cases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "case_team_links_workspace_team_fk",
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [teams.workspaceId, teams.id],
    }).onDelete("cascade"),
    index("case_team_links_workspace_case_idx").on(
      t.workspaceId,
      t.caseId,
      t.id,
    ),
    index("case_team_links_workspace_team_idx").on(
      t.workspaceId,
      t.teamId,
      t.id,
    ),
    check("case_team_links_version_check", sql`${t.version} > 0`),
  ],
);
