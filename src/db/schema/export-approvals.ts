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
import { auditEvents } from "./operations";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

/**
 * Independent, short-lived review decisions for one deterministic export
 * preview. No exported row values, queries, manifests, or provider material
 * are retained here.
 */
export const exportApprovals = pgTable(
  "export_approvals",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    caseId: uuid("case_id"),
    purpose: text("purpose").notNull(),
    previewHash: text("preview_hash").notNull(),
    redactionProfile: text("redaction_profile").notNull(),
    requestedByPrincipalId: uuid("requested_by_principal_id").notNull(),
    reviewedByPrincipalId: uuid("reviewed_by_principal_id"),
    state: text("state").default("requested").notNull(),
    requestReason: text("request_reason").notNull(),
    decisionReason: text("decision_reason"),
    expiresAt: domainTimestamp("expires_at").notNull(),
    reviewedAt: domainTimestamp("reviewed_at"),
    requestAuditReference: uuid("request_audit_reference").notNull(),
    reviewAuditReference: uuid("review_audit_reference"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (table) => [
    unique("export_approvals_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("export_approvals_workspace_binding_idx").on(
      table.workspaceId,
      table.requestedByPrincipalId,
      table.previewHash,
      table.state,
      table.expiresAt,
    ),
    index("export_approvals_workspace_review_idx").on(
      table.workspaceId,
      table.state,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "export_approvals_workspace_case_fk",
      columns: [table.workspaceId, table.caseId],
      foreignColumns: [cases.workspaceId, cases.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "export_approvals_workspace_requester_fk",
      columns: [table.workspaceId, table.requestedByPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "export_approvals_workspace_reviewer_fk",
      columns: [table.workspaceId, table.reviewedByPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "export_approvals_workspace_creator_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "export_approvals_workspace_updater_fk",
      columns: [table.workspaceId, table.updatedBy],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "export_approvals_workspace_request_audit_fk",
      columns: [table.workspaceId, table.requestAuditReference],
      foreignColumns: [auditEvents.workspaceId, auditEvents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "export_approvals_workspace_review_audit_fk",
      columns: [table.workspaceId, table.reviewAuditReference],
      foreignColumns: [auditEvents.workspaceId, auditEvents.id],
    }).onDelete("restrict"),
    check(
      "export_approvals_binding_check",
      sql`octet_length(${table.purpose}) BETWEEN 1 AND 200 AND ${table.previewHash} ~ '^[0-9a-f]{64}$' AND ${table.redactionProfile} IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')`,
    ),
    check(
      "export_approvals_reason_check",
      sql`octet_length(${table.requestReason}) BETWEEN 1 AND 1000 AND (${table.decisionReason} IS NULL OR octet_length(${table.decisionReason}) BETWEEN 1 AND 1000)`,
    ),
    check(
      "export_approvals_review_check",
      sql`${table.createdBy} = ${table.requestedByPrincipalId} AND ${table.requestAuditReference} IS NOT NULL AND ((${table.state} = 'requested' AND ${table.updatedBy} = ${table.requestedByPrincipalId} AND ${table.reviewedByPrincipalId} IS NULL AND ${table.reviewedAt} IS NULL AND ${table.decisionReason} IS NULL AND ${table.reviewAuditReference} IS NULL) OR (${table.state} IN ('approved', 'rejected') AND ${table.updatedBy} = ${table.reviewedByPrincipalId} AND ${table.reviewedByPrincipalId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL AND ${table.decisionReason} IS NOT NULL AND ${table.reviewAuditReference} IS NOT NULL))`,
    ),
    check(
      "export_approvals_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND (${table.reviewedAt} IS NULL OR ${table.reviewedAt} < ${table.expiresAt})`,
    ),
    check("export_approvals_version_check", sql`${table.version} > 0`),
  ],
);
