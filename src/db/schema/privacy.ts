import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { consentStatusEnum, deletionRequestStateEnum } from "./enums";
import { evidenceItems } from "./evidence";
import { files } from "./files";
import { people } from "./people";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    purpose: text("purpose").notNull(),
    status: consentStatusEnum("status").notNull(),
    source: text("source").notNull(),
    effectiveFrom: domainTimestamp("effective_from").notNull(),
    effectiveUntil: domainTimestamp("effective_until"),
    evidenceId: uuid("evidence_id"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("consent_records_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("consent_records_workspace_person_idx").on(
      table.workspaceId,
      table.personId,
    ),
    foreignKey({
      name: "consent_records_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "consent_records_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("restrict"),
    check(
      "consent_records_effective_interval_check",
      sql`${table.effectiveUntil} IS NULL OR ${table.effectiveUntil} >= ${table.effectiveFrom}`,
    ),
  ],
);

export const deletionRequests = pgTable(
  "deletion_requests",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requesterId: text("requester_id").notNull(),
    scope: jsonb("scope").notNull(),
    state: deletionRequestStateEnum("state").default("requested").notNull(),
    reviewedAt: domainTimestamp("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewNotes: text("review_notes"),
    exportReferenceId: uuid("export_reference_id"),
    completedAt: domainTimestamp("completed_at"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("deletion_requests_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("deletion_requests_workspace_state_idx").on(
      table.workspaceId,
      table.state,
    ),
    foreignKey({
      name: "deletion_requests_workspace_export_fk",
      columns: [table.workspaceId, table.exportReferenceId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
  ],
);
