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

import { cases } from "./cases";
import { sensitivityEnum } from "./enums";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

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

/** Workspace-local sequence used to allocate stable investigation numbers. */
export const investigationSequences = pgTable(
  "investigation_sequences",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    nextNumber: integer("next_number").default(1).notNull(),
  },
  (t) => [
    check(
      "investigation_sequences_next_number_check",
      sql`${t.nextNumber} > 0`,
    ),
  ],
);

export const investigations = pgTable(
  "investigations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    purpose: text("purpose").notNull(),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    state: text("state").default("draft").notNull(),
    leadPrincipalId: uuid("lead_principal_id").notNull(),
    startedAt: time("started_at"),
    endedAt: time("ended_at"),
    closedAt: time("closed_at"),
    closedBy: uuid("closed_by"),
    closureReason: text("closure_reason"),
    ...attribution(),
  },
  (t) => [
    unique("investigations_workspace_id_unique").on(t.workspaceId, t.id),
    unique("investigations_workspace_number_unique").on(
      t.workspaceId,
      t.number,
    ),
    unique("investigations_workspace_slug_unique").on(t.workspaceId, t.slug),
    index("investigations_workspace_state_idx").on(
      t.workspaceId,
      t.state,
      t.createdAt,
      t.id,
    ),
    index("investigations_workspace_lead_idx").on(
      t.workspaceId,
      t.leadPrincipalId,
      t.id,
    ),
    foreignKey({
      name: "investigations_workspace_lead_fk",
      columns: [t.workspaceId, t.leadPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "investigations_workspace_created_by_fk",
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "investigations_workspace_updated_by_fk",
      columns: [t.workspaceId, t.updatedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "investigations_workspace_closed_by_fk",
      columns: [t.workspaceId, t.closedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "investigations_state_check",
      sql`${t.state} IN ('draft', 'active', 'paused', 'closed', 'archived')`,
    ),
    check("investigations_number_check", sql`${t.number} > 0`),
    check(
      "investigations_slug_check",
      sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{0,95}$'`,
    ),
    check(
      "investigations_text_check",
      sql`length(trim(${t.title})) BETWEEN 1 AND 200 AND length(trim(${t.objective})) BETWEEN 1 AND 4000 AND length(trim(${t.purpose})) BETWEEN 1 AND 2000 AND (${t.closureReason} IS NULL OR length(trim(${t.closureReason})) BETWEEN 1 AND 2000)`,
    ),
    check(
      "investigations_dates_check",
      sql`(${t.endedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}) AND (${t.closedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.closedAt} >= ${t.startedAt}) AND ((${t.state} = 'closed' AND ${t.closedAt} IS NOT NULL AND ${t.closedBy} IS NOT NULL) OR ${t.state} <> 'closed')`,
    ),
    check("investigations_version_check", sql`${t.version} > 0`),
    check(
      "investigations_deleted_attribution_check",
      sql`(${t.deletedAt} IS NULL AND ${t.deletedBy} IS NULL) OR (${t.deletedAt} IS NOT NULL AND ${t.deletedBy} IS NOT NULL)`,
    ),
  ],
);

export const investigationCaseLinks = pgTable(
  "investigation_case_links",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    investigationId: uuid("investigation_id").notNull(),
    caseId: uuid("case_id").notNull(),
    ...attribution(),
  },
  (t) => [
    unique("investigation_case_links_workspace_id_unique").on(
      t.workspaceId,
      t.id,
    ),
    unique("investigation_case_links_investigation_case_unique").on(
      t.workspaceId,
      t.investigationId,
      t.caseId,
    ),
    index("investigation_case_links_case_idx").on(
      t.workspaceId,
      t.caseId,
      t.investigationId,
    ),
    foreignKey({
      name: "investigation_case_links_workspace_investigation_fk",
      columns: [t.workspaceId, t.investigationId],
      foreignColumns: [investigations.workspaceId, investigations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "investigation_case_links_workspace_case_fk",
      columns: [t.workspaceId, t.caseId],
      foreignColumns: [cases.workspaceId, cases.id],
    }).onDelete("cascade"),
    check("investigation_case_links_version_check", sql`${t.version} > 0`),
    check(
      "investigation_case_links_deleted_attribution_check",
      sql`(${t.deletedAt} IS NULL AND ${t.deletedBy} IS NULL) OR (${t.deletedAt} IS NOT NULL AND ${t.deletedBy} IS NOT NULL)`,
    ),
  ],
);

export type InvestigationRow = typeof investigations.$inferSelect;
export type InvestigationCaseLinkRow =
  typeof investigationCaseLinks.$inferSelect;
