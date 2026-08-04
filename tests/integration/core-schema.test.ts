import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PgDialect } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  factDefinitions,
  factRelationships,
  factRevisions,
  facts,
  contactPoints,
  members,
  people,
  personEvents,
  personFieldSelections,
  personIdentifiers,
  personNames,
  resourceGrants,
  workspaceSettings,
} from "@/db/schema";

const constraintNames = (table: Parameters<typeof getTableConfig>[0]) => {
  const config = getTableConfig(table);

  return [
    ...config.checks.map((constraint) => constraint.name),
    ...config.foreignKeys.map((constraint) => constraint.getName()),
    ...config.uniqueConstraints.map((constraint) => constraint.name),
    ...config.indexes.map((constraint) => constraint.config.name),
  ];
};

const allMigrationSql = () =>
  readdirSync(resolve("drizzle"))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(resolve("drizzle", file), "utf8"))
    .join("\n");

const foreignKeyContract = (
  table: Parameters<typeof getTableConfig>[0],
  name: string,
) => {
  const foreignKey = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.getName() === name,
  );
  if (!foreignKey) throw new Error(`Missing foreign key ${name}`);

  const reference = foreignKey.reference();
  return {
    columns: reference.columns.map((column) => column.name),
    foreignColumns: reference.foreignColumns.map((column) => column.name),
    foreignTable: reference.foreignTable,
    onDelete: foreignKey.onDelete,
  };
};

describe("core schema", () => {
  it.each([
    ["workspace settings", workspaceSettings],
    ["people", people],
    ["person names", personNames],
    ["person identifiers", personIdentifiers],
    ["person events", personEvents],
    ["person field selections", personFieldSelections],
    ["fact definitions", factDefinitions],
    ["facts", facts],
    ["fact revisions", factRevisions],
    ["fact relationships", factRelationships],
  ])("requires a workspace on %s", (_name, table) => {
    expect(table.workspaceId.notNull).toBe(true);
  });

  it("requires every fact to belong to a person", () => {
    expect(facts.personId.notNull).toBe(true);
  });

  it("keeps the selected primary name on the same person and workspace", () => {
    expect(constraintNames(people)).toContain(
      "people_workspace_primary_name_fk",
    );
  });

  it.each([
    [personNames, "person_names_workspace_person_fk"],
    [personIdentifiers, "person_identifiers_workspace_person_fk"],
    [personEvents, "person_events_workspace_person_fk"],
    [personFieldSelections, "person_field_selections_workspace_person_fk"],
    [facts, "facts_workspace_person_fk"],
  ])("uses a workspace-safe person foreign key", (table, constraint) => {
    expect(constraintNames(table)).toContain(constraint);
  });

  it("uses a workspace-safe selected-fact foreign key", () => {
    expect(constraintNames(personFieldSelections)).toContain(
      "person_field_selections_workspace_fact_fk",
    );
  });

  it("matches selected facts by person, namespace, and field key", () => {
    expect(
      (
        personFieldSelections as unknown as {
          namespace?: { notNull: boolean };
        }
      ).namespace?.notNull,
    ).toBe(true);
    expect(
      foreignKeyContract(
        personFieldSelections,
        "person_field_selections_workspace_fact_fk",
      ),
    ).toMatchObject({
      columns: [
        "workspace_id",
        "person_id",
        "namespace",
        "field_key",
        "fact_id",
      ],
      foreignColumns: [
        "workspace_id",
        "person_id",
        "namespace",
        "field_key",
        "id",
      ],
    });
  });

  it("uses the selection namespace in current-selection uniqueness", () => {
    const currentSelection = getTableConfig(personFieldSelections).indexes.find(
      (index) => index.config.name === "person_field_selections_current_unique",
    );
    const columns = currentSelection?.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    );

    expect(columns).toEqual([
      "workspace_id",
      "person_id",
      "namespace",
      "field_key",
    ]);
  });

  it("binds resource grants to a member in the same workspace", () => {
    expect(
      (members as unknown as { workspaceId?: { notNull: boolean } }).workspaceId
        ?.notNull,
    ).toBe(true);
    expect(
      foreignKeyContract(resourceGrants, "resource_grants_workspace_member_fk"),
    ).toMatchObject({
      columns: ["workspace_id", "member_id"],
      foreignColumns: ["workspace_id", "id"],
      foreignTable: members,
    });
  });

  it("requires fact values to use their definition's allowed type", () => {
    expect(constraintNames(facts)).toContain(
      "facts_workspace_definition_type_fk",
    );
  });

  it("enforces confidence bounds in the database", () => {
    expect(constraintNames(people)).toContain("people_confidence_check");
    expect(constraintNames(personNames)).toContain(
      "person_names_confidence_check",
    );
    expect(constraintNames(personEvents)).toContain(
      "person_events_confidence_check",
    );
    expect(constraintNames(facts)).toContain("facts_confidence_check");
  });

  it("enforces sparse typed fact values in the database", () => {
    expect(constraintNames(facts)).toContain("facts_typed_value_check");
  });

  it("does not collapse multiple facts for the same person and field", () => {
    const config = getTableConfig(facts);
    const uniqueColumnSets = [
      ...config.uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name),
      ),
      ...config.indexes
        .filter((index) => index.config.unique)
        .map((index) =>
          index.config.columns.map((column) =>
            "name" in column ? column.name : undefined,
          ),
        ),
    ];

    expect(uniqueColumnSets).not.toContainEqual(["person_id", "field_key"]);
    expect(uniqueColumnSets).not.toContainEqual([
      "workspace_id",
      "person_id",
      "field_key",
    ]);
  });

  it("keeps research claims out of the people presentation record", () => {
    expect(Object.keys(people)).not.toEqual(
      expect.arrayContaining([
        "birthDate",
        "deathDate",
        "sex",
        "genderIdentity",
        "pronouns",
        "occupation",
        "nationality",
      ]),
    );
  });

  it("records optimistic versions and soft deletion on mutable records", () => {
    expect(people.version.notNull).toBe(true);
    expect(people.deletedAt.notNull).toBe(false);
    expect(facts.version.notNull).toBe(true);
    expect(facts.deletedAt.notNull).toBe(false);
  });

  it("distinguishes canonical v1 protected values from legacy rows", () => {
    const contactVersion = (
      contactPoints as unknown as {
        blindIndexVersion?: { default: unknown; notNull: boolean };
      }
    ).blindIndexVersion;
    const identifierVersion = (
      personIdentifiers as unknown as {
        blindIndexVersion?: { default: unknown; notNull: boolean };
      }
    ).blindIndexVersion;
    expect(contactVersion).toMatchObject({ default: 1, notNull: false });
    expect(identifierVersion).toMatchObject({ default: 1, notNull: false });

    for (const [table, indexName, checkName] of [
      [
        contactPoints,
        "contact_points_workspace_blind_index_idx",
        "contact_points_blind_index_v1_check",
      ],
      [
        personIdentifiers,
        "person_identifiers_workspace_blind_index_idx",
        "person_identifiers_blind_index_v1_check",
      ],
    ] as const) {
      const config = getTableConfig(table);
      const index = config.indexes.find(
        (candidate) => candidate.config.name === indexName,
      );
      const constraint = config.checks.find(
        (candidate) => candidate.name === checkName,
      );
      expect(index?.config.where).toBeDefined();
      expect(new PgDialect().sqlToQuery(index!.config.where!).sql).toContain(
        "blind_index_version",
      );
      expect(constraint).toBeDefined();
      expect(new PgDialect().sqlToQuery(constraint!.value).sql).toContain(
        "blind_index_version",
      );
    }
  });

  it("commits a real forward migration with the core database checks", () => {
    const migrationPath = resolve("drizzle/0000_core.sql");
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain('CREATE TABLE "facts"');
    expect(migration).toContain('CONSTRAINT "facts_typed_value_check" CHECK');
    expect(migration).toContain(
      'CONSTRAINT "facts_workspace_person_fk" FOREIGN KEY',
    );
    expect(migration).not.toContain("CREATE EXTENSION");
  });

  it("commits database triggers for revision immutability and supersession", () => {
    const migration = allMigrationSql();

    expect(migration).toContain("fact_revisions_immutable_trigger");
    expect(migration).toContain("facts_supersession_cycle_trigger");
  });

  it("restricts hard deletion of facts that have revisions", () => {
    expect(
      foreignKeyContract(factRevisions, "fact_revisions_workspace_fact_fk"),
    ).toMatchObject({ onDelete: "restrict" });
  });
});
