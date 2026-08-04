import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { workspaces } from "./workspaces";

const authTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

const workspaceIdColumn = (): AnyPgColumn => workspaces.id;
const workspaceOrganizationColumn = (): AnyPgColumn =>
  workspaces.organizationId;

// Generated from src/lib/auth/config.ts with auth@1.6.23, then augmented with
// the exact indexes, foreign keys, defaults, and checks required by Humans.
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    username: text("username"),
    displayUsername: text("display_username"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    role: text("role").default("user"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: authTimestamp("ban_expires"),
  },
  (table) => [
    unique("users_email_unique").on(table.email),
    unique("users_username_unique").on(table.username),
    check(
      "users_global_role_check",
      sql`${table.role} IS NULL OR ${table.role} IN ('user', 'admin')`,
    ),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [unique("rate_limits_key_unique").on(table.key)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: authTimestamp("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [
    unique("sessions_token_unique").on(table.token),
    unique("sessions_user_id_unique").on(table.userId, table.id),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: authTimestamp("access_token_expires_at"),
    refreshTokenExpiresAt: authTimestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
    index("accounts_user_idx").on(table.userId),
  ],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: authTimestamp("expires_at").notNull(),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    updatedAt: authTimestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("verifications_identifier_idx").on(table.identifier),
    index("verifications_expires_at_idx").on(table.expiresAt),
  ],
);

export const twoFactors = pgTable(
  "two_factors",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: authTimestamp("locked_until"),
  },
  (table) => [
    index("two_factors_secret_idx").on(table.secret),
    index("two_factors_user_idx").on(table.userId),
  ],
);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    createdAt: authTimestamp("created_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [unique("organizations_slug_unique").on(table.slug)],
);

export const members = pgTable(
  "members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").default("viewer").notNull(),
    createdAt: authTimestamp("created_at").notNull(),
    // Better Auth models additional fields as strings. UUID columns infer a
    // string in Drizzle while preserving the application's domain ID type.
    workspaceId: uuid("workspace_id").notNull(),
  },
  (table) => [
    unique("members_organization_user_unique").on(
      table.organizationId,
      table.userId,
    ),
    unique("members_workspace_id_unique").on(table.workspaceId, table.id),
    unique("members_workspace_user_unique").on(table.workspaceId, table.userId),
    index("members_organization_idx").on(table.organizationId),
    index("members_user_idx").on(table.userId),
    foreignKey({
      name: "members_workspace_organization_fk",
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaceIdColumn(), workspaceOrganizationColumn()],
    }).onDelete("cascade"),
    check(
      "members_workspace_role_check",
      sql`${table.role} IN ('owner', 'admin', 'analyst', 'contributor', 'viewer')`,
    ),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: authTimestamp("expires_at").notNull(),
    createdAt: authTimestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitations_organization_idx").on(table.organizationId),
    index("invitations_email_idx").on(table.email),
    uniqueIndex("invitations_live_recipient_unique")
      .on(table.organizationId, sql`lower(${table.email})`)
      .where(sql`${table.status} = 'pending'`),
    check(
      "invitations_workspace_role_check",
      sql`${table.role} IS NULL OR ${table.role} IN ('owner', 'admin', 'analyst', 'contributor', 'viewer')`,
    ),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: authTimestamp("last_refill_at"),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86_400_000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: authTimestamp("last_request"),
    expiresAt: authTimestamp("expires_at"),
    createdAt: authTimestamp("created_at").notNull(),
    updatedAt: authTimestamp("updated_at").notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (table) => [
    index("api_keys_config_idx").on(table.configId),
    index("api_keys_reference_idx").on(table.referenceId),
    unique("api_keys_key_unique").on(table.key),
    unique("api_keys_workspace_id_unique").on(table.workspaceId, table.id),
    foreignKey({
      name: "api_keys_workspace_organization_fk",
      columns: [table.workspaceId, table.referenceId],
      foreignColumns: [workspaceIdColumn(), workspaceOrganizationColumn()],
    }).onDelete("cascade"),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  invitations: many(invitations),
  members: many(members),
  sessions: many(sessions),
  twoFactors: many(twoFactors),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const twoFactorsRelations = relations(twoFactors, ({ one }) => ({
  user: one(users, {
    fields: [twoFactors.userId],
    references: [users.id],
  }),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  invitations: many(invitations),
  members: many(members),
}));

export const membersRelations = relations(members, ({ one }) => ({
  organization: one(organizations, {
    fields: [members.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [members.userId],
    references: [users.id],
  }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [invitations.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [invitations.inviterId],
    references: [users.id],
  }),
}));
