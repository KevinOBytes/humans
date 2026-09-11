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
import { workspaces } from "./workspaces";
import { workspacePrincipals } from "./principals";

const time = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });
const attribution = () => ({
  version: integer("version").default(1).notNull(),
  createdAt: time("created_at").defaultNow().notNull(),
  createdBy: text("created_by").notNull(),
  updatedAt: time("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by").notNull(),
  deletedAt: time("deleted_at"),
  deletedBy: text("deleted_by"),
});
export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    purpose: text("purpose").notNull(),
    state: text("state").default("active").notNull(),
    ...attribution(),
  },
  (t) => [
    unique("cases_workspace_id_unique").on(t.workspaceId, t.id),
    index("cases_workspace_created_idx").on(t.workspaceId, t.createdAt, t.id),
    check("cases_version_check", sql`${t.version} > 0`),
    check("cases_state_check", sql`${t.state} IN ('active', 'closed')`),
    check(
      "cases_text_check",
      sql`length(${t.title}) BETWEEN 1 AND 200 AND length(${t.purpose}) BETWEEN 1 AND 200`,
    ),
  ],
);
export const caseMembers = pgTable(
  "case_members",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    role: text("role").default("member").notNull(),
    ...attribution(),
  },
  (t) => [
    unique("case_members_workspace_id_unique").on(t.workspaceId, t.id),
    unique("case_members_principal_unique").on(
      t.workspaceId,
      t.caseId,
      t.principalId,
    ),
    foreignKey({
      name: "case_members_workspace_case_fk",
      columns: [t.workspaceId, t.caseId],
      foreignColumns: [cases.workspaceId, cases.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "case_members_workspace_principal_fk",
      columns: [t.workspaceId, t.principalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "case_members_role_check",
      sql`${t.role} IN ('owner', 'member', 'reviewer')`,
    ),
    check("case_members_version_check", sql`${t.version} > 0`),
  ],
);
export const caseResourceLinks = pgTable(
  "case_resource_links",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: uuid("resource_id").notNull(),
    observedAt: time("observed_at").defaultNow().notNull(),
    ...attribution(),
  },
  (t) => [
    unique("case_resource_links_workspace_id_unique").on(t.workspaceId, t.id),
    unique("case_resource_links_resource_unique").on(
      t.workspaceId,
      t.caseId,
      t.resourceKind,
      t.resourceId,
    ),
    index("case_resource_links_lookup_idx").on(
      t.workspaceId,
      t.resourceKind,
      t.resourceId,
    ),
    index("case_resource_links_timeline_idx").on(
      t.workspaceId,
      t.caseId,
      t.observedAt,
      t.id,
    ),
    foreignKey({
      name: "case_resource_links_workspace_case_fk",
      columns: [t.workspaceId, t.caseId],
      foreignColumns: [cases.workspaceId, cases.id],
    }).onDelete("cascade"),
    check(
      "case_resource_links_kind_check",
      sql`${t.resourceKind} IN ('person', 'fact', 'relationship')`,
    ),
    check("case_resource_links_version_check", sql`${t.version} > 0`),
  ],
);
