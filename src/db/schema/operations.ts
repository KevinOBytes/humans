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

import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    requestHash: text("request_hash"),
    idempotencyKey: text("idempotency_key").notNull(),
    priority: integer("priority").default(0).notNull(),
    state: text("state").default("queued").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    claimGeneration: integer("claim_generation").default(0).notNull(),
    scheduledAt: domainTimestamp("scheduled_at").defaultNow().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: domainTimestamp("lease_expires_at"),
    errorCode: text("error_code"),
    resultReferences: jsonb("result_references").default([]).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by"),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    unique("jobs_workspace_id_unique").on(table.workspaceId, table.id),
    unique("jobs_workspace_idempotency_unique").on(
      table.workspaceId,
      table.kind,
      table.idempotencyKey,
    ),
    index("jobs_workspace_claim_idx").on(
      table.workspaceId,
      table.state,
      table.priority,
      table.scheduledAt,
    ),
    foreignKey({
      name: "jobs_workspace_actor_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "jobs_workspace_updater_fk",
      columns: [table.workspaceId, table.updatedBy],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
    check("jobs_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("jobs_claim_generation_check", sql`${table.claimGeneration} >= 0`),
    check(
      "jobs_lease_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "jobs_request_hash_check",
      sql`${table.requestHash} IS NULL OR ${table.requestHash} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    sessionId: text("session_id"),
    apiKeyId: text("api_key_id"),
    action: text("action").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: uuid("resource_id"),
    requestId: text("request_id").notNull(),
    ipHash: text("ip_hash"),
    userAgentSummary: text("user_agent_summary"),
    redactedDiff: jsonb("redacted_diff"),
    outcome: text("outcome").notNull(),
    occurredAt: domainTimestamp("occurred_at").defaultNow().notNull(),
  },
  (table) => [
    unique("audit_events_workspace_id_unique").on(table.workspaceId, table.id),
    index("audit_events_workspace_resource_idx").on(
      table.workspaceId,
      table.resourceKind,
      table.resourceId,
      table.occurredAt,
    ),
    index("audit_events_workspace_request_idx").on(
      table.workspaceId,
      table.requestId,
    ),
    foreignKey({
      name: "audit_events_workspace_actor_fk",
      columns: [table.workspaceId, table.actorUserId],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "audit_events_workspace_api_key_fk",
      columns: [table.workspaceId, table.apiKeyId],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.apiKeyId,
      ],
    }).onDelete("restrict"),
    check(
      "audit_events_actor_check",
      sql`NOT (${table.apiKeyId} IS NOT NULL AND num_nonnulls(${table.actorUserId}, ${table.sessionId}) > 0)
        AND (${table.sessionId} IS NULL OR ${table.actorUserId} IS NOT NULL)`,
    ),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    operation: text("operation").notNull(),
    keyHash: text("key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    responseReference: jsonb("response_reference"),
    status: text("status").default("pending").notNull(),
    expiresAt: domainTimestamp("expires_at").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("idempotency_keys_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("idempotency_keys_workspace_key_unique").on(
      table.workspaceId,
      table.actorId,
      table.operation,
      table.keyHash,
    ),
    index("idempotency_keys_workspace_expiry_idx").on(
      table.workspaceId,
      table.expiresAt,
    ),
    foreignKey({
      name: "idempotency_keys_workspace_actor_fk",
      columns: [table.workspaceId, table.actorId],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
  ],
);

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    secretFingerprint: text("secret_fingerprint").notNull(),
    subscribedEvents: text("subscribed_events").array().notNull(),
    state: text("state").default("active").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("webhooks_workspace_id_unique").on(table.workspaceId, table.id),
    unique("webhooks_workspace_url_unique").on(table.workspaceId, table.url),
    foreignKey({
      name: "webhooks_workspace_creator_fk",
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [
        workspacePrincipals.workspaceId,
        workspacePrincipals.userId,
      ],
    }).onDelete("restrict"),
    check("webhooks_url_check", sql`${table.url} ~ '^https://'`),
    check(
      "webhooks_events_check",
      sql`cardinality(${table.subscribedEvents}) > 0`,
    ),
    check("webhooks_version_check", sql`${table.version} > 0`),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    webhookId: uuid("webhook_id").notNull(),
    eventId: uuid("event_id").notNull(),
    attempt: integer("attempt").notNull(),
    signatureAlgorithm: text("signature_algorithm").notNull(),
    signatureKeyId: text("signature_key_id"),
    responseStatus: integer("response_status"),
    startedAt: domainTimestamp("started_at"),
    completedAt: domainTimestamp("completed_at"),
    nextRetryAt: domainTimestamp("next_retry_at"),
    redactedError: jsonb("redacted_error"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("webhook_deliveries_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("webhook_deliveries_workspace_attempt_unique").on(
      table.workspaceId,
      table.webhookId,
      table.eventId,
      table.attempt,
    ),
    index("webhook_deliveries_workspace_retry_idx").on(
      table.workspaceId,
      table.nextRetryAt,
    ),
    foreignKey({
      name: "webhook_deliveries_workspace_webhook_fk",
      columns: [table.workspaceId, table.webhookId],
      foreignColumns: [webhooks.workspaceId, webhooks.id],
    }).onDelete("cascade"),
    check("webhook_deliveries_attempt_check", sql`${table.attempt} > 0`),
    check(
      "webhook_deliveries_status_check",
      sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`,
    ),
    check(
      "webhook_deliveries_timing_check",
      sql`${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
  ],
);
