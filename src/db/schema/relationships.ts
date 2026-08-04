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
  uuid,
} from "drizzle-orm/pg-core";

import {
  lifecycleStateEnum,
  sensitivityEnum,
  temporalPrecisionEnum,
  temporalSemanticsEnum,
} from "./enums";
import { people } from "./people";
import { workspaces } from "./workspaces";

const domainTimestamp = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const relationshipTypes = pgTable(
  "relationship_types",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    namespace: text("namespace").default("workspace").notNull(),
    key: text("key").notNull(),
    forwardLabel: text("forward_label").notNull(),
    inverseLabel: text("inverse_label").notNull(),
    directed: boolean("directed").default(true).notNull(),
    allowsSelf: boolean("allows_self").default(false).notNull(),
    allowedMultiplicity: text("allowed_multiplicity")
      .default("many_to_many")
      .notNull(),
    metadataSchema: jsonb("metadata_schema").default({}).notNull(),
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
    unique("relationship_types_workspace_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    unique("relationship_types_workspace_key_unique").on(
      table.workspaceId,
      table.namespace,
      table.key,
    ),
    check("relationship_types_version_check", sql`${table.version} > 0`),
  ],
);

export const relationships = pgTable(
  "relationships",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourcePersonId: uuid("source_person_id").notNull(),
    targetPersonId: uuid("target_person_id").notNull(),
    relationshipTypeId: uuid("relationship_type_id").notNull(),
    labelOverride: text("label_override"),
    strength: numeric("strength", { precision: 4, scale: 3 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
    state: text("state").default("asserted").notNull(),
    sensitivity: sensitivityEnum("sensitivity").default("internal").notNull(),
    temporalSemantics: temporalSemanticsEnum("temporal_semantics")
      .default("unknown")
      .notNull(),
    temporalPrecision: temporalPrecisionEnum("temporal_precision")
      .default("unknown")
      .notNull(),
    validFrom: domainTimestamp("valid_from"),
    validUntil: domainTimestamp("valid_until"),
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
    unique("relationships_workspace_id_unique").on(table.workspaceId, table.id),
    index("relationships_workspace_source_idx").on(
      table.workspaceId,
      table.sourcePersonId,
    ),
    index("relationships_workspace_target_idx").on(
      table.workspaceId,
      table.targetPersonId,
    ),
    foreignKey({
      name: "relationships_workspace_source_person_fk",
      columns: [table.workspaceId, table.sourcePersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "relationships_workspace_target_person_fk",
      columns: [table.workspaceId, table.targetPersonId],
      foreignColumns: [people.workspaceId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "relationships_workspace_type_fk",
      columns: [table.workspaceId, table.relationshipTypeId],
      foreignColumns: [relationshipTypes.workspaceId, relationshipTypes.id],
    }).onDelete("restrict"),
    check(
      "relationships_strength_check",
      sql`${table.strength} IS NULL OR ${table.strength} BETWEEN 0 AND 1`,
    ),
    check(
      "relationships_confidence_check",
      sql`${table.confidence} BETWEEN 0 AND 1`,
    ),
    check(
      "relationships_validity_check",
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
    check("relationships_version_check", sql`${table.version} > 0`),
  ],
);
