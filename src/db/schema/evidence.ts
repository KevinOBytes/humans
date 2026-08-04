import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { facts } from "./facts";
import { files } from "./files";
import { addresses, contactPoints } from "./locations";
import { people } from "./people";
import { relationships } from "./relationships";
import { sensitivityEnum, temporalPrecisionEnum } from "./enums";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    publisher: text("publisher"),
    author: text("author"),
    canonicalUrl: text("canonical_url"),
    citation: text("citation"),
    collectionMethod: text("collection_method"),
    collectedAt: domainTimestamp("collected_at"),
    reliability: numeric("reliability", { precision: 4, scale: 3 }),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    contentHash: text("content_hash"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("sources_workspace_id_unique").on(table.workspaceId, table.id),
    index("sources_workspace_content_hash_idx").on(
      table.workspaceId,
      table.contentHash,
    ),
    check(
      "sources_reliability_check",
      sql`${table.reliability} IS NULL OR ${table.reliability} BETWEEN 0 AND 1`,
    ),
    check("sources_version_check", sql`${table.version} > 0`),
  ],
);

export const evidenceItems = pgTable(
  "evidence_items",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull(),
    fileId: uuid("file_id"),
    externalLocator: text("external_locator"),
    extractedText: text("extracted_text"),
    capturedAt: domainTimestamp("captured_at"),
    checksum: text("checksum").notNull(),
    reviewState: text("review_state").default("unreviewed").notNull(),
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
    unique("evidence_items_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("evidence_items_workspace_source_idx").on(
      table.workspaceId,
      table.sourceId,
    ),
    foreignKey({
      name: "evidence_items_workspace_source_fk",
      columns: [table.workspaceId, table.sourceId],
      foreignColumns: [sources.workspaceId, sources.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "evidence_items_workspace_file_fk",
      columns: [table.workspaceId, table.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
    check("evidence_items_version_check", sql`${table.version} > 0`),
  ],
);

export const evidenceExcerpts = pgTable(
  "evidence_excerpts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    evidenceItemId: uuid("evidence_item_id").notNull(),
    pageNumber: integer("page_number"),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    startTimeMs: integer("start_time_ms"),
    endTimeMs: integer("end_time_ms"),
    locator: text("locator"),
    excerpt: text("excerpt").notNull(),
    language: text("language"),
    checksum: text("checksum").notNull(),
    redactionState: text("redaction_state").default("clear").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("evidence_excerpts_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("evidence_excerpts_workspace_evidence_idx").on(
      table.workspaceId,
      table.evidenceItemId,
    ),
    foreignKey({
      name: "evidence_excerpts_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceItemId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("cascade"),
    check(
      "evidence_excerpts_page_check",
      sql`${table.pageNumber} IS NULL OR ${table.pageNumber} > 0`,
    ),
    check(
      "evidence_excerpts_offset_check",
      sql`${table.endOffset} IS NULL OR ${table.startOffset} IS NULL OR ${table.endOffset} >= ${table.startOffset}`,
    ),
    check(
      "evidence_excerpts_time_check",
      sql`${table.endTimeMs} IS NULL OR ${table.startTimeMs} IS NULL OR ${table.endTimeMs} >= ${table.startTimeMs}`,
    ),
  ],
);

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id"),
    factId: uuid("fact_id"),
    relationshipId: uuid("relationship_id"),
    evidenceItemId: uuid("evidence_item_id"),
    plainText: text("plain_text"),
    sanitizedMarkdown: text("sanitized_markdown"),
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
    unique("notes_workspace_id_unique").on(table.workspaceId, table.id),
    index("notes_workspace_person_idx").on(table.workspaceId, table.personId),
    foreignKey({
      name: "notes_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "notes_workspace_fact_fk",
      columns: [table.workspaceId, table.factId],
      foreignColumns: [facts.workspaceId, facts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "notes_workspace_relationship_fk",
      columns: [table.workspaceId, table.relationshipId],
      foreignColumns: [relationships.workspaceId, relationships.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "notes_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceItemId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("cascade"),
    check(
      "notes_content_check",
      sql`num_nonnulls(${table.plainText}, ${table.sanitizedMarkdown}) = 1`,
    ),
    check(
      "notes_subject_check",
      sql`num_nonnulls(${table.personId}, ${table.factId}, ${table.relationshipId}, ${table.evidenceItemId}) <= 1`,
    ),
    check("notes_version_check", sql`${table.version} > 0`),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    color: text("color"),
    description: text("description"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("tags_workspace_id_unique").on(table.workspaceId, table.id),
    unique("tags_workspace_normalized_name_unique").on(
      table.workspaceId,
      table.normalizedName,
    ),
    check("tags_version_check", sql`${table.version} > 0`),
  ],
);

export const personTags = pgTable(
  "person_tags",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("person_tags_workspace_id_unique").on(table.workspaceId, table.id),
    unique("person_tags_workspace_pair_unique").on(
      table.workspaceId,
      table.personId,
      table.tagId,
    ),
    foreignKey({
      name: "person_tags_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_tags_workspace_tag_fk",
      columns: [table.workspaceId, table.tagId],
      foreignColumns: [tags.workspaceId, tags.id],
    }).onDelete("cascade"),
  ],
);

export const factEvidence = pgTable(
  "fact_evidence",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    factId: uuid("fact_id").notNull(),
    evidenceItemId: uuid("evidence_item_id").notNull(),
    excerpt: text("excerpt"),
    locator: text("locator"),
    supportStrength: numeric("support_strength", { precision: 4, scale: 3 }),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("fact_evidence_workspace_id_unique").on(table.workspaceId, table.id),
    unique("fact_evidence_workspace_pair_unique").on(
      table.workspaceId,
      table.factId,
      table.evidenceItemId,
    ),
    foreignKey({
      name: "fact_evidence_workspace_fact_fk",
      columns: [table.workspaceId, table.factId],
      foreignColumns: [facts.workspaceId, facts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fact_evidence_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceItemId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("cascade"),
    check(
      "fact_evidence_support_check",
      sql`${table.supportStrength} IS NULL OR ${table.supportStrength} BETWEEN -1 AND 1`,
    ),
  ],
);

export const factTags = pgTable(
  "fact_tags",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    factId: uuid("fact_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("fact_tags_workspace_id_unique").on(table.workspaceId, table.id),
    unique("fact_tags_workspace_pair_unique").on(
      table.workspaceId,
      table.factId,
      table.tagId,
    ),
    foreignKey({
      name: "fact_tags_workspace_fact_fk",
      columns: [table.workspaceId, table.factId],
      foreignColumns: [facts.workspaceId, facts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fact_tags_workspace_tag_fk",
      columns: [table.workspaceId, table.tagId],
      foreignColumns: [tags.workspaceId, tags.id],
    }).onDelete("cascade"),
  ],
);

export const relationshipEvidence = pgTable(
  "relationship_evidence",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    relationshipId: uuid("relationship_id").notNull(),
    evidenceItemId: uuid("evidence_item_id").notNull(),
    locator: text("locator"),
    supportStrength: numeric("support_strength", { precision: 4, scale: 3 }),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("relationship_evidence_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("relationship_evidence_workspace_pair_unique").on(
      table.workspaceId,
      table.relationshipId,
      table.evidenceItemId,
    ),
    foreignKey({
      name: "relationship_evidence_workspace_relationship_fk",
      columns: [table.workspaceId, table.relationshipId],
      foreignColumns: [relationships.workspaceId, relationships.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "relationship_evidence_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceItemId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("cascade"),
    check(
      "relationship_evidence_support_check",
      sql`${table.supportStrength} IS NULL OR ${table.supportStrength} BETWEEN -1 AND 1`,
    ),
  ],
);

export const relationshipTags = pgTable(
  "relationship_tags",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    relationshipId: uuid("relationship_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("relationship_tags_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("relationship_tags_workspace_pair_unique").on(
      table.workspaceId,
      table.relationshipId,
      table.tagId,
    ),
    foreignKey({
      name: "relationship_tags_workspace_relationship_fk",
      columns: [table.workspaceId, table.relationshipId],
      foreignColumns: [relationships.workspaceId, relationships.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "relationship_tags_workspace_tag_fk",
      columns: [table.workspaceId, table.tagId],
      foreignColumns: [tags.workspaceId, tags.id],
    }).onDelete("cascade"),
  ],
);

export const personContactPoints = pgTable(
  "person_contact_points",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    contactPointId: uuid("contact_point_id").notNull(),
    usageKind: text("usage_kind").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    validFrom: domainTimestamp("valid_from"),
    validUntil: domainTimestamp("valid_until"),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
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
    unique("person_contact_points_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("person_contact_points_workspace_person_idx").on(
      table.workspaceId,
      table.personId,
    ),
    uniqueIndex("person_contact_points_current_primary_unique")
      .on(table.workspaceId, table.personId, table.usageKind)
      .where(
        sql`${table.isPrimary} AND ${table.deletedAt} IS NULL AND ${table.validUntil} IS NULL`,
      ),
    foreignKey({
      name: "person_contact_points_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_contact_points_workspace_contact_fk",
      columns: [table.workspaceId, table.contactPointId],
      foreignColumns: [contactPoints.workspaceId, contactPoints.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_contact_points_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("restrict"),
    check(
      "person_contact_points_confidence_check",
      sql`${table.confidence} BETWEEN 0 AND 1`,
    ),
    check(
      "person_contact_points_validity_check",
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
    check("person_contact_points_version_check", sql`${table.version} > 0`),
  ],
);

export const personAddresses = pgTable(
  "person_addresses",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    addressId: uuid("address_id").notNull(),
    addressKind: text("address_kind").notNull(),
    validFrom: domainTimestamp("valid_from"),
    validUntil: domainTimestamp("valid_until"),
    temporalPrecision: temporalPrecisionEnum("temporal_precision")
      .default("unknown")
      .notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
    state: text("state").default("asserted").notNull(),
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
    unique("person_addresses_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("person_addresses_workspace_person_idx").on(
      table.workspaceId,
      table.personId,
    ),
    uniqueIndex("person_addresses_current_primary_unique")
      .on(table.workspaceId, table.personId, table.addressKind)
      .where(
        sql`${table.isPrimary} AND ${table.deletedAt} IS NULL AND ${table.validUntil} IS NULL`,
      ),
    foreignKey({
      name: "person_addresses_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_addresses_workspace_address_fk",
      columns: [table.workspaceId, table.addressId],
      foreignColumns: [addresses.workspaceId, addresses.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_addresses_workspace_evidence_fk",
      columns: [table.workspaceId, table.evidenceId],
      foreignColumns: [evidenceItems.workspaceId, evidenceItems.id],
    }).onDelete("restrict"),
    check(
      "person_addresses_confidence_check",
      sql`${table.confidence} BETWEEN 0 AND 1`,
    ),
    check(
      "person_addresses_validity_check",
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
    check("person_addresses_version_check", sql`${table.version} > 0`),
  ],
);
