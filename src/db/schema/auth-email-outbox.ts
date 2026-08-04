import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { invitations } from "./auth";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const authEmailOutbox = pgTable(
  "auth_email_outbox",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    invitationId: text("invitation_id").references(() => invitations.id, {
      onDelete: "restrict",
    }),
    encryptedPayload: text("encrypted_payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").default("queued").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    claimGeneration: integer("claim_generation").default(0).notNull(),
    scheduledAt: domainTimestamp("scheduled_at").defaultNow().notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: domainTimestamp("lease_expires_at"),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    completedAt: domainTimestamp("completed_at"),
  },
  (table) => [
    unique("auth_email_outbox_idempotency_unique").on(table.idempotencyKey),
    index("auth_email_outbox_claim_idx").on(
      table.state,
      table.scheduledAt,
      table.id,
    ),
    index("auth_email_outbox_retention_idx").on(
      table.state,
      table.updatedAt,
      table.id,
    ),
    index("auth_email_outbox_invitation_idx").on(
      table.invitationId,
      table.state,
    ),
    check(
      "auth_email_outbox_kind_check",
      sql`${table.kind} IN ('verification', 'workspace_invitation')`,
    ),
    check(
      "auth_email_outbox_state_check",
      sql`${table.state} IN ('queued', 'running', 'completed', 'dead_letter')`,
    ),
    check(
      "auth_email_outbox_invitation_binding_check",
      sql`(${table.kind} = 'workspace_invitation' AND ${table.invitationId} IS NOT NULL) OR (${table.kind} = 'verification' AND ${table.invitationId} IS NULL)`,
    ),
    check(
      "auth_email_outbox_payload_hash_check",
      sql`${table.payloadHash} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      "auth_email_outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "auth_email_outbox_claim_generation_check",
      sql`${table.claimGeneration} >= 0`,
    ),
    check(
      "auth_email_outbox_lease_check",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);
