import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

/**
 * Durable identity snapshots for attribution.
 *
 * These rows deliberately do not reference Better Auth's member, API-key, or
 * session tables. A database trigger validates the live identity when the
 * snapshot is created; domain rows can then retain tenant-safe attribution
 * after logout, key revocation, or workspace offboarding.
 */
export const workspacePrincipals = pgTable(
  "workspace_principals",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    userId: text("user_id"),
    memberIdSnapshot: text("member_id_snapshot"),
    apiKeyId: text("api_key_id"),
    systemKey: text("system_key"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("workspace_principals_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("workspace_principals_workspace_user_unique").on(
      table.workspaceId,
      table.userId,
    ),
    unique("workspace_principals_workspace_api_key_unique").on(
      table.workspaceId,
      table.apiKeyId,
    ),
    unique("workspace_principals_workspace_system_unique").on(
      table.workspaceId,
      table.systemKey,
    ),
    index("workspace_principals_workspace_type_idx").on(
      table.workspaceId,
      table.principalType,
    ),
    check(
      "workspace_principals_identity_check",
      sql`(${table.principalType} = 'user'
            AND ${table.userId} IS NOT NULL
            AND ${table.memberIdSnapshot} IS NOT NULL
            AND ${table.apiKeyId} IS NULL
            AND ${table.systemKey} IS NULL)
          OR (${table.principalType} = 'api_key'
            AND ${table.userId} IS NULL
            AND ${table.memberIdSnapshot} IS NULL
            AND ${table.apiKeyId} IS NOT NULL
            AND ${table.systemKey} IS NULL)
          OR (${table.principalType} = 'system'
            AND ${table.userId} IS NULL
            AND ${table.memberIdSnapshot} IS NULL
            AND ${table.apiKeyId} IS NULL
            AND ${table.systemKey} IS NOT NULL)
          OR (${table.principalType} = 'legacy_user'
            AND ${table.userId} IS NOT NULL
            AND ${table.memberIdSnapshot} IS NULL
            AND ${table.apiKeyId} IS NULL
            AND ${table.systemKey} IS NULL)
          OR (${table.principalType} = 'legacy_api_key'
            AND ${table.userId} IS NULL
            AND ${table.memberIdSnapshot} IS NULL
            AND ${table.apiKeyId} IS NOT NULL
            AND ${table.systemKey} IS NULL)`,
    ),
  ],
);
