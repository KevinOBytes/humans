import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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

import {
  factCardinalityEnum,
  factDefinitionStateEnum,
  factRelationshipTypeEnum,
  factReviewStateEnum,
  factStateEnum,
  factValueTypeEnum,
  sensitivityEnum,
  temporalPrecisionEnum,
  temporalSemanticsEnum,
} from "./enums";
import { files } from "./files";
import { places } from "./locations";
import { people } from "./people";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const factDefinitions = pgTable(
  "fact_definitions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull(),
    fieldKey: text("field_key").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    category: text("category"),
    allowedValueType: factValueTypeEnum("allowed_value_type").notNull(),
    cardinality: factCardinalityEnum("cardinality").default("one").notNull(),
    validationSchema: jsonb("validation_schema"),
    enumerationMetadata: jsonb("enumeration_metadata"),
    searchable: boolean("searchable").default(false).notNull(),
    filterable: boolean("filterable").default(false).notNull(),
    graphable: boolean("graphable").default(false).notNull(),
    userDefinable: boolean("user_definable").default(true).notNull(),
    defaultSensitivity: sensitivityEnum("default_sensitivity")
      .default("internal")
      .notNull(),
    state: factDefinitionStateEnum("state").default("draft").notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("fact_definitions_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("fact_definitions_workspace_id_type_unique").on(
      table.workspaceId,
      table.id,
      table.allowedValueType,
    ),
    unique("fact_definitions_workspace_key_unique").on(
      table.workspaceId,
      table.namespace,
      table.fieldKey,
    ),
    index("fact_definitions_workspace_category_idx").on(
      table.workspaceId,
      table.category,
    ),
    check("fact_definitions_version_check", sql`${table.version} > 0`),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    factDefinitionId: uuid("fact_definition_id").notNull(),
    namespace: text("namespace").notNull(),
    fieldKey: text("field_key").notNull(),
    label: text("label").notNull(),
    valueType: factValueTypeEnum("value_type").notNull(),
    valueText: text("value_text"),
    valueDecimal: numeric("value_decimal", { precision: 38, scale: 12 }),
    valueBoolean: boolean("value_boolean"),
    valueDateStart: date("value_date_start", { mode: "string" }),
    valueDateEnd: date("value_date_end", { mode: "string" }),
    valueTimestamp: domainTimestamp("value_timestamp"),
    valueJson: jsonb("value_json"),
    referencedPersonId: uuid("referenced_person_id"),
    placeId: uuid("place_id"),
    fileId: uuid("file_id"),
    unit: text("unit"),
    language: text("language"),
    normalizedSearchValue: text("normalized_search_value"),
    encryptedValue: text("encrypted_value"),
    blindIndex: text("blind_index"),
    state: factStateEnum("state").default("asserted").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
    confidenceMethod: text("confidence_method"),
    confidenceExplanation: text("confidence_explanation"),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    reviewState: factReviewStateEnum("review_state")
      .default("unreviewed")
      .notNull(),
    temporalSemantics: temporalSemanticsEnum("temporal_semantics")
      .default("unknown")
      .notNull(),
    validEarliestAt: domainTimestamp("valid_earliest_at"),
    validLatestAt: domainTimestamp("valid_latest_at"),
    observedAt: domainTimestamp("observed_at"),
    assertedAt: domainTimestamp("asserted_at").defaultNow().notNull(),
    temporalPrecision: temporalPrecisionEnum("temporal_precision")
      .default("unknown")
      .notNull(),
    supersedesFactId: uuid("supersedes_fact_id"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("facts_workspace_id_unique").on(table.workspaceId, table.id),
    unique("facts_workspace_person_id_unique").on(
      table.workspaceId,
      table.personId,
      table.id,
    ),
    unique("facts_workspace_person_field_id_unique").on(
      table.workspaceId,
      table.personId,
      table.namespace,
      table.fieldKey,
      table.id,
    ),
    index("facts_workspace_person_idx").on(table.workspaceId, table.personId),
    index("facts_workspace_definition_idx").on(
      table.workspaceId,
      table.factDefinitionId,
    ),
    index("facts_workspace_field_idx").on(
      table.workspaceId,
      table.namespace,
      table.fieldKey,
    ),
    index("facts_workspace_blind_index_idx").on(
      table.workspaceId,
      table.blindIndex,
    ),
    foreignKey({
      name: "facts_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "facts_workspace_definition_type_fk",
      columns: [table.workspaceId, table.factDefinitionId, table.valueType],
      foreignColumns: [
        factDefinitions.workspaceId,
        factDefinitions.id,
        factDefinitions.allowedValueType,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "facts_workspace_referenced_person_fk",
      columns: [table.workspaceId, table.referencedPersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "facts_workspace_place_fk",
      columns: [table.workspaceId, table.placeId],
      foreignColumns: [places.workspaceId, places.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "facts_workspace_file_fk",
      columns: [table.workspaceId, table.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "facts_workspace_supersedes_fk",
      columns: [table.workspaceId, table.supersedesFactId],
      foreignColumns: [table.workspaceId, table.id],
    }).onDelete("restrict"),
    check(
      "facts_typed_value_check",
      sql`
        (
          ${table.valueType} IN ('text', 'rich_text', 'uri')
          AND num_nonnulls(${table.valueText}, ${table.encryptedValue}) = 1
          AND num_nonnulls(${table.valueDecimal}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}) = 0
        ) OR (
          ${table.valueType} = 'integer'
          AND ${table.valueDecimal} IS NOT NULL
          AND ${table.valueDecimal} = trunc(${table.valueDecimal})
          AND num_nonnulls(${table.valueText}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'decimal'
          AND ${table.valueDecimal} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} IN ('duration', 'quantity')
          AND ${table.valueDecimal} IS NOT NULL
          AND ${table.unit} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'boolean'
          AND ${table.valueBoolean} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueDecimal}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'date'
          AND ${table.valueDateStart} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueDecimal}, ${table.valueBoolean}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'date_range'
          AND ${table.valueDateStart} IS NOT NULL
          AND ${table.valueDateEnd} IS NOT NULL
          AND ${table.valueDateEnd} >= ${table.valueDateStart}
          AND num_nonnulls(${table.valueText}, ${table.valueDecimal}, ${table.valueBoolean}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'timestamp'
          AND ${table.valueTimestamp} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueDecimal}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'json'
          AND ${table.valueJson} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueDecimal}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.referencedPersonId}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'person_reference'
          AND ${table.referencedPersonId} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueDecimal}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.placeId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'place_reference'
          AND ${table.placeId} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueDecimal}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.fileId}, ${table.encryptedValue}) = 0
        ) OR (
          ${table.valueType} = 'file_reference'
          AND ${table.fileId} IS NOT NULL
          AND num_nonnulls(${table.valueText}, ${table.valueDecimal}, ${table.valueBoolean}, ${table.valueDateStart}, ${table.valueDateEnd}, ${table.valueTimestamp}, ${table.valueJson}, ${table.referencedPersonId}, ${table.placeId}, ${table.encryptedValue}) = 0
        )
      `,
    ),
    check(
      "facts_encrypted_blind_index_check",
      sql`${table.encryptedValue} IS NULL OR ${table.blindIndex} IS NOT NULL`,
    ),
    check(
      "facts_unit_check",
      sql`(${table.valueType} IN ('duration', 'quantity') AND ${table.unit} IS NOT NULL)
        OR (${table.valueType} NOT IN ('duration', 'quantity') AND ${table.unit} IS NULL)`,
    ),
    check(
      "facts_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`,
    ),
    check(
      "facts_validity_check",
      sql`${table.validLatestAt} IS NULL OR ${table.validEarliestAt} IS NULL OR ${table.validLatestAt} >= ${table.validEarliestAt}`,
    ),
    check(
      "facts_supersedes_self_check",
      sql`${table.supersedesFactId} IS NULL OR ${table.supersedesFactId} <> ${table.id}`,
    ),
    check("facts_version_check", sql`${table.version} > 0`),
  ],
);

export const personFieldSelections = pgTable(
  "person_field_selections",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    namespace: text("namespace").notNull(),
    fieldKey: text("field_key").notNull(),
    factId: uuid("fact_id").notNull(),
    selectedBy: text("selected_by").notNull(),
    selectionReason: text("selection_reason"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("person_field_selections_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    uniqueIndex("person_field_selections_current_unique")
      .on(table.workspaceId, table.personId, table.namespace, table.fieldKey)
      .where(sql`${table.deletedAt} IS NULL`),
    foreignKey({
      name: "person_field_selections_workspace_person_fk",
      columns: [table.workspaceId, table.personId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_field_selections_workspace_fact_fk",
      columns: [
        table.workspaceId,
        table.personId,
        table.namespace,
        table.fieldKey,
        table.factId,
      ],
      foreignColumns: [
        facts.workspaceId,
        facts.personId,
        facts.namespace,
        facts.fieldKey,
        facts.id,
      ],
    }).onDelete("cascade"),
    check("person_field_selections_version_check", sql`${table.version} > 0`),
  ],
);

export const factRevisions = pgTable(
  "fact_revisions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    factId: uuid("fact_id").notNull(),
    revision: integer("revision").notNull(),
    beforeSnapshot: jsonb("before_snapshot"),
    afterSnapshot: jsonb("after_snapshot").notNull(),
    changeReason: text("change_reason"),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    unique("fact_revisions_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("fact_revisions_workspace_fact_revision_unique").on(
      table.workspaceId,
      table.factId,
      table.revision,
    ),
    foreignKey({
      name: "fact_revisions_workspace_fact_fk",
      columns: [table.workspaceId, table.factId],
      foreignColumns: [facts.workspaceId, facts.id],
    }).onDelete("restrict"),
    check("fact_revisions_revision_check", sql`${table.revision} > 0`),
  ],
);

export const factRelationships = pgTable(
  "fact_relationships",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceFactId: uuid("source_fact_id").notNull(),
    targetFactId: uuid("target_fact_id").notNull(),
    relationshipType: factRelationshipTypeEnum("relationship_type").notNull(),
    explanation: text("explanation"),
    version: integer("version").default(1).notNull(),
    createdAt: domainTimestamp("created_at").defaultNow().notNull(),
    createdBy: text("created_by").notNull(),
    updatedAt: domainTimestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: domainTimestamp("deleted_at"),
    deletedBy: text("deleted_by"),
  },
  (table) => [
    unique("fact_relationships_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("fact_relationships_workspace_source_idx").on(
      table.workspaceId,
      table.sourceFactId,
    ),
    index("fact_relationships_workspace_target_idx").on(
      table.workspaceId,
      table.targetFactId,
    ),
    foreignKey({
      name: "fact_relationships_workspace_source_fk",
      columns: [table.workspaceId, table.sourceFactId],
      foreignColumns: [facts.workspaceId, facts.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fact_relationships_workspace_target_fk",
      columns: [table.workspaceId, table.targetFactId],
      foreignColumns: [facts.workspaceId, facts.id],
    }).onDelete("cascade"),
    check(
      "fact_relationships_distinct_facts_check",
      sql`${table.sourceFactId} <> ${table.targetFactId}`,
    ),
    check("fact_relationships_version_check", sql`${table.version} > 0`),
  ],
);
