import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { invalidateVisibilityDependentLoaders } from "@/graphql/loaders";
import { normalizePagination } from "@/graphql/limits";
import { ActorAttribution } from "@/modules/audit/attribution-graphql";
import {
  Person,
  PageInfo,
  Sensitivity,
  ValidationIssue,
} from "@/modules/people/graphql";
import type {
  MutationOutcome,
  PageInfo as PageInfoShape,
} from "@/modules/people/service";

import type {
  FactDefinitionRow,
  FactRelationshipRow,
  FactRevisionRow,
  FactRow,
  PersonFieldSelectionRow,
} from "./repository";

function enumType(name: string, values: readonly string[]) {
  return builder.enumType(name, {
    values: Object.fromEntries(
      values.map((value) => [value.toUpperCase(), { value }]),
    ) as never,
  });
}

export const FactValueType = enumType("FactValueType", [
  "text",
  "rich_text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "date_range",
  "timestamp",
  "duration",
  "quantity",
  "uri",
  "json",
  "person_reference",
  "place_reference",
  "file_reference",
]);
const FactCardinality = enumType("FactCardinality", ["one", "many"]);
const FactDefinitionState = enumType("FactDefinitionState", [
  "draft",
  "active",
  "deprecated",
  "archived",
]);
const FactState = enumType("FactState", [
  "asserted",
  "corroborated",
  "disputed",
  "disproven",
  "superseded",
  "unknown",
]);
const FactReviewState = enumType("FactReviewState", [
  "unreviewed",
  "in_review",
  "accepted",
  "rejected",
  "needs_attention",
]);
const TemporalSemantics = enumType("TemporalSemantics", [
  "exact",
  "approximate",
  "before",
  "after",
  "between",
  "year_only",
  "unknown",
]);
const TemporalPrecision = enumType("TemporalPrecision", [
  "instant",
  "second",
  "minute",
  "hour",
  "day",
  "month",
  "year",
  "range",
  "unknown",
]);
const FactRelationshipType = enumType("FactRelationshipType", [
  "supports",
  "contradicts",
  "duplicates",
  "supersedes",
  "derived_from",
]);

const FactFilterInput = builder.inputType("FactFilterInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID" }),
    definitionId: t.field({ type: "UUID" }),
    namespace: t.string(),
    fieldKey: t.string(),
    state: t.field({ type: FactState }),
    reviewState: t.field({ type: FactReviewState }),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});
const FactDefinitionFilterInput = builder.inputType(
  "FactDefinitionFilterInput",
  {
    fields: (t) => ({
      namespace: t.string(),
      fieldKey: t.string(),
      category: t.string(),
      allowedValueType: t.field({ type: FactValueType }),
      cardinality: t.field({ type: FactCardinality }),
      searchable: t.boolean(),
      filterable: t.boolean(),
      graphable: t.boolean(),
      defaultSensitivity: t.field({ type: Sensitivity }),
      state: t.field({ type: FactDefinitionState }),
    }),
  },
);

export const FactDefinition = builder
  .objectRef<FactDefinitionRow>("FactDefinition")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      namespace: t.exposeString("namespace"),
      fieldKey: t.exposeString("fieldKey"),
      label: t.exposeString("label"),
      description: t.exposeString("description", { nullable: true }),
      category: t.exposeString("category", { nullable: true }),
      allowedValueType: t.field({
        type: FactValueType,
        resolve: (row) => row.allowedValueType as never,
      }),
      cardinality: t.field({
        type: FactCardinality,
        resolve: (row) => row.cardinality as never,
      }),
      validationSchema: t.field({
        type: "JSON",
        nullable: true,
        resolve: (row) => row.validationSchema,
      }),
      enumerationMetadata: t.field({
        type: "JSON",
        nullable: true,
        resolve: (row) => row.enumerationMetadata,
      }),
      searchable: t.exposeBoolean("searchable"),
      filterable: t.exposeBoolean("filterable"),
      graphable: t.exposeBoolean("graphable"),
      defaultSensitivity: t.field({
        type: Sensitivity,
        resolve: (row) => row.defaultSensitivity,
      }),
      state: t.field({
        type: FactDefinitionState,
        resolve: (row) => row.state as never,
      }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
      updatedAt: t.field({
        type: "DateTime",
        resolve: (row) => row.updatedAt.toISOString(),
      }),
      createdBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.createdBy}`),
      }),
      updatedBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.updatedBy}`),
      }),
    }),
  });

const FactValue = builder.objectRef<FactRow>("FactValue").implement({
  fields: (t) => ({
    text: t.exposeString("valueText", { nullable: true }),
    decimal: t.exposeString("valueDecimal", { nullable: true }),
    boolean: t.exposeBoolean("valueBoolean", { nullable: true }),
    dateStart: t.expose("valueDateStart", { type: "Date", nullable: true }),
    dateEnd: t.expose("valueDateEnd", { type: "Date", nullable: true }),
    timestamp: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (row) => row.valueTimestamp?.toISOString() ?? null,
    }),
    json: t.field({
      type: "JSON",
      nullable: true,
      resolve: (row) => row.valueJson,
    }),
    referencedPersonId: t.field({
      type: "UUID",
      nullable: true,
      resolve: async (row, _args, context) => {
        if (!row.referencedPersonId || !context.permissions.has("person:read"))
          return null;
        return (await context.loaders.person.load(row.referencedPersonId))
          ? row.referencedPersonId
          : null;
      },
    }),
    placeId: t.field({
      type: "UUID",
      nullable: true,
      resolve: () => null,
    }),
    fileId: t.field({
      type: "UUID",
      nullable: true,
      resolve: async (row, _args, context) =>
        row.fileId &&
        context.permissions.has("file:read") &&
        (await context.services.facts.canReadReference("file", row.fileId))
          ? row.fileId
          : null,
    }),
    unit: t.exposeString("unit", { nullable: true }),
  }),
});

const FactRevision = builder
  .objectRef<FactRevisionRow>("FactRevision")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      revision: t.exposeInt("revision"),
      beforeSnapshot: t.field({
        type: "JSON",
        nullable: true,
        resolve: (row, _args, context) =>
          context.loaders.revisionSnapshot.load({
            revisionId: row.id,
            side: "before",
            snapshot: row.beforeSnapshot,
          }),
      }),
      afterSnapshot: t.field({
        type: "JSON",
        resolve: (row, _args, context) =>
          context.loaders.revisionSnapshot.load({
            revisionId: row.id,
            side: "after",
            snapshot: row.afterSnapshot,
          }),
      }),
      changeReason: t.exposeString("changeReason", { nullable: true }),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
      createdBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.createdBy}`),
      }),
    }),
  });
const FactRevisionConnection = builder
  .objectRef<{ nodes: FactRevisionRow[]; pageInfo: PageInfoShape }>(
    "FactRevisionConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [FactRevision],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

export const Fact = builder.objectRef<FactRow>("Fact").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    personId: t.field({
      type: "UUID",
      nullable: true,
      resolve: async (row, _args, context) =>
        context.permissions.has("person:read") &&
        (await context.loaders.person.load(row.personId))
          ? row.personId
          : null,
    }),
    definitionId: t.expose("factDefinitionId", { type: "UUID" }),
    namespace: t.exposeString("namespace"),
    fieldKey: t.exposeString("fieldKey"),
    label: t.exposeString("label"),
    valueType: t.field({
      type: FactValueType,
      resolve: (row) => row.valueType as never,
    }),
    value: t.field({ type: FactValue, resolve: (row) => row }),
    state: t.field({ type: FactState, resolve: (row) => row.state as never }),
    confidence: t.float({ resolve: (row) => Number(row.confidence) }),
    sensitivity: t.field({
      type: Sensitivity,
      resolve: (row) => row.sensitivity,
    }),
    reviewState: t.field({
      type: FactReviewState,
      resolve: (row) => row.reviewState as never,
    }),
    temporalSemantics: t.field({
      type: TemporalSemantics,
      resolve: (row) => row.temporalSemantics as never,
    }),
    temporalPrecision: t.field({
      type: TemporalPrecision,
      resolve: (row) => row.temporalPrecision as never,
    }),
    validEarliestAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (row) => row.validEarliestAt?.toISOString() ?? null,
    }),
    validLatestAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (row) => row.validLatestAt?.toISOString() ?? null,
    }),
    assertedAt: t.field({
      type: "DateTime",
      resolve: (row) => row.assertedAt.toISOString(),
    }),
    version: t.exposeInt("version"),
    createdAt: t.field({
      type: "DateTime",
      resolve: (row) => row.createdAt.toISOString(),
    }),
    updatedAt: t.field({
      type: "DateTime",
      resolve: (row) => row.updatedAt.toISOString(),
    }),
    createdBy: t.field({
      type: ActorAttribution,
      resolve: (row, _args, context) =>
        context.loaders.actorAttribution.load(`p:${row.createdBy}`),
    }),
    updatedBy: t.field({
      type: ActorAttribution,
      resolve: (row, _args, context) =>
        context.loaders.actorAttribution.load(`p:${row.updatedBy}`),
    }),
    revisions: t.field({
      type: FactRevisionConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 2,
        multiplier: pageMultiplier(args.first),
      }),
      resolve: (row, args, context) => {
        requirePermission(context, "fact", "read");
        normalizePagination(args);
        return context.loaders.factRevisions.load({
          factId: row.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
  }),
});

const FactConnection = builder
  .objectRef<{ nodes: FactRow[]; pageInfo: PageInfoShape }>("FactConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [Fact],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const FactDefinitionConnection = builder
  .objectRef<{ nodes: FactDefinitionRow[]; pageInfo: PageInfoShape }>(
    "FactDefinitionConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [FactDefinition],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

const PersonFieldSelection = builder
  .objectRef<PersonFieldSelectionRow>("PersonFieldSelection")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      personId: t.expose("personId", { type: "UUID" }),
      namespace: t.exposeString("namespace"),
      fieldKey: t.exposeString("fieldKey"),
      factId: t.expose("factId", { type: "UUID" }),
      fact: t.field({
        type: Fact,
        nullable: true,
        resolve: (row, _args, context) =>
          context.permissions.has("fact:read")
            ? context.loaders.fact.load(row.factId)
            : null,
      }),
      person: t.field({
        type: Person,
        nullable: true,
        resolve: (row, _args, context) =>
          context.permissions.has("person:read")
            ? context.loaders.person.load(row.personId)
            : null,
      }),
      selectionReason: t.exposeString("selectionReason", { nullable: true }),
      version: t.exposeInt("version"),
      selectedBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.selectedBy}`),
      }),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
      updatedAt: t.field({
        type: "DateTime",
        resolve: (row) => row.updatedAt.toISOString(),
      }),
      createdBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.createdBy}`),
      }),
      updatedBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.updatedBy}`),
      }),
    }),
  });
const PersonFieldSelectionConnection = builder
  .objectRef<{
    nodes: PersonFieldSelectionRow[];
    pageInfo: PageInfoShape;
  }>("PersonFieldSelectionConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [PersonFieldSelection],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const FactRelationship = builder
  .objectRef<FactRelationshipRow>("FactRelationship")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      sourceFactId: t.expose("sourceFactId", { type: "UUID" }),
      targetFactId: t.expose("targetFactId", { type: "UUID" }),
      relationshipType: t.field({
        type: FactRelationshipType,
        resolve: (row) => row.relationshipType as never,
      }),
      explanation: t.exposeString("explanation", { nullable: true }),
      version: t.exposeInt("version"),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
      updatedAt: t.field({
        type: "DateTime",
        resolve: (row) => row.updatedAt.toISOString(),
      }),
      createdBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.createdBy}`),
      }),
      updatedBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.updatedBy}`),
      }),
    }),
  });
const FactRelationshipConnection = builder
  .objectRef<{ nodes: FactRelationshipRow[]; pageInfo: PageInfoShape }>(
    "FactRelationshipConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [FactRelationship],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

const FactValueInput = builder.inputType("FactValueInput", {
  fields: (t) => ({
    text: t.string(),
    decimal: t.string(),
    boolean: t.boolean(),
    dateStart: t.field({ type: "Date" }),
    dateEnd: t.field({ type: "Date" }),
    timestamp: t.field({ type: "DateTime" }),
    json: t.field({ type: "JSON" }),
    referencedPersonId: t.field({ type: "UUID" }),
    placeId: t.field({ type: "UUID" }),
    fileId: t.field({ type: "UUID" }),
    unit: t.string(),
  }),
});
const CreateFactDefinitionInput = builder.inputType(
  "CreateFactDefinitionInput",
  {
    fields: (t) => ({
      namespace: t.string({ required: true }),
      fieldKey: t.string({ required: true }),
      label: t.string({ required: true }),
      description: t.string(),
      category: t.string(),
      allowedValueType: t.field({ type: FactValueType, required: true }),
      cardinality: t.field({ type: FactCardinality }),
      validationSchema: t.field({ type: "JSON" }),
      enumerationMetadata: t.field({ type: "JSON" }),
      searchable: t.boolean(),
      filterable: t.boolean(),
      graphable: t.boolean(),
      defaultSensitivity: t.field({ type: Sensitivity }),
      state: t.field({ type: FactDefinitionState }),
    }),
  },
);
const UpdateFactDefinitionInput = builder.inputType(
  "UpdateFactDefinitionInput",
  {
    fields: (t) => ({
      id: t.field({ type: "UUID", required: true }),
      expectedVersion: t.int({ required: true }),
      label: t.string(),
      description: t.string(),
      category: t.string(),
      validationSchema: t.field({ type: "JSON" }),
      state: t.field({ type: FactDefinitionState }),
    }),
  },
);
const CreateFactInput = builder.inputType("CreateFactInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID", required: true }),
    definitionId: t.field({ type: "UUID", required: true }),
    value: t.field({ type: FactValueInput, required: true }),
    state: t.field({ type: FactState }),
    confidence: t.float(),
    confidenceMethod: t.string(),
    confidenceExplanation: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
    reviewState: t.field({ type: FactReviewState }),
    temporalSemantics: t.field({ type: TemporalSemantics }),
    temporalPrecision: t.field({ type: TemporalPrecision }),
    validEarliestAt: t.field({ type: "DateTime" }),
    validLatestAt: t.field({ type: "DateTime" }),
    observedAt: t.field({ type: "DateTime" }),
    supersedesFactId: t.field({ type: "UUID" }),
    language: t.string(),
  }),
});
const ReviseFactInput = builder.inputType("ReviseFactInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    value: t.field({ type: FactValueInput }),
    state: t.field({ type: FactState }),
    confidence: t.float(),
    reviewState: t.field({ type: FactReviewState }),
    sensitivity: t.field({ type: Sensitivity }),
    changeReason: t.string(),
  }),
});
const SelectPersonFieldInput = builder.inputType("SelectPersonFieldInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID", required: true }),
    namespace: t.string({ required: true }),
    fieldKey: t.string({ required: true }),
    factId: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int(),
    selectionReason: t.string(),
  }),
});
const CreateFactRelationshipInput = builder.inputType(
  "CreateFactRelationshipInput",
  {
    fields: (t) => ({
      sourceFactId: t.field({ type: "UUID", required: true }),
      targetFactId: t.field({ type: "UUID", required: true }),
      relationshipType: t.field({ type: FactRelationshipType, required: true }),
      explanation: t.string(),
    }),
  },
);
const ArchiveFactRelationshipInput = builder.inputType(
  "ArchiveFactRelationshipInput",
  {
    fields: (t) => ({
      id: t.field({ type: "UUID", required: true }),
      expectedVersion: t.int({ required: true }),
    }),
  },
);

type DefinitionPayloadShape = MutationOutcome<FactDefinitionRow> & {
  factDefinition: FactDefinitionRow | null;
};
const FactDefinitionPayload = builder
  .objectRef<DefinitionPayloadShape>("FactDefinitionPayload")
  .implement({
    fields: (t) => ({
      factDefinition: t.expose("factDefinition", {
        type: FactDefinition,
        nullable: true,
      }),
      issues: t.expose("issues", { type: [ValidationIssue] }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });
type FactPayloadShape = MutationOutcome<FactRow> & { fact: FactRow | null };
const FactPayload = builder
  .objectRef<FactPayloadShape>("FactPayload")
  .implement({
    fields: (t) => ({
      fact: t.expose("fact", { type: Fact, nullable: true }),
      issues: t.expose("issues", { type: [ValidationIssue] }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });
type SelectionPayloadShape = MutationOutcome<PersonFieldSelectionRow> & {
  selection: PersonFieldSelectionRow | null;
};
const SelectionPayload = builder
  .objectRef<SelectionPayloadShape>("PersonFieldSelectionPayload")
  .implement({
    fields: (t) => ({
      selection: t.expose("selection", {
        type: PersonFieldSelection,
        nullable: true,
      }),
      issues: t.expose("issues", { type: [ValidationIssue] }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });
type FactRelationshipPayloadShape = MutationOutcome<FactRelationshipRow> & {
  factRelationship: FactRelationshipRow | null;
};
const FactRelationshipPayload = builder
  .objectRef<FactRelationshipPayloadShape>("FactRelationshipPayload")
  .implement({
    fields: (t) => ({
      factRelationship: t.expose("factRelationship", {
        type: FactRelationship,
        nullable: true,
      }),
      issues: t.expose("issues", { type: [ValidationIssue] }),
      code: t.exposeString("code", { nullable: true }),
    }),
  });

function pageMultiplier(first: number | null | undefined): number {
  const value = first ?? 25;
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 101;
}

export function registerFactsGraphQL(): void {
  builder.objectFields(Fact, (t) => ({
    relationships: t.field({
      type: FactRelationshipConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 2,
        multiplier: pageMultiplier(args.first),
      }),
      resolve: (fact, args, context) => {
        requirePermission(context, "fact", "read");
        normalizePagination(args);
        return context.loaders.factRelationships.load({
          factId: fact.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
  }));
  builder.objectFields(Person, (t) => ({
    facts: t.field({
      type: FactConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 2,
        multiplier: pageMultiplier(args.first),
      }),
      resolve: (person, args, context) => {
        requirePermission(context, "fact", "read");
        normalizePagination(args);
        return context.loaders.factsByPerson.load({
          personId: person.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
    contradictoryFacts: t.field({
      type: FactConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 3,
        multiplier: pageMultiplier(args.first),
      }),
      resolve: (person, args, context) => {
        requirePermission(context, "person", "read");
        requirePermission(context, "fact", "read");
        normalizePagination(args);
        return context.services.people.listContradictoryFacts({
          personId: person.id,
          first: args.first,
          after: args.after,
        });
      },
    }),
    fieldSelections: t.field({
      type: PersonFieldSelectionConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({
        field: 2,
        multiplier: pageMultiplier(args.first),
      }),
      resolve: (person, args, context) => {
        requirePermission(context, "person", "read");
        requirePermission(context, "fact", "read");
        normalizePagination(args);
        return context.loaders.fieldSelectionsByPerson.load({
          personId: person.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
  }));
  builder.queryFields((t) => ({
    factDefinitions: t.field({
      type: FactDefinitionConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        filter: t.arg({ type: FactDefinitionFilterInput }),
      },
      complexity: (args) => ({
        field: 1,
        multiplier: pageMultiplier(args.first),
      }),
      resolve: (_r, args, context) => {
        requirePermission(context, "fact", "read");
        return context.services.facts.listDefinitions({
          first: args.first,
          after: args.after,
          ...args.filter,
        });
      },
    }),
    factDefinition: t.field({
      type: FactDefinition,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, args, context) => {
        requirePermission(context, "fact", "read");
        return context.loaders.factDefinition.load(args.id);
      },
    }),
    facts: t.field({
      type: FactConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        personId: t.arg({ type: "UUID" }),
        definitionId: t.arg({ type: "UUID" }),
        filter: t.arg({ type: FactFilterInput }),
      },
      complexity: (args) => ({
        field: 2,
        multiplier: pageMultiplier(args.first),
      }),
      resolve: (_r, args, context) => {
        requirePermission(context, "fact", "read");
        return context.services.facts.list({
          first: args.first,
          after: args.after,
          personId: args.filter?.personId ?? args.personId,
          definitionId: args.filter?.definitionId ?? args.definitionId,
          namespace: args.filter?.namespace,
          fieldKey: args.filter?.fieldKey,
          state: args.filter?.state,
          reviewState: args.filter?.reviewState,
          sensitivity: args.filter?.sensitivity,
        });
      },
    }),
    fact: t.field({
      type: Fact,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, args, context) => {
        requirePermission(context, "fact", "read");
        return context.loaders.fact.load(args.id);
      },
    }),
  }));
  builder.mutationFields((t) => ({
    createFactDefinition: t.field({
      type: FactDefinitionPayload,
      args: {
        input: t.arg({ type: CreateFactDefinitionInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "create");
        const result = await context.services.facts.createDefinition(
          args.input,
        );
        if (result.resource)
          context.loaders.factDefinition.prime(
            result.resource.id,
            result.resource,
          );
        return { ...result, factDefinition: result.resource };
      },
    }),
    updateFactDefinition: t.field({
      type: FactDefinitionPayload,
      args: {
        input: t.arg({ type: UpdateFactDefinitionInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "update");
        const result = await context.services.facts.updateDefinition(
          args.input,
        );
        if (result.resource)
          context.loaders.factDefinition
            .clear(result.resource.id)
            .prime(result.resource.id, result.resource);
        return { ...result, factDefinition: result.resource };
      },
    }),
    createFact: t.field({
      type: FactPayload,
      args: { input: t.arg({ type: CreateFactInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "create");
        requirePermission(context, "person", "read");
        const result = await context.services.facts.create(args.input);
        if (result.resource) {
          context.loaders.fact.prime(result.resource.id, result.resource);
          context.loaders.factsByPerson.clearAll();
        }
        return { ...result, fact: result.resource };
      },
    }),
    reviseFact: t.field({
      type: FactPayload,
      args: { input: t.arg({ type: ReviseFactInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "update");
        const result = await context.services.facts.revise(args.input);
        if (result.resource) {
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "fact",
            id: result.resource.id,
          });
        }
        return { ...result, fact: result.resource };
      },
    }),
    selectPersonField: t.field({
      type: SelectionPayload,
      args: { input: t.arg({ type: SelectPersonFieldInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "select");
        requirePermission(context, "person", "update");
        const result = await context.services.facts.selectField(args.input);
        if (result.resource) context.loaders.fieldSelectionsByPerson.clearAll();
        return { ...result, selection: result.resource };
      },
    }),
    createFactRelationship: t.field({
      type: FactRelationshipPayload,
      args: {
        input: t.arg({ type: CreateFactRelationshipInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "update");
        const result = await context.services.facts.createRelationship(
          args.input,
        );
        if (result.resource) context.loaders.factRelationships.clearAll();
        return { ...result, factRelationship: result.resource };
      },
    }),
    archiveFactRelationship: t.field({
      type: FactRelationshipPayload,
      args: {
        input: t.arg({ type: ArchiveFactRelationshipInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "update");
        const result = await context.services.facts.archiveRelationship(
          args.input,
        );
        if (result.resource) context.loaders.factRelationships.clearAll();
        return { ...result, factRelationship: result.resource };
      },
    }),
  }));
}
