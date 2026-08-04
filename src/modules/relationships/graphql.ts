import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { invalidateVisibilityDependentLoaders } from "@/graphql/loaders";
import { ActorAttribution } from "@/modules/audit/attribution-graphql";
import {
  PageInfo,
  Person,
  Sensitivity,
  ValidationIssue,
} from "@/modules/people/graphql";
import type {
  MutationOutcome,
  PageInfo as PageInfoShape,
} from "@/modules/people/service";

import type { RelationshipRow, RelationshipTypeRow } from "./repository";

function enumType(name: string, values: readonly string[]) {
  return builder.enumType(name, {
    values: Object.fromEntries(
      values.map((value) => [value.toUpperCase(), { value }]),
    ) as never,
  });
}
const Multiplicity = enumType("RelationshipMultiplicity", [
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
]);
const LifecycleState = enumType("LifecycleState", [
  "active",
  "inactive",
  "archived",
]);
const TemporalSemantics = enumType("RelationshipTemporalSemantics", [
  "exact",
  "approximate",
  "before",
  "after",
  "between",
  "year_only",
  "unknown",
]);
const TemporalPrecision = enumType("RelationshipTemporalPrecision", [
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
const RelationshipState = enumType("RelationshipState", [
  "asserted",
  "inferred",
  "corroborated",
  "disputed",
  "disproven",
  "inactive",
]);
const RelationshipFilterInput = builder.inputType("RelationshipFilterInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID" }),
    relationshipTypeId: t.field({ type: "UUID" }),
    state: t.field({ type: RelationshipState }),
    sensitivity: t.field({ type: Sensitivity }),
    activeAt: t.field({ type: "DateTime" }),
  }),
});
const RelationshipTypeFilterInput = builder.inputType(
  "RelationshipTypeFilterInput",
  {
    fields: (t) => ({
      namespace: t.string(),
      key: t.string(),
      state: t.field({ type: LifecycleState }),
      directed: t.boolean(),
      allowsSelf: t.boolean(),
      allowedMultiplicity: t.field({ type: Multiplicity }),
    }),
  },
);

export const RelationshipType = builder
  .objectRef<RelationshipTypeRow>("RelationshipType")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      namespace: t.exposeString("namespace"),
      key: t.exposeString("key"),
      forwardLabel: t.exposeString("forwardLabel"),
      inverseLabel: t.exposeString("inverseLabel"),
      directed: t.exposeBoolean("directed"),
      allowsSelf: t.exposeBoolean("allowsSelf"),
      allowedMultiplicity: t.field({
        type: Multiplicity,
        resolve: (row) => row.allowedMultiplicity as never,
      }),
      metadataSchema: t.field({
        type: "JSON",
        resolve: (row) => row.metadataSchema,
      }),
      state: t.field({
        type: LifecycleState,
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
export const Relationship = builder
  .objectRef<RelationshipRow>("Relationship")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      sourcePersonId: t.field({
        type: "UUID",
        nullable: true,
        resolve: async (row, _args, context) =>
          context.permissions.has("person:read") &&
          (await context.loaders.person.load(row.sourcePersonId))
            ? row.sourcePersonId
            : null,
      }),
      targetPersonId: t.field({
        type: "UUID",
        nullable: true,
        resolve: async (row, _args, context) =>
          context.permissions.has("person:read") &&
          (await context.loaders.person.load(row.targetPersonId))
            ? row.targetPersonId
            : null,
      }),
      relationshipTypeId: t.expose("relationshipTypeId", { type: "UUID" }),
      labelOverride: t.exposeString("labelOverride", { nullable: true }),
      strength: t.float({
        nullable: true,
        resolve: (row) => (row.strength == null ? null : Number(row.strength)),
      }),
      confidence: t.float({ resolve: (row) => Number(row.confidence) }),
      state: t.exposeString("state"),
      sensitivity: t.field({
        type: Sensitivity,
        resolve: (row) => row.sensitivity,
      }),
      temporalSemantics: t.field({
        type: TemporalSemantics,
        resolve: (row) => row.temporalSemantics as never,
      }),
      temporalPrecision: t.field({
        type: TemporalPrecision,
        resolve: (row) => row.temporalPrecision as never,
      }),
      validFrom: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.validFrom?.toISOString() ?? null,
      }),
      validUntil: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.validUntil?.toISOString() ?? null,
      }),
      metadata: t.field({ type: "JSON", resolve: (row) => row.metadata }),
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
const RelationshipTypeConnection = builder
  .objectRef<{ nodes: RelationshipTypeRow[]; pageInfo: PageInfoShape }>(
    "RelationshipTypeConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [RelationshipType],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const RelationshipConnection = builder
  .objectRef<{ nodes: RelationshipRow[]; pageInfo: PageInfoShape }>(
    "RelationshipConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [Relationship],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const CreateRelationshipTypeInput = builder.inputType(
  "CreateRelationshipTypeInput",
  {
    fields: (t) => ({
      namespace: t.string(),
      key: t.string({ required: true }),
      forwardLabel: t.string({ required: true }),
      inverseLabel: t.string({ required: true }),
      directed: t.boolean(),
      allowsSelf: t.boolean(),
      allowedMultiplicity: t.field({ type: Multiplicity }),
      metadataSchema: t.field({ type: "JSON" }),
      state: t.field({ type: LifecycleState }),
    }),
  },
);
const UpdateRelationshipTypeInput = builder.inputType(
  "UpdateRelationshipTypeInput",
  {
    fields: (t) => ({
      id: t.field({ type: "UUID", required: true }),
      expectedVersion: t.int({ required: true }),
      forwardLabel: t.string(),
      inverseLabel: t.string(),
      allowsSelf: t.boolean(),
      allowedMultiplicity: t.field({ type: Multiplicity }),
      metadataSchema: t.field({ type: "JSON" }),
      state: t.field({ type: LifecycleState }),
    }),
  },
);
const CreateRelationshipInput = builder.inputType("CreateRelationshipInput", {
  fields: (t) => ({
    sourcePersonId: t.field({ type: "UUID", required: true }),
    targetPersonId: t.field({ type: "UUID", required: true }),
    relationshipTypeId: t.field({ type: "UUID", required: true }),
    labelOverride: t.string(),
    strength: t.float(),
    confidence: t.float(),
    state: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
    temporalSemantics: t.field({ type: TemporalSemantics }),
    temporalPrecision: t.field({ type: TemporalPrecision }),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
    metadata: t.field({ type: "JSON" }),
  }),
});
const UpdateRelationshipInput = builder.inputType("UpdateRelationshipInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    labelOverride: t.string(),
    strength: t.float(),
    confidence: t.float(),
    state: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
    temporalSemantics: t.field({ type: TemporalSemantics }),
    temporalPrecision: t.field({ type: TemporalPrecision }),
    validFrom: t.field({ type: "DateTime" }),
    validUntil: t.field({ type: "DateTime" }),
    metadata: t.field({ type: "JSON" }),
  }),
});
const ArchiveRelationshipInput = builder.inputType("ArchiveRelationshipInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});
type TypePayload = MutationOutcome<RelationshipTypeRow> & {
  relationshipType: RelationshipTypeRow | null;
};
const RelationshipTypePayload = builder
  .objectRef<TypePayload>("RelationshipTypePayload")
  .implement({
    fields: (t) => ({
      relationshipType: t.expose("relationshipType", {
        type: RelationshipType,
        nullable: true,
      }),
      issues: t.expose("issues", { type: [ValidationIssue] }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });
type EdgePayload = MutationOutcome<RelationshipRow> & {
  relationship: RelationshipRow | null;
};
const RelationshipPayload = builder
  .objectRef<EdgePayload>("RelationshipPayload")
  .implement({
    fields: (t) => ({
      relationship: t.expose("relationship", {
        type: Relationship,
        nullable: true,
      }),
      issues: t.expose("issues", { type: [ValidationIssue] }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });
function multiplier(first?: number | null) {
  const n = first ?? 25;
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : 101;
}

export function registerRelationshipsGraphQL(): void {
  builder.objectFields(Person, (t) => ({
    relationships: t.field({
      type: RelationshipConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (person, args, context) => {
        requirePermission(context, "relationship", "read");
        return context.loaders.relationshipsByPerson.load({
          personId: person.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
  }));
  builder.queryFields((t) => ({
    relationshipTypes: t.field({
      type: RelationshipTypeConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        filter: t.arg({ type: RelationshipTypeFilterInput }),
      },
      complexity: (args) => ({ field: 1, multiplier: multiplier(args.first) }),
      resolve: (_r, args, context) => {
        requirePermission(context, "relationship", "read");
        return context.services.relationships.listTypes({
          first: args.first,
          after: args.after,
          ...args.filter,
        });
      },
    }),
    relationshipType: t.field({
      type: RelationshipType,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, args, context) => {
        requirePermission(context, "relationship", "read");
        return context.loaders.relationshipType.load(args.id);
      },
    }),
    relationships: t.field({
      type: RelationshipConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        personId: t.arg({ type: "UUID" }),
        filter: t.arg({ type: RelationshipFilterInput }),
      },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (_r, args, context) => {
        requirePermission(context, "relationship", "read");
        return context.services.relationships.list({
          first: args.first,
          after: args.after,
          personId: args.filter?.personId ?? args.personId,
          relationshipTypeId: args.filter?.relationshipTypeId,
          state: args.filter?.state,
          sensitivity: args.filter?.sensitivity,
          activeAt: args.filter?.activeAt,
        });
      },
    }),
    relationship: t.field({
      type: Relationship,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, args, context) => {
        requirePermission(context, "relationship", "read");
        return context.loaders.relationship.load(args.id);
      },
    }),
  }));
  builder.mutationFields((t) => ({
    createRelationshipType: t.field({
      type: RelationshipTypePayload,
      args: {
        input: t.arg({ type: CreateRelationshipTypeInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "relationship", "create");
        const result = await context.services.relationships.createType(
          args.input,
        );
        if (result.resource)
          context.loaders.relationshipType.prime(
            result.resource.id,
            result.resource,
          );
        return { ...result, relationshipType: result.resource };
      },
    }),
    updateRelationshipType: t.field({
      type: RelationshipTypePayload,
      args: {
        input: t.arg({ type: UpdateRelationshipTypeInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "relationship", "update");
        const result = await context.services.relationships.updateType(
          args.input,
        );
        if (result.resource)
          context.loaders.relationshipType
            .clear(result.resource.id)
            .prime(result.resource.id, result.resource);
        return { ...result, relationshipType: result.resource };
      },
    }),
    createRelationship: t.field({
      type: RelationshipPayload,
      args: { input: t.arg({ type: CreateRelationshipInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "relationship", "create");
        requirePermission(context, "person", "read");
        const result = await context.services.relationships.create(args.input);
        if (result.resource) {
          context.loaders.relationship.prime(
            result.resource.id,
            result.resource,
          );
          context.loaders.relationshipsByPerson.clearAll();
        }
        return { ...result, relationship: result.resource };
      },
    }),
    updateRelationship: t.field({
      type: RelationshipPayload,
      args: { input: t.arg({ type: UpdateRelationshipInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "relationship", "update");
        const result = await context.services.relationships.update(args.input);
        if (result.resource) {
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "relationship",
            id: result.resource.id,
          });
        }
        return { ...result, relationship: result.resource };
      },
    }),
    archiveRelationship: t.field({
      type: RelationshipPayload,
      args: {
        input: t.arg({ type: ArchiveRelationshipInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "relationship", "delete");
        const result = await context.services.relationships.archive(args.input);
        if (result.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "relationship",
            id: result.resource.id,
          });
        return { ...result, relationship: result.resource };
      },
    }),
  }));
}
