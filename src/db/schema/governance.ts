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

import {
  approvalStateEnum,
  governanceScopeEnum,
  lawfulBasisEnum,
  policyStateEnum,
  sensitivityEnum,
} from "./enums";
import { factDefinitions } from "./facts";
import { people } from "./people";
import { consentRecords } from "./privacy";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

const auditColumns = {
  version: integer("version").default(1).notNull(),
  createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  createdBy: text("created_by").notNull(),
  updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
  updatedBy: text("updated_by").notNull(),
  deletedAt: domainTimestamp("deleted_at"),
  deletedBy: text("deleted_by"),
};

export const purposePolicies = pgTable(
  "purpose_policies",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    state: policyStateEnum("state").default("draft").notNull(),
    effectiveFrom: domainTimestamp("effective_from").notNull(),
    effectiveUntil: domainTimestamp("effective_until"),
    lawfulBases: lawfulBasisEnum("lawful_bases").array().notNull(),
    caseReference: text("case_reference"),
    metadata: jsonb("metadata").default({}).notNull(),
    ...auditColumns,
  },
  (table) => [
    unique("purpose_policies_workspace_id_unique").on(table.workspaceId, table.id),
    index("purpose_policies_workspace_purpose_idx").on(
      table.workspaceId,
      table.purpose,
      table.state,
    ),
    check(
      "purpose_policies_effective_interval_check",
      sql`${table.effectiveUntil} IS NULL OR ${table.effectiveUntil} >= ${table.effectiveFrom}`,
    ),
    check(
      "purpose_policies_lawful_bases_check",
      sql`cardinality(${table.lawfulBases}) > 0`,
    ),
    check("purpose_policies_version_check", sql`${table.version} > 0`),
  ],
);

export const fieldPolicies = pgTable(
  "field_policies",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    purposePolicyId: uuid("purpose_policy_id").notNull(),
    fieldDefinitionId: uuid("field_definition_id").notNull(),
    sensitivityCeiling: sensitivityEnum("sensitivity_ceiling")
      .default("internal")
      .notNull(),
    permittedScopes: governanceScopeEnum("permitted_scopes").array().notNull(),
    caseReference: text("case_reference"),
    ...auditColumns,
  },
  (table) => [
    unique("field_policies_workspace_id_unique").on(table.workspaceId, table.id),
    index("field_policies_workspace_policy_idx").on(
      table.workspaceId,
      table.purposePolicyId,
    ),
    foreignKey({
      name: "field_policies_workspace_purpose_policy_fk",
      columns: [table.workspaceId, table.purposePolicyId],
      foreignColumns: [purposePolicies.workspaceId, purposePolicies.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "field_policies_workspace_definition_fk",
      columns: [table.workspaceId, table.fieldDefinitionId],
      foreignColumns: [factDefinitions.workspaceId, factDefinitions.id],
    }).onDelete("restrict"),
    check(
      "field_policies_permitted_scopes_check",
      sql`cardinality(${table.permittedScopes}) > 0`,
    ),
    check("field_policies_version_check", sql`${table.version} > 0`),
  ],
);

export const consentScopes = pgTable(
  "consent_scopes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    consentRecordId: uuid("consent_record_id").notNull(),
    purpose: text("purpose").notNull(),
    scope: governanceScopeEnum("scope").notNull(),
    fieldDefinitionId: uuid("field_definition_id"),
    caseReference: text("case_reference"),
    ...auditColumns,
  },
  (table) => [
    unique("consent_scopes_workspace_id_unique").on(table.workspaceId, table.id),
    index("consent_scopes_workspace_consent_idx").on(
      table.workspaceId,
      table.consentRecordId,
      table.purpose,
    ),
    foreignKey({
      name: "consent_scopes_workspace_consent_fk",
      columns: [table.workspaceId, table.consentRecordId],
      foreignColumns: [consentRecords.workspaceId, consentRecords.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "consent_scopes_workspace_definition_fk",
      columns: [table.workspaceId, table.fieldDefinitionId],
      foreignColumns: [factDefinitions.workspaceId, factDefinitions.id],
    }).onDelete("restrict"),
    check("consent_scopes_version_check", sql`${table.version} > 0`),
  ],
);

export const accessApprovals = pgTable(
  "access_approvals",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id").notNull(),
    personId: uuid("person_id").notNull(),
    fieldDefinitionId: uuid("field_definition_id").notNull(),
    purpose: text("purpose").notNull(),
    scope: governanceScopeEnum("scope").default("restricted_read").notNull(),
    caseReference: text("case_reference"),
    reason: text("reason").notNull(),
    state: approvalStateEnum("state").default("requested").notNull(),
    expiresAt: domainTimestamp("expires_at"),
    reviewedAt: domainTimestamp("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewReason: text("review_reason"),
    ...auditColumns,
  },
  (table) => [
    unique("access_approvals_workspace_id_unique").on(table.workspaceId, table.id),
    index("access_approvals_workspace_principal_idx").on(
      table.workspaceId,
      table.principalId,
      table.state,
    ),
    foreignKey({
      name: "access_approvals_workspace_principal_fk",
      columns: [table.workspaceId, table.principalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "access_approvals_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "access_approvals_workspace_definition_fk",
      columns: [table.workspaceId, table.fieldDefinitionId],
      foreignColumns: [factDefinitions.workspaceId, factDefinitions.id],
    }).onDelete("restrict"),
    check("access_approvals_version_check", sql`${table.version} > 0`),
  ],
);
