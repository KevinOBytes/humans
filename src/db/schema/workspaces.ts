import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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

import { members, organizations } from "./auth";
import {
  deletionBehaviorEnum,
  legalHoldStateEnum,
  lifecycleStateEnum,
  policyStateEnum,
  sensitivityEnum,
} from "./enums";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    state: lifecycleStateEnum("state").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("workspaces_organization_unique").on(table.organizationId),
    unique("workspaces_id_organization_unique").on(
      table.id,
      table.organizationId,
    ),
    check("workspaces_version_check", sql`${table.version} > 0`),
  ],
);

export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    locale: text("locale").default("en-US").notNull(),
    timezone: text("timezone").default("UTC").notNull(),
    retentionDays: integer("retention_days"),
    privacyDefaults: jsonb("privacy_defaults").default({}).notNull(),
    graphDefaults: jsonb("graph_defaults").default({}).notNull(),
    aiEnabled: boolean("ai_enabled").default(false).notNull(),
    storageEnabled: boolean("storage_enabled").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    unique("workspace_settings_workspace_unique").on(table.workspaceId),
    unique("workspace_settings_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    check("workspace_settings_version_check", sql`${table.version} > 0`),
  ],
);

export const workspaceUsage = pgTable(
  "workspace_usage",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    usageDate: date("usage_date", { mode: "string" }).notNull(),
    peopleCount: integer("people_count").default(0).notNull(),
    factsCount: integer("facts_count").default(0).notNull(),
    storageBytes: text("storage_bytes").default("0").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    unique("workspace_usage_workspace_date_unique").on(
      table.workspaceId,
      table.usageDate,
    ),
    unique("workspace_usage_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    check(
      "workspace_usage_counts_check",
      sql`
      ${table.peopleCount} >= 0
      AND ${table.factsCount} >= 0
      AND ${table.storageBytes} ~ '^[0-9]+$'
    `,
    ),
  ],
);

export const accessPolicies = pgTable(
  "access_policies",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sensitivityCeiling: sensitivityEnum("sensitivity_ceiling")
      .default("restricted")
      .notNull(),
    resourceKinds: text("resource_kinds").array().default([]).notNull(),
    roleBindings: jsonb("role_bindings").default({}).notNull(),
    state: policyStateEnum("state").default("draft").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("access_policies_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("access_policies_workspace_name_unique").on(
      table.workspaceId,
      table.name,
    ),
    index("access_policies_workspace_idx").on(table.workspaceId),
    check("access_policies_version_check", sql`${table.version} > 0`),
  ],
);

export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").notNull(),
    memberId: text("member_id"),
    role: text("role"),
    resourceId: uuid("resource_id").notNull(),
    resourceKind: text("resource_kind").notNull(),
    state: lifecycleStateEnum("state").default("active").notNull(),
    validFrom: domainTimestamp("valid_from"),
    validUntil: domainTimestamp("valid_until"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("resource_grants_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("resource_grants_workspace_resource_idx").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
    ),
    foreignKey({
      name: "resource_grants_workspace_policy_fk",
      columns: [table.workspaceId, table.policyId],
      foreignColumns: [accessPolicies.workspaceId, accessPolicies.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "resource_grants_workspace_member_fk",
      columns: [table.workspaceId, table.memberId],
      foreignColumns: [members.workspaceId, members.id],
    }).onDelete("cascade"),
    check(
      "resource_grants_grantee_check",
      sql`num_nonnulls(${table.memberId}, ${table.role}) = 1`,
    ),
    check(
      "resource_grants_validity_check",
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
  ],
);

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    resourceKind: text("resource_kind").notNull(),
    retentionDays: integer("retention_days").notNull(),
    deletionBehavior: deletionBehaviorEnum("deletion_behavior").notNull(),
    legalBasis: text("legal_basis"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("retention_policies_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("retention_policies_workspace_resource_unique").on(
      table.workspaceId,
      table.resourceKind,
    ),
    check("retention_policies_days_check", sql`${table.retentionDays} >= 0`),
  ],
);

export const legalHolds = pgTable(
  "legal_holds",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    resourceId: uuid("resource_id").notNull(),
    resourceKind: text("resource_kind").notNull(),
    reason: text("reason").notNull(),
    authority: text("authority").notNull(),
    state: legalHoldStateEnum("state").default("active").notNull(),
    releasedAt: domainTimestamp("released_at"),
    releasedBy: text("released_by"),
    releaseReason: text("release_reason"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("legal_holds_workspace_id_unique").on(table.workspaceId, table.id),
    index("legal_holds_workspace_resource_idx").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
    ),
    check(
      "legal_holds_release_check",
      sql`(${table.state} = 'active' AND ${table.releasedAt} IS NULL AND ${table.releasedBy} IS NULL)
        OR (${table.state} = 'released' AND ${table.releasedAt} IS NOT NULL AND ${table.releasedBy} IS NOT NULL)`,
    ),
  ],
);
