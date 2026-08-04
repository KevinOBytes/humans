import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { sensitivityEnum } from "./enums";
import { workspacePrincipals } from "./principals";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const contactPoints = pgTable(
  "contact_points",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    encryptedDisplayValue: text("encrypted_display_value").notNull(),
    blindIndex: text("blind_index").notNull(),
    blindIndexVersion: smallint("blind_index_version").default(1),
    label: text("label"),
    verificationState: text("verification_state")
      .default("unverified")
      .notNull(),
    sensitivity: sensitivityEnum("sensitivity")
      .default("confidential")
      .notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("contact_points_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("contact_points_workspace_blind_index_idx")
      .on(table.workspaceId, table.kind, table.blindIndex)
      .where(
        sql`${table.blindIndexVersion} = 1 AND ${table.deletedAt} IS NULL`,
      ),
    check(
      "contact_points_protected_value_check",
      sql`${table.encryptedDisplayValue} <> '' AND ${table.blindIndex} <> ''`,
    ),
    check(
      "contact_points_kind_check",
      sql`${table.kind} IN ('phone', 'email', 'other')`,
    ),
    check(
      "contact_points_blind_index_v1_check",
      sql`${table.blindIndexVersion} IS NULL OR (${table.blindIndexVersion} = 1 AND ${table.blindIndex} ~ '^[0-9a-f]{64}$')`,
    ),
    check("contact_points_version_check", sql`${table.version} > 0`),
  ],
);

export const places = pgTable(
  "places",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    parentPlaceId: uuid("parent_place_id"),
    countryCode: text("country_code"),
    region: text("region"),
    locality: text("locality"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    geocodeMetadata: jsonb("geocode_metadata").default({}).notNull(),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("places_workspace_id_unique").on(table.workspaceId, table.id),
    index("places_workspace_name_idx").on(table.workspaceId, table.name),
    index("places_workspace_canonical_name_idx").on(
      table.workspaceId,
      sql`lower(${table.name} COLLATE "C")`,
      table.id,
    ),
    foreignKey({
      name: "places_workspace_parent_fk",
      columns: [table.workspaceId, table.parentPlaceId],
      foreignColumns: [table.workspaceId, table.id],
    }).onDelete("restrict"),
    check(
      "places_coordinates_check",
      sql`(${table.latitude} IS NULL AND ${table.longitude} IS NULL) OR (${table.latitude} BETWEEN -90 AND 90 AND ${table.longitude} BETWEEN -180 AND 180)`,
    ),
    check(
      "places_parent_self_check",
      sql`${table.parentPlaceId} IS NULL OR ${table.parentPlaceId} <> ${table.id}`,
    ),
    check("places_version_check", sql`${table.version} > 0`),
  ],
);

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    placeId: uuid("place_id"),
    line1: text("line1"),
    line2: text("line2"),
    locality: text("locality"),
    region: text("region"),
    postalCode: text("postal_code"),
    countryCode: text("country_code"),
    unstructuredText: text("unstructured_text"),
    postalMetadata: jsonb("postal_metadata").default({}).notNull(),
    normalizedHash: text("normalized_hash").notNull(),
    normalizedHashVersion: smallint("normalized_hash_version").default(1),
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    sensitivity: sensitivityEnum("sensitivity")
      .default("confidential")
      .notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("addresses_workspace_id_unique").on(table.workspaceId, table.id),
    index("addresses_workspace_hash_idx").on(
      table.workspaceId,
      table.normalizedHash,
    ),
    foreignKey({
      name: "addresses_workspace_place_fk",
      columns: [table.workspaceId, table.placeId],
      foreignColumns: [places.workspaceId, places.id],
    }).onDelete("restrict"),
    check(
      "addresses_value_check",
      sql`num_nonnulls(${table.line1}, ${table.unstructuredText}) > 0`,
    ),
    check(
      "addresses_coordinates_check",
      sql`(${table.latitude} IS NULL AND ${table.longitude} IS NULL) OR (${table.latitude} BETWEEN -90 AND 90 AND ${table.longitude} BETWEEN -180 AND 180)`,
    ),
    check(
      "addresses_normalized_hash_check",
      sql`${table.normalizedHashVersion} IS NULL OR (${table.normalizedHashVersion} = 1 AND ${table.normalizedHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check("addresses_version_check", sql`${table.version} > 0`),
  ],
);

/**
 * Durable mutation claims for the contact/location API. Unlike the legacy
 * user-only idempotency table, this identity is bound to a workspace principal
 * so scoped API keys and interactive users share the same safe replay path.
 * Only hashes and opaque resource references are persisted.
 */
export const locationMutationIdempotency = pgTable(
  "location_mutation_idempotency",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
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
    unique("location_mutation_idempotency_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("location_mutation_idempotency_claim_unique").on(
      table.workspaceId,
      table.actorPrincipalId,
      table.operation,
      table.keyHash,
    ),
    index("location_mutation_idempotency_expiry_idx").on(
      table.workspaceId,
      table.expiresAt,
    ),
    foreignKey({
      name: "location_mutation_idempotency_workspace_principal_fk",
      columns: [table.workspaceId, table.actorPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
    }).onDelete("restrict"),
    check(
      "location_mutation_idempotency_hashes_check",
      sql`${table.keyHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "location_mutation_idempotency_status_check",
      sql`${table.status} IN ('pending', 'completed')`,
    ),
    check(
      "location_mutation_idempotency_response_check",
      sql`${table.responseReference} IS NULL OR jsonb_typeof(${table.responseReference}) = 'object'`,
    ),
  ],
);
