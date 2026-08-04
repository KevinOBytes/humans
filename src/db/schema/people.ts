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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import {
  identifierVerificationStateEnum,
  mergeCandidateStateEnum,
  personNameKindEnum,
  personRecordStateEnum,
  personStatusEnum,
  sensitivityEnum,
  temporalPrecisionEnum,
  temporalSemanticsEnum,
} from "./enums";
import { files, imports } from "./files";
import { places } from "./locations";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

const primaryNameWorkspaceColumn = (): AnyPgColumn => personNames.workspaceId;
const primaryNamePersonColumn = (): AnyPgColumn => personNames.personId;
const primaryNameIdColumn = (): AnyPgColumn => personNames.id;

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    sortName: text("sort_name"),
    preferredName: text("preferred_name"),
    biography: text("biography"),
    primaryNameId: uuid("primary_name_id"),
    primaryPhotoFileId: uuid("primary_photo_file_id"),
    status: personStatusEnum("status").default("active").notNull(),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
    confidenceExplanation: text("confidence_explanation"),
    mergedIntoPersonId: uuid("merged_into_person_id"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("people_workspace_id_unique").on(table.workspaceId, table.id),
    index("people_workspace_display_name_idx").on(
      table.workspaceId,
      table.displayName,
    ),
    foreignKey({
      name: "people_workspace_merged_into_fk",
      columns: [table.workspaceId, table.mergedIntoPersonId],
      foreignColumns: [table.workspaceId, table.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "people_workspace_primary_name_fk",
      columns: [table.workspaceId, table.id, table.primaryNameId],
      foreignColumns: [
        primaryNameWorkspaceColumn(),
        primaryNamePersonColumn(),
        primaryNameIdColumn(),
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "people_workspace_primary_photo_fk",
      columns: [table.workspaceId, table.primaryPhotoFileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
    check(
      "people_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check("people_version_check", sql`${table.version} > 0`),
    check(
      "people_merge_state_check",
      sql`(${table.status} = 'merged' AND ${table.mergedIntoPersonId} IS NOT NULL)
        OR (${table.status} <> 'merged' AND ${table.mergedIntoPersonId} IS NULL)`,
    ),
  ],
);

export const personNames = pgTable(
  "person_names",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    kind: personNameKindEnum("kind").notNull(),
    fullName: text("full_name").notNull(),
    givenName: text("given_name"),
    middleName: text("middle_name"),
    familyName: text("family_name"),
    prefix: text("prefix"),
    suffix: text("suffix"),
    script: text("script"),
    language: text("language"),
    normalizedForm: text("normalized_form"),
    validFrom: domainTimestamp("valid_from"),
    validUntil: domainTimestamp("valid_until"),
    temporalSemantics: temporalSemanticsEnum("temporal_semantics")
      .default("unknown")
      .notNull(),
    temporalPrecision: temporalPrecisionEnum("temporal_precision")
      .default("unknown")
      .notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    state: personRecordStateEnum("state").default("asserted").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("person_names_workspace_id_unique").on(table.workspaceId, table.id),
    unique("person_names_workspace_person_id_unique").on(
      table.workspaceId,
      table.personId,
      table.id,
    ),
    index("person_names_workspace_person_idx").on(
      table.workspaceId,
      table.personId,
    ),
    foreignKey({
      name: "person_names_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    check(
      "person_names_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "person_names_validity_check",
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
    check("person_names_version_check", sql`${table.version} > 0`),
  ],
);

export const personIdentifiers = pgTable(
  "person_identifiers",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    namespace: text("namespace").notNull(),
    identifierType: text("identifier_type").notNull(),
    encryptedRawValue: text("encrypted_raw_value"),
    normalizedValue: text("normalized_value"),
    blindIndex: text("blind_index"),
    blindIndexVersion: smallint("blind_index_version").default(1),
    issuer: text("issuer"),
    validFrom: domainTimestamp("valid_from"),
    validUntil: domainTimestamp("valid_until"),
    verificationState: identifierVerificationStateEnum("verification_state")
      .default("unverified")
      .notNull(),
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
    unique("person_identifiers_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("person_identifiers_workspace_person_idx").on(
      table.workspaceId,
      table.personId,
    ),
    index("person_identifiers_workspace_blind_index_idx")
      .on(table.workspaceId, table.namespace, table.blindIndex)
      .where(
        sql`${table.blindIndexVersion} = 1 AND ${table.deletedAt} IS NULL`,
      ),
    foreignKey({
      name: "person_identifiers_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    check(
      "person_identifiers_value_check",
      sql`num_nonnulls(${table.encryptedRawValue}, ${table.normalizedValue}, ${table.blindIndex}) > 0`,
    ),
    check(
      "person_identifiers_blind_index_v1_check",
      sql`${table.blindIndexVersion} IS NULL OR (${table.blindIndexVersion} = 1 AND ${table.encryptedRawValue} IS NOT NULL AND ${table.blindIndex} IS NOT NULL AND ${table.normalizedValue} IS NULL AND ${table.blindIndex} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "person_identifiers_validity_check",
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
  ],
);

export const personEvents = pgTable(
  "person_events",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    eventKind: text("event_kind").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    placeId: uuid("place_id"),
    earliestAt: domainTimestamp("earliest_at"),
    latestAt: domainTimestamp("latest_at"),
    temporalSemantics: temporalSemanticsEnum("temporal_semantics")
      .default("unknown")
      .notNull(),
    temporalPrecision: temporalPrecisionEnum("temporal_precision")
      .default("unknown")
      .notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    state: personRecordStateEnum("state").default("asserted").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("person_events_workspace_id_unique").on(table.workspaceId, table.id),
    index("person_events_workspace_person_idx").on(
      table.workspaceId,
      table.personId,
    ),
    foreignKey({
      name: "person_events_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_events_workspace_place_fk",
      columns: [table.workspaceId, table.placeId],
      foreignColumns: [places.workspaceId, places.id],
    }).onDelete("restrict"),
    check(
      "person_events_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "person_events_temporal_bounds_check",
      sql`${table.latestAt} IS NULL OR ${table.earliestAt} IS NULL OR ${table.latestAt} >= ${table.earliestAt}`,
    ),
  ],
);

export const externalRecords = pgTable(
  "external_records",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceSystem: text("source_system").notNull(),
    externalType: text("external_type").notNull(),
    externalId: text("external_id").notNull(),
    personId: uuid("person_id").notNull(),
    importId: uuid("import_id"),
    sourceHash: text("source_hash"),
    lastSeenAt: domainTimestamp("last_seen_at").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("external_records_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("external_records_source_unique").on(
      table.workspaceId,
      table.sourceSystem,
      table.externalType,
      table.externalId,
    ),
    foreignKey({
      name: "external_records_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "external_records_workspace_import_fk",
      columns: [table.workspaceId, table.importId],
      foreignColumns: [imports.workspaceId, imports.id],
    }).onDelete("restrict"),
  ],
);

export const identityCandidates = pgTable(
  "identity_candidates",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    firstPersonId: uuid("first_person_id").notNull(),
    secondPersonId: uuid("second_person_id").notNull(),
    matchSignals: jsonb("match_signals").default({}).notNull(),
    score: numeric("score", { precision: 4, scale: 3 }).notNull(),
    state: mergeCandidateStateEnum("state").default("pending").notNull(),
    reviewedAt: domainTimestamp("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewReason: text("review_reason"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("identity_candidates_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("identity_candidates_pair_unique").on(
      table.workspaceId,
      table.firstPersonId,
      table.secondPersonId,
    ),
    foreignKey({
      name: "identity_candidates_workspace_first_person_fk",
      columns: [table.workspaceId, table.firstPersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "identity_candidates_workspace_second_person_fk",
      columns: [table.workspaceId, table.secondPersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    check(
      "identity_candidates_people_check",
      sql`${table.firstPersonId} <> ${table.secondPersonId}`,
    ),
    check(
      "identity_candidates_score_check",
      sql`${table.score} >= 0 AND ${table.score} <= 1`,
    ),
  ],
);

export const mergeDecisions = pgTable(
  "merge_decisions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    winnerPersonId: uuid("winner_person_id").notNull(),
    loserPersonId: uuid("loser_person_id").notNull(),
    fieldChoices: jsonb("field_choices").default({}).notNull(),
    reason: text("reason").notNull(),
    reversibleSnapshot: jsonb("reversible_snapshot").notNull(),
    decidedAt: domainTimestamp("decided_at").defaultNow().notNull(),
    decidedBy: text("decided_by").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("merge_decisions_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    foreignKey({
      name: "merge_decisions_workspace_winner_fk",
      columns: [table.workspaceId, table.winnerPersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "merge_decisions_workspace_loser_fk",
      columns: [table.workspaceId, table.loserPersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("restrict"),
    check(
      "merge_decisions_people_check",
      sql`${table.winnerPersonId} <> ${table.loserPersonId}`,
    ),
  ],
);
