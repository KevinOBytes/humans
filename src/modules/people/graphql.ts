import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { invalidateVisibilityDependentLoaders } from "@/graphql/loaders";
import { normalizePagination } from "@/graphql/limits";
import { ActorAttribution } from "@/modules/audit/attribution-graphql";

import type { PersonRow } from "./repository";
import type { MutationOutcome, PageInfo as PageInfoShape } from "./service";

export const Sensitivity = builder.enumType("Sensitivity", {
  values: {
    PUBLIC: { value: "public" },
    INTERNAL: { value: "internal" },
    CONFIDENTIAL: { value: "confidential" },
    RESTRICTED: { value: "restricted" },
  } as const,
});

export const PersonStatus = builder.enumType("PersonStatus", {
  values: {
    ACTIVE: { value: "active" },
    DECEASED: { value: "deceased" },
    MISSING: { value: "missing" },
    UNKNOWN: { value: "unknown" },
    ARCHIVED: { value: "archived" },
    MERGED: { value: "merged" },
  } as const,
});

export const ValidationIssue = builder
  .objectRef<{
    path: string[];
    code: string;
    message: string;
  }>("ValidationIssue")
  .implement({
    fields: (t) => ({
      path: t.exposeStringList("path", {
        nullable: { items: false, list: false },
      }),
      code: t.exposeString("code", { nullable: false }),
      message: t.exposeString("message", { nullable: false }),
    }),
  });

export const PageInfo = builder.objectRef<PageInfoShape>("PageInfo").implement({
  fields: (t) => ({
    hasNextPage: t.exposeBoolean("hasNextPage", { nullable: false }),
    endCursor: t.exposeString("endCursor", { nullable: true }),
  }),
});

export const Person = builder.objectRef<PersonRow>("Person").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID", nullable: false }),
    displayName: t.exposeString("displayName", { nullable: false }),
    sortName: t.exposeString("sortName", { nullable: true }),
    preferredName: t.exposeString("preferredName", { nullable: true }),
    biography: t.exposeString("biography", { nullable: true }),
    primaryNameId: t.expose("primaryNameId", { type: "UUID", nullable: true }),
    primaryPhotoFileId: t.expose("primaryPhotoFileId", {
      type: "UUID",
      nullable: true,
    }),
    mergedIntoPersonId: t.expose("mergedIntoPersonId", {
      type: "UUID",
      nullable: true,
    }),
    status: t.expose("status", { type: PersonStatus, nullable: false }),
    sensitivity: t.expose("sensitivity", {
      type: Sensitivity,
      nullable: false,
    }),
    confidence: t.float({
      nullable: false,
      resolve: (row) => Number(row.confidence),
    }),
    confidenceExplanation: t.exposeString("confidenceExplanation", {
      nullable: true,
    }),
    version: t.exposeInt("version", { nullable: false }),
    createdAt: t.field({
      type: "DateTime",
      nullable: false,
      resolve: (row) => row.createdAt.toISOString(),
    }),
    updatedAt: t.field({
      type: "DateTime",
      nullable: false,
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

const PersonConnection = builder
  .objectRef<{
    nodes: PersonRow[];
    pageInfo: PageInfoShape;
  }>("PersonConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [Person],
        nullable: { items: false, list: false },
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo, nullable: false }),
    }),
  });

const PersonFilterInput = builder.inputType("PersonFilterInput", {
  fields: (t) => ({
    name: t.string(),
    namePrefix: t.string(),
    nameContains: t.string(),
    status: t.field({ type: PersonStatus }),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});

const MergePersonInput = builder.inputType("MergePersonInput", {
  fields: (t) => ({
    winnerPersonId: t.field({ type: "UUID", required: true }),
    loserPersonId: t.field({ type: "UUID", required: true }),
    reason: t.string({ required: true }),
  }),
});
const UnmergePersonInput = builder.inputType("UnmergePersonInput", {
  fields: (t) => ({
    loserPersonId: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});
const SelectPersonPresentationInput = builder.inputType(
  "SelectPersonPresentationInput",
  {
    fields: (t) => ({
      personId: t.field({ type: "UUID", required: true }),
      expectedVersion: t.int({ required: true }),
      primaryNameId: t.field({ type: "UUID" }),
      primaryPhotoFileId: t.field({ type: "UUID" }),
    }),
  },
);

const CreatePersonInput = builder.inputType("CreatePersonInput", {
  fields: (t) => ({
    displayName: t.string({ required: true }),
    sortName: t.string(),
    preferredName: t.string(),
    biography: t.string(),
    status: t.field({ type: PersonStatus }),
    sensitivity: t.field({ type: Sensitivity }),
    confidence: t.float(),
    confidenceExplanation: t.string(),
  }),
});

const UpdatePersonInput = builder.inputType("UpdatePersonInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    displayName: t.string(),
    sortName: t.string(),
    preferredName: t.string(),
    biography: t.string(),
    status: t.field({ type: PersonStatus }),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});

const ArchivePersonInput = builder.inputType("ArchivePersonInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});

type PersonPayloadShape = MutationOutcome<PersonRow> & {
  person: PersonRow | null;
};
const PersonPayload = builder
  .objectRef<PersonPayloadShape>("PersonPayload")
  .implement({
    fields: (t) => ({
      person: t.expose("person", { type: Person, nullable: true }),
      issues: t.expose("issues", {
        type: [ValidationIssue],
        nullable: { items: false, list: false },
      }),
      code: t.exposeString("code", { nullable: true }),
      currentVersion: t.exposeInt("currentVersion", { nullable: true }),
    }),
  });

function payload(outcome: MutationOutcome<PersonRow>): PersonPayloadShape {
  return { ...outcome, person: outcome.resource };
}

function connectionComplexity(first: number | null | undefined) {
  const requested = first ?? 25;
  return {
    field: 1,
    multiplier:
      Number.isInteger(requested) && requested >= 1 && requested <= 100
        ? requested
        : 101,
  };
}

function dashboardConnectionComplexity(first: number | null | undefined) {
  const requested = first ?? 8;
  return {
    field: 1,
    multiplier:
      Number.isInteger(requested) && requested >= 1 && requested <= 10
        ? requested
        : 11,
  };
}

export function registerPeopleGraphQL(): void {
  builder.queryFields((t) => ({
    people: t.field({
      type: PersonConnection,
      nullable: false,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        filter: t.arg({ type: PersonFilterInput }),
      },
      complexity: (args) => connectionComplexity(args.first),
      resolve: async (_root, args, context) => {
        requirePermission(context, "person", "read");
        normalizePagination(args);
        return context.services.people.list({
          first: args.first,
          after: args.after,
          name: args.filter?.name,
          namePrefix: args.filter?.namePrefix,
          nameContains: args.filter?.nameContains,
          status: args.filter?.status,
          sensitivity: args.filter?.sensitivity,
        });
      },
    }),
    dashboardRecentPeople: t.field({
      type: PersonConnection,
      nullable: false,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
      },
      complexity: (args) => dashboardConnectionComplexity(args.first),
      resolve: (_root, args, context) => {
        requirePermission(context, "person", "read");
        return context.services.people.listRecent(args);
      },
    }),
    person: t.field({
      type: Person,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_root, args, context) => {
        requirePermission(context, "person", "read");
        return context.loaders.person.load(args.id);
      },
    }),
  }));

  builder.mutationFields((t) => ({
    createPerson: t.field({
      type: PersonPayload,
      nullable: false,
      args: { input: t.arg({ type: CreatePersonInput, required: true }) },
      resolve: async (_root, args, context) => {
        requirePermission(context, "person", "create");
        const outcome = await context.services.people.create(args.input);
        if (outcome.resource)
          context.loaders.person.prime(outcome.resource.id, outcome.resource);
        return payload(outcome);
      },
    }),
    updatePerson: t.field({
      type: PersonPayload,
      nullable: false,
      args: { input: t.arg({ type: UpdatePersonInput, required: true }) },
      resolve: async (_root, args, context) => {
        requirePermission(context, "person", "update");
        const outcome = await context.services.people.update(args.input);
        if (outcome.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "person",
            id: outcome.resource.id,
          });
        return payload(outcome);
      },
    }),
    archivePerson: t.field({
      type: PersonPayload,
      nullable: false,
      args: { input: t.arg({ type: ArchivePersonInput, required: true }) },
      resolve: async (_root, args, context) => {
        requirePermission(context, "person", "delete");
        const outcome = await context.services.people.archive(args.input);
        if (outcome.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "person",
            id: outcome.resource.id,
          });
        return payload(outcome);
      },
    }),
    mergePerson: t.field({
      type: PersonPayload,
      nullable: false,
      args: { input: t.arg({ type: MergePersonInput, required: true }) },
      resolve: async (_root, args, context) => {
        requirePermission(context, "person", "merge");
        const outcome = await context.services.people.merge(args.input);
        if (outcome.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "person",
            id: args.input.loserPersonId,
          });
        return payload(outcome);
      },
    }),
    unmergePerson: t.field({
      type: PersonPayload,
      nullable: false,
      args: { input: t.arg({ type: UnmergePersonInput, required: true }) },
      resolve: async (_root, args, context) => {
        requirePermission(context, "person", "merge");
        const outcome = await context.services.people.unmerge(args.input);
        if (outcome.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "person",
            id: outcome.resource.id,
          });
        return payload(outcome);
      },
    }),
    selectPersonPresentation: t.field({
      type: PersonPayload,
      nullable: false,
      args: {
        input: t.arg({ type: SelectPersonPresentationInput, required: true }),
      },
      resolve: async (_root, args, context) => {
        requirePermission(context, "person", "update");
        const outcome = await context.services.people.selectPresentation(
          args.input,
        );
        if (outcome.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "person",
            id: outcome.resource.id,
          });
        return payload(outcome);
      },
    }),
  }));
}
