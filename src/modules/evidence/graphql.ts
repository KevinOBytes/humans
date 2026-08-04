import { builder } from "@/graphql/builder";
import { requirePermission } from "@/graphql/context";
import { invalidateVisibilityDependentLoaders } from "@/graphql/loaders";
import { normalizePagination } from "@/graphql/limits";
import { ActorAttribution } from "@/modules/audit/attribution-graphql";
import { Fact } from "@/modules/facts/graphql";
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
import { Relationship } from "@/modules/relationships/graphql";

import type {
  EvidenceExcerptRow,
  EvidenceItemRow,
  FactEvidenceRow,
  FactTagRow,
  NoteRow,
  PersonTagRow,
  RelationshipEvidenceRow,
  RelationshipTagRow,
  SourceRow,
  TagRow,
} from "./repository";

function multiplier(first?: number | null) {
  const n = first ?? 25;
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : 101;
}

const EvidenceReviewState = builder.enumType("EvidenceReviewState", {
  values: {
    UNREVIEWED: { value: "unreviewed" },
    IN_REVIEW: { value: "in_review" },
    ACCEPTED: { value: "accepted" },
    REJECTED: { value: "rejected" },
    NEEDS_ATTENTION: { value: "needs_attention" },
  } as const,
});
const SourceFilterInput = builder.inputType("SourceFilterInput", {
  fields: (t) => ({
    kind: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});
const EvidenceFilterInput = builder.inputType("EvidenceFilterInput", {
  fields: (t) => ({
    sourceId: t.field({ type: "UUID" }),
    reviewState: t.field({ type: EvidenceReviewState }),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});

export const Source = builder.objectRef<SourceRow>("Source").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    kind: t.exposeString("kind"),
    title: t.exposeString("title"),
    publisher: t.exposeString("publisher", { nullable: true }),
    author: t.exposeString("author", { nullable: true }),
    canonicalUrl: t.exposeString("canonicalUrl", { nullable: true }),
    citation: t.exposeString("citation", { nullable: true }),
    collectionMethod: t.exposeString("collectionMethod", { nullable: true }),
    collectedAt: t.field({
      type: "DateTime",
      nullable: true,
      resolve: (row) => row.collectedAt?.toISOString() ?? null,
    }),
    reliability: t.float({
      nullable: true,
      resolve: (row) =>
        row.reliability == null ? null : Number(row.reliability),
    }),
    sensitivity: t.field({
      type: Sensitivity,
      resolve: (row) => row.sensitivity,
    }),
    metadata: t.field({ type: "JSON", resolve: (row) => row.metadata }),
    contentHash: t.exposeString("contentHash", { nullable: true }),
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

export const EvidenceExcerpt = builder
  .objectRef<EvidenceExcerptRow>("EvidenceExcerpt")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      evidenceItemId: t.expose("evidenceItemId", { type: "UUID" }),
      pageNumber: t.exposeInt("pageNumber", { nullable: true }),
      startOffset: t.exposeInt("startOffset", { nullable: true }),
      endOffset: t.exposeInt("endOffset", { nullable: true }),
      startTimeMs: t.exposeInt("startTimeMs", { nullable: true }),
      endTimeMs: t.exposeInt("endTimeMs", { nullable: true }),
      locator: t.exposeString("locator", { nullable: true }),
      excerpt: t.exposeString("excerpt"),
      language: t.exposeString("language", { nullable: true }),
      checksum: t.exposeString("checksum"),
      redactionState: t.exposeString("redactionState"),
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
const EvidenceExcerptConnection = builder
  .objectRef<{ nodes: EvidenceExcerptRow[]; pageInfo: PageInfoShape }>(
    "EvidenceExcerptConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [EvidenceExcerpt],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

export const EvidenceItem = builder
  .objectRef<EvidenceItemRow>("EvidenceItem")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      sourceId: t.field({
        type: "UUID",
        nullable: true,
        resolve: async (row, _args, context) =>
          context.permissions.has("source:read") &&
          (await context.loaders.source.load(row.sourceId))
            ? row.sourceId
            : null,
      }),
      fileId: t.field({
        type: "UUID",
        nullable: true,
        resolve: async (row, _args, context) =>
          row.fileId &&
          context.permissions.has("file:read") &&
          (await context.services.evidence.canReadFile(row.fileId))
            ? row.fileId
            : null,
      }),
      externalLocator: t.exposeString("externalLocator", { nullable: true }),
      capturedAt: t.field({
        type: "DateTime",
        nullable: true,
        resolve: (row) => row.capturedAt?.toISOString() ?? null,
      }),
      checksum: t.exposeString("checksum"),
      reviewState: t.exposeString("reviewState"),
      sensitivity: t.field({
        type: Sensitivity,
        resolve: (row) => row.sensitivity,
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
      source: t.field({
        type: Source,
        nullable: true,
        complexity: 1,
        resolve: (row, _args, context) => {
          requirePermission(context, "source", "read");
          return context.loaders.source.load(row.sourceId);
        },
      }),
      excerpts: t.field({
        type: EvidenceExcerptConnection,
        args: { first: t.arg.int(), after: t.arg.string() },
        complexity: (args) => ({
          field: 2,
          multiplier: multiplier(args.first),
        }),
        resolve: (row, args, context) => {
          requirePermission(context, "evidence", "read");
          normalizePagination(args);
          return context.loaders.evidenceExcerpts.load({
            evidenceItemId: row.id,
            first: args.first ?? 25,
            after: args.after ?? null,
          });
        },
      }),
    }),
  });

export const FactEvidence = builder
  .objectRef<FactEvidenceRow>("FactEvidence")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      factId: t.expose("factId", { type: "UUID" }),
      evidenceItemId: t.expose("evidenceItemId", { type: "UUID" }),
      excerpt: t.exposeString("excerpt", { nullable: true }),
      locator: t.exposeString("locator", { nullable: true }),
      supportStrength: t.float({
        nullable: true,
        resolve: (row) =>
          row.supportStrength == null ? null : Number(row.supportStrength),
      }),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
      createdBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.createdBy}`),
      }),
      evidenceItem: t.field({
        type: EvidenceItem,
        nullable: true,
        resolve: (row, _args, context) =>
          context.permissions.has("evidence:read")
            ? context.loaders.evidenceItem.load(row.evidenceItemId)
            : null,
      }),
    }),
  });
export const RelationshipEvidence = builder
  .objectRef<RelationshipEvidenceRow>("RelationshipEvidence")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      relationshipId: t.expose("relationshipId", { type: "UUID" }),
      evidenceItemId: t.expose("evidenceItemId", { type: "UUID" }),
      locator: t.exposeString("locator", { nullable: true }),
      supportStrength: t.float({
        nullable: true,
        resolve: (row) =>
          row.supportStrength == null ? null : Number(row.supportStrength),
      }),
      createdAt: t.field({
        type: "DateTime",
        resolve: (row) => row.createdAt.toISOString(),
      }),
      createdBy: t.field({
        type: ActorAttribution,
        resolve: (row, _args, context) =>
          context.loaders.actorAttribution.load(`p:${row.createdBy}`),
      }),
      evidenceItem: t.field({
        type: EvidenceItem,
        nullable: true,
        resolve: (row, _args, context) =>
          context.permissions.has("evidence:read")
            ? context.loaders.evidenceItem.load(row.evidenceItemId)
            : null,
      }),
    }),
  });
const FactEvidenceConnection = builder
  .objectRef<{ nodes: FactEvidenceRow[]; pageInfo: PageInfoShape }>(
    "FactEvidenceConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [FactEvidence],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const RelationshipEvidenceConnection = builder
  .objectRef<{ nodes: RelationshipEvidenceRow[]; pageInfo: PageInfoShape }>(
    "RelationshipEvidenceConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [RelationshipEvidence],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

export const Note = builder.objectRef<NoteRow>("Note").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    personId: t.expose("personId", { type: "UUID", nullable: true }),
    factId: t.expose("factId", { type: "UUID", nullable: true }),
    relationshipId: t.expose("relationshipId", {
      type: "UUID",
      nullable: true,
    }),
    evidenceItemId: t.expose("evidenceItemId", {
      type: "UUID",
      nullable: true,
    }),
    plainText: t.exposeString("plainText", { nullable: true }),
    sanitizedMarkdown: t.exposeString("sanitizedMarkdown", {
      nullable: true,
    }),
    sensitivity: t.field({
      type: Sensitivity,
      resolve: (row) => row.sensitivity,
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
export const Tag = builder.objectRef<TagRow>("Tag").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    name: t.exposeString("name"),
    normalizedName: t.exposeString("normalizedName"),
    color: t.exposeString("color", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
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

const SourceConnection = builder
  .objectRef<{ nodes: SourceRow[]; pageInfo: PageInfoShape }>(
    "SourceConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [Source],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const EvidenceItemConnection = builder
  .objectRef<{ nodes: EvidenceItemRow[]; pageInfo: PageInfoShape }>(
    "EvidenceItemConnection",
  )
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [EvidenceItem],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const NoteConnection = builder
  .objectRef<{ nodes: NoteRow[]; pageInfo: PageInfoShape }>("NoteConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [Note],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });
const TagConnection = builder
  .objectRef<{ nodes: TagRow[]; pageInfo: PageInfoShape }>("TagConnection")
  .implement({
    fields: (t) => ({
      nodes: t.expose("nodes", {
        type: [Tag],
        complexity: { field: 0, multiplier: 1 },
      }),
      pageInfo: t.expose("pageInfo", { type: PageInfo }),
    }),
  });

const CreateSourceInput = builder.inputType("CreateSourceInput", {
  fields: (t) => ({
    kind: t.string({ required: true }),
    title: t.string({ required: true }),
    publisher: t.string(),
    author: t.string(),
    canonicalUrl: t.string(),
    citation: t.string(),
    collectionMethod: t.string(),
    collectedAt: t.field({ type: "DateTime" }),
    reliability: t.float(),
    sensitivity: t.field({ type: Sensitivity }),
    metadata: t.field({ type: "JSON" }),
    contentHash: t.string(),
  }),
});
const UpdateSourceInput = builder.inputType("UpdateSourceInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    title: t.string(),
    publisher: t.string(),
    author: t.string(),
    canonicalUrl: t.string(),
    citation: t.string(),
    reliability: t.float(),
    sensitivity: t.field({ type: Sensitivity }),
    metadata: t.field({ type: "JSON" }),
  }),
});
const ArchiveSourceInput = builder.inputType("ArchiveSourceInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});
const CreateEvidenceItemInput = builder.inputType("CreateEvidenceItemInput", {
  fields: (t) => ({
    sourceId: t.field({ type: "UUID", required: true }),
    fileId: t.field({ type: "UUID" }),
    externalLocator: t.string(),
    extractedText: t.string(),
    capturedAt: t.field({ type: "DateTime" }),
    checksum: t.string({ required: true }),
    reviewState: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});
const UpdateEvidenceItemInput = builder.inputType("UpdateEvidenceItemInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    externalLocator: t.string(),
    extractedText: t.string(),
    capturedAt: t.field({ type: "DateTime" }),
    reviewState: t.string(),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});
const ArchiveEvidenceItemInput = builder.inputType("ArchiveEvidenceItemInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});
const AttachFileToEvidenceInput = builder.inputType(
  "AttachFileToEvidenceInput",
  {
    fields: (t) => ({
      evidenceItemId: t.field({ type: "UUID", required: true }),
      fileId: t.field({ type: "UUID", required: true }),
      expectedVersion: t.int({ required: true }),
    }),
  },
);
const CreateEvidenceExcerptInput = builder.inputType(
  "CreateEvidenceExcerptInput",
  {
    fields: (t) => ({
      evidenceItemId: t.field({ type: "UUID", required: true }),
      pageNumber: t.int(),
      startOffset: t.int(),
      endOffset: t.int(),
      startTimeMs: t.int(),
      endTimeMs: t.int(),
      locator: t.string(),
      excerpt: t.string({ required: true }),
      language: t.string(),
      checksum: t.string({ required: true }),
      redactionState: t.string(),
    }),
  },
);
const LinkFactEvidenceInput = builder.inputType("LinkFactEvidenceInput", {
  fields: (t) => ({
    factId: t.field({ type: "UUID", required: true }),
    evidenceItemId: t.field({ type: "UUID", required: true }),
    excerpt: t.string(),
    locator: t.string(),
    supportStrength: t.float(),
  }),
});
const UnlinkFactEvidenceInput = builder.inputType("UnlinkFactEvidenceInput", {
  fields: (t) => ({
    factId: t.field({ type: "UUID", required: true }),
    evidenceItemId: t.field({ type: "UUID", required: true }),
  }),
});
const LinkRelationshipEvidenceInput = builder.inputType(
  "LinkRelationshipEvidenceInput",
  {
    fields: (t) => ({
      relationshipId: t.field({ type: "UUID", required: true }),
      evidenceItemId: t.field({ type: "UUID", required: true }),
      locator: t.string(),
      supportStrength: t.float(),
    }),
  },
);
const UnlinkRelationshipEvidenceInput = builder.inputType(
  "UnlinkRelationshipEvidenceInput",
  {
    fields: (t) => ({
      relationshipId: t.field({ type: "UUID", required: true }),
      evidenceItemId: t.field({ type: "UUID", required: true }),
    }),
  },
);
const NoteSubjectInput = builder.inputType("NoteSubjectInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID" }),
    factId: t.field({ type: "UUID" }),
    relationshipId: t.field({ type: "UUID" }),
    evidenceItemId: t.field({ type: "UUID" }),
  }),
});
const NoteFilterInput = builder.inputType("NoteFilterInput", {
  fields: (t) => ({
    subject: t.field({ type: NoteSubjectInput }),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});
const TagFilterInput = builder.inputType("TagFilterInput", {
  fields: (t) => ({ normalizedNamePrefix: t.string() }),
});
const NoteContentInput = builder.inputType("NoteContentInput", {
  fields: (t) => ({ plainText: t.string(), markdown: t.string() }),
});
const CreateNoteInput = builder.inputType("CreateNoteInput", {
  fields: (t) => ({
    subject: t.field({ type: NoteSubjectInput }),
    content: t.field({ type: NoteContentInput, required: true }),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});
const UpdateNoteInput = builder.inputType("UpdateNoteInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    content: t.field({ type: NoteContentInput }),
    sensitivity: t.field({ type: Sensitivity }),
  }),
});
const ArchiveNoteInput = builder.inputType("ArchiveNoteInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});
const CreateTagInput = builder.inputType("CreateTagInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    color: t.string(),
    description: t.string(),
  }),
});
const UpdateTagInput = builder.inputType("UpdateTagInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
    name: t.string(),
    color: t.string(),
    description: t.string(),
  }),
});
const ArchiveTagInput = builder.inputType("ArchiveTagInput", {
  fields: (t) => ({
    id: t.field({ type: "UUID", required: true }),
    expectedVersion: t.int({ required: true }),
  }),
});
const TagPersonInput = builder.inputType("TagPersonInput", {
  fields: (t) => ({
    personId: t.field({ type: "UUID", required: true }),
    tagId: t.field({ type: "UUID", required: true }),
  }),
});
const TagFactInput = builder.inputType("TagFactInput", {
  fields: (t) => ({
    factId: t.field({ type: "UUID", required: true }),
    tagId: t.field({ type: "UUID", required: true }),
  }),
});
const TagRelationshipInput = builder.inputType("TagRelationshipInput", {
  fields: (t) => ({
    relationshipId: t.field({ type: "UUID", required: true }),
    tagId: t.field({ type: "UUID", required: true }),
  }),
});

type DynamicPayload = MutationOutcome<unknown> & Record<string, unknown>;
function payloadType(name: string, fieldName: string, objectType: never) {
  return builder.objectRef<DynamicPayload>(name).implement({
    fields: (t) =>
      ({
        [fieldName]: t.field({
          type: objectType,
          nullable: true,
          resolve: (row) => row[fieldName] as never,
        }),
        issues: t.field({
          type: [ValidationIssue],
          resolve: (row) => row.issues,
        }),
        code: t.string({ nullable: true, resolve: (row) => row.code }),
        currentVersion: t.int({
          nullable: true,
          resolve: (row) => row.currentVersion,
        }),
      }) as never,
  });
}

const SourcePayload = payloadType("SourcePayload", "source", Source as never);
const EvidenceItemPayload = payloadType(
  "EvidenceItemPayload",
  "evidenceItem",
  EvidenceItem as never,
);
const EvidenceExcerptPayload = payloadType(
  "EvidenceExcerptPayload",
  "evidenceExcerpt",
  EvidenceExcerpt as never,
);
const FactEvidencePayload = payloadType(
  "FactEvidencePayload",
  "factEvidence",
  FactEvidence as never,
);
const RelationshipEvidencePayload = payloadType(
  "RelationshipEvidencePayload",
  "relationshipEvidence",
  RelationshipEvidence as never,
);
const NotePayload = payloadType("NotePayload", "note", Note as never);
const TagPayload = payloadType("TagPayload", "tag", Tag as never);

const PersonTag = builder.objectRef<PersonTagRow>("PersonTag").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    personId: t.expose("personId", { type: "UUID" }),
    tagId: t.expose("tagId", { type: "UUID" }),
  }),
});
const FactTag = builder.objectRef<FactTagRow>("FactTag").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    factId: t.expose("factId", { type: "UUID" }),
    tagId: t.expose("tagId", { type: "UUID" }),
  }),
});
const RelationshipTag = builder
  .objectRef<RelationshipTagRow>("RelationshipTag")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      relationshipId: t.expose("relationshipId", { type: "UUID" }),
      tagId: t.expose("tagId", { type: "UUID" }),
    }),
  });
const PersonTagPayload = payloadType(
  "PersonTagPayload",
  "personTag",
  PersonTag as never,
);
const FactTagPayload = payloadType(
  "FactTagPayload",
  "factTag",
  FactTag as never,
);
const RelationshipTagPayload = payloadType(
  "RelationshipTagPayload",
  "relationshipTag",
  RelationshipTag as never,
);

function withResource<T>(result: MutationOutcome<T>, name: string) {
  return { ...result, [name]: result.resource };
}

export function registerEvidenceGraphQL(): void {
  builder.objectFields(Person, (t) => ({
    notes: t.field({
      type: NoteConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (person, args, context) => {
        requirePermission(context, "note", "read");
        normalizePagination(args);
        return context.loaders.notesBySubject.load({
          kind: "person",
          subjectId: person.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
    tags: t.field({
      type: TagConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 1, multiplier: multiplier(args.first) }),
      resolve: (person, args, context) => {
        requirePermission(context, "tag", "read");
        normalizePagination(args);
        return context.loaders.tagsBySubject.load({
          kind: "person",
          subjectId: person.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
  }));
  builder.objectFields(Fact, (t) => ({
    evidence: t.field({
      type: FactEvidenceConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (fact, args, context) => {
        requirePermission(context, "evidence", "read");
        normalizePagination(args);
        return context.loaders.factEvidence.load({
          factId: fact.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
    notes: t.field({
      type: NoteConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (fact, args, context) => {
        requirePermission(context, "note", "read");
        normalizePagination(args);
        return context.loaders.notesBySubject.load({
          kind: "fact",
          subjectId: fact.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
    tags: t.field({
      type: TagConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 1, multiplier: multiplier(args.first) }),
      resolve: (fact, args, context) => {
        requirePermission(context, "tag", "read");
        normalizePagination(args);
        return context.loaders.tagsBySubject.load({
          kind: "fact",
          subjectId: fact.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
  }));
  builder.objectFields(Relationship, (t) => ({
    evidence: t.field({
      type: RelationshipEvidenceConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (relationship, args, context) => {
        requirePermission(context, "evidence", "read");
        normalizePagination(args);
        return context.loaders.relationshipEvidence.load({
          relationshipId: relationship.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
    notes: t.field({
      type: NoteConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (relationship, args, context) => {
        requirePermission(context, "note", "read");
        normalizePagination(args);
        return context.loaders.notesBySubject.load({
          kind: "relationship",
          subjectId: relationship.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
    tags: t.field({
      type: TagConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 1, multiplier: multiplier(args.first) }),
      resolve: (relationship, args, context) => {
        requirePermission(context, "tag", "read");
        normalizePagination(args);
        return context.loaders.tagsBySubject.load({
          kind: "relationship",
          subjectId: relationship.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
  }));
  builder.objectFields(EvidenceItem, (t) => ({
    notes: t.field({
      type: NoteConnection,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (evidence, args, context) => {
        requirePermission(context, "note", "read");
        normalizePagination(args);
        return context.loaders.notesBySubject.load({
          kind: "evidence",
          subjectId: evidence.id,
          first: args.first ?? 25,
          after: args.after ?? null,
        });
      },
    }),
  }));
  builder.queryFields((t) => ({
    sources: t.field({
      type: SourceConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        filter: t.arg({ type: SourceFilterInput }),
      },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (_r, args, context) => {
        requirePermission(context, "source", "read");
        return context.services.evidence.listSources({
          first: args.first,
          after: args.after,
          kind: args.filter?.kind,
          sensitivity: args.filter?.sensitivity,
        });
      },
    }),
    source: t.field({
      type: Source,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, args, context) => {
        requirePermission(context, "source", "read");
        return context.loaders.source.load(args.id);
      },
    }),
    evidenceItems: t.field({
      type: EvidenceItemConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        sourceId: t.arg({ type: "UUID" }),
        filter: t.arg({ type: EvidenceFilterInput }),
      },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (_r, args, context) => {
        requirePermission(context, "evidence", "read");
        return context.services.evidence.listEvidence({
          first: args.first,
          after: args.after,
          sourceId: args.filter?.sourceId ?? args.sourceId,
          reviewState: args.filter?.reviewState,
          sensitivity: args.filter?.sensitivity,
        });
      },
    }),
    evidenceItem: t.field({
      type: EvidenceItem,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, args, context) => {
        requirePermission(context, "evidence", "read");
        return context.loaders.evidenceItem.load(args.id);
      },
    }),
    notes: t.field({
      type: NoteConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        personId: t.arg({ type: "UUID" }),
        factId: t.arg({ type: "UUID" }),
        relationshipId: t.arg({ type: "UUID" }),
        evidenceItemId: t.arg({ type: "UUID" }),
        filter: t.arg({ type: NoteFilterInput }),
      },
      complexity: (args) => ({ field: 2, multiplier: multiplier(args.first) }),
      resolve: (_r, args, context) => {
        requirePermission(context, "note", "read");
        const subject = args.filter?.subject;
        for (const kind of [
          "person",
          "fact",
          "relationship",
          "evidence",
        ] as const) {
          const id =
            kind === "evidence"
              ? (subject?.evidenceItemId ?? args.evidenceItemId)
              : (subject?.[`${kind}Id` as keyof typeof subject] ??
                args[`${kind}Id` as keyof typeof args]);
          if (id) requirePermission(context, kind, "read");
        }
        return context.services.evidence.listNotes({
          first: args.first,
          after: args.after,
          personId: args.filter?.subject?.personId ?? args.personId,
          factId: args.filter?.subject?.factId ?? args.factId,
          relationshipId:
            args.filter?.subject?.relationshipId ?? args.relationshipId,
          evidenceItemId:
            args.filter?.subject?.evidenceItemId ?? args.evidenceItemId,
          sensitivity: args.filter?.sensitivity,
        });
      },
    }),
    note: t.field({
      type: Note,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, args, context) => {
        requirePermission(context, "note", "read");
        return context.services.evidence.getNote(args.id);
      },
    }),
    tags: t.field({
      type: TagConnection,
      args: {
        first: t.arg.int(),
        after: t.arg.string(),
        filter: t.arg({ type: TagFilterInput }),
      },
      complexity: (args) => ({ field: 1, multiplier: multiplier(args.first) }),
      resolve: (_r, args, context) => {
        requirePermission(context, "tag", "read");
        return context.services.evidence.listTags({
          first: args.first,
          after: args.after,
          normalizedNamePrefix: args.filter?.normalizedNamePrefix,
        });
      },
    }),
    tag: t.field({
      type: Tag,
      nullable: true,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, args, context) => {
        requirePermission(context, "tag", "read");
        return context.loaders.tag.load(args.id);
      },
    }),
  }));
  builder.mutationFields((t) => ({
    createSource: t.field({
      type: SourcePayload,
      args: { input: t.arg({ type: CreateSourceInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "source", "create");
        const result = await context.services.evidence.createSource(args.input);
        if (result.resource)
          context.loaders.source.prime(result.resource.id, result.resource);
        return withResource(result, "source");
      },
    }),
    updateSource: t.field({
      type: SourcePayload,
      args: { input: t.arg({ type: UpdateSourceInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "source", "update");
        const result = await context.services.evidence.updateSource(args.input);
        if (result.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "source",
            id: result.resource.id,
          });
        return withResource(result, "source");
      },
    }),
    archiveSource: t.field({
      type: SourcePayload,
      args: { input: t.arg({ type: ArchiveSourceInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "source", "delete");
        const result = await context.services.evidence.archiveSource(
          args.input,
        );
        if (result.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "source",
            id: result.resource.id,
          });
        return withResource(result, "source");
      },
    }),
    createEvidenceItem: t.field({
      type: EvidenceItemPayload,
      args: { input: t.arg({ type: CreateEvidenceItemInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "evidence", "create");
        requirePermission(context, "source", "read");
        if (args.input.fileId) requirePermission(context, "file", "read");
        const result = await context.services.evidence.createEvidence(
          args.input,
        );
        if (result.resource)
          context.loaders.evidenceItem.prime(
            result.resource.id,
            result.resource,
          );
        return withResource(result, "evidenceItem");
      },
    }),
    updateEvidenceItem: t.field({
      type: EvidenceItemPayload,
      args: { input: t.arg({ type: UpdateEvidenceItemInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "evidence", "update");
        const result = await context.services.evidence.updateEvidence(
          args.input,
        );
        if (result.resource) {
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "evidence",
            id: result.resource.id,
          });
        }
        return withResource(result, "evidenceItem");
      },
    }),
    archiveEvidenceItem: t.field({
      type: EvidenceItemPayload,
      args: {
        input: t.arg({ type: ArchiveEvidenceItemInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "evidence", "delete");
        const result = await context.services.evidence.archiveEvidence(
          args.input,
        );
        if (result.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "evidence",
            id: result.resource.id,
          });
        return withResource(result, "evidenceItem");
      },
    }),
    attachFileToEvidence: t.field({
      type: EvidenceItemPayload,
      args: {
        input: t.arg({ type: AttachFileToEvidenceInput, required: true }),
      },
      resolve: async (_root, args, context) => {
        requirePermission(context, "file", "read");
        requirePermission(context, "evidence", "update");
        requirePermission(context, "source", "read");
        const result = await context.services.evidence.attachFile(args.input);
        if (result.resource) {
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "evidence",
            id: result.resource.id,
          });
        }
        return withResource(result, "evidenceItem");
      },
    }),
    createEvidenceExcerpt: t.field({
      type: EvidenceExcerptPayload,
      args: {
        input: t.arg({ type: CreateEvidenceExcerptInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "evidence", "update");
        const result = await context.services.evidence.createExcerpt(
          args.input,
        );
        if (result.resource) context.loaders.evidenceExcerpts.clearAll();
        return withResource(result, "evidenceExcerpt");
      },
    }),
    linkFactEvidence: t.field({
      type: FactEvidencePayload,
      args: { input: t.arg({ type: LinkFactEvidenceInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "update");
        requirePermission(context, "evidence", "read");
        const result = await context.services.evidence.linkFact(args.input);
        if (result.resource) context.loaders.factEvidence.clearAll();
        return withResource(result, "factEvidence");
      },
    }),
    unlinkFactEvidence: t.field({
      type: FactEvidencePayload,
      args: { input: t.arg({ type: UnlinkFactEvidenceInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "fact", "update");
        const result = await context.services.evidence.unlinkFact(args.input);
        if (result.resource) context.loaders.factEvidence.clearAll();
        return withResource(result, "factEvidence");
      },
    }),
    linkRelationshipEvidence: t.field({
      type: RelationshipEvidencePayload,
      args: {
        input: t.arg({ type: LinkRelationshipEvidenceInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "relationship", "update");
        requirePermission(context, "evidence", "read");
        const result = await context.services.evidence.linkRelationship(
          args.input,
        );
        if (result.resource) context.loaders.relationshipEvidence.clearAll();
        return withResource(result, "relationshipEvidence");
      },
    }),
    unlinkRelationshipEvidence: t.field({
      type: RelationshipEvidencePayload,
      args: {
        input: t.arg({ type: UnlinkRelationshipEvidenceInput, required: true }),
      },
      resolve: async (_r, args, context) => {
        requirePermission(context, "relationship", "update");
        const result = await context.services.evidence.unlinkRelationship(
          args.input,
        );
        if (result.resource) context.loaders.relationshipEvidence.clearAll();
        return withResource(result, "relationshipEvidence");
      },
    }),
    createNote: t.field({
      type: NotePayload,
      args: { input: t.arg({ type: CreateNoteInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "note", "create");
        for (const kind of [
          "person",
          "fact",
          "relationship",
          "evidence",
        ] as const) {
          const id =
            kind === "evidence"
              ? args.input.subject?.evidenceItemId
              : args.input.subject?.[
                  `${kind}Id` as keyof NonNullable<typeof args.input.subject>
                ];
          if (id) {
            requirePermission(context, kind, "read");
          }
        }
        const result = await context.services.evidence.createNote(args.input);
        if (result.resource) context.loaders.notesBySubject.clearAll();
        return withResource(result, "note");
      },
    }),
    updateNote: t.field({
      type: NotePayload,
      args: { input: t.arg({ type: UpdateNoteInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "note", "update");
        const result = await context.services.evidence.updateNote(args.input);
        if (result.resource) context.loaders.notesBySubject.clearAll();
        return withResource(result, "note");
      },
    }),
    archiveNote: t.field({
      type: NotePayload,
      args: { input: t.arg({ type: ArchiveNoteInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "note", "delete");
        const result = await context.services.evidence.archiveNote(args.input);
        if (result.resource) context.loaders.notesBySubject.clearAll();
        return withResource(result, "note");
      },
    }),
    createTag: t.field({
      type: TagPayload,
      args: { input: t.arg({ type: CreateTagInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "create");
        const result = await context.services.evidence.createTag(args.input);
        if (result.resource)
          context.loaders.tag.prime(result.resource.id, result.resource);
        return withResource(result, "tag");
      },
    }),
    updateTag: t.field({
      type: TagPayload,
      args: { input: t.arg({ type: UpdateTagInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "update");
        const result = await context.services.evidence.updateTag(args.input);
        if (result.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "tag",
            id: result.resource.id,
          });
        return withResource(result, "tag");
      },
    }),
    archiveTag: t.field({
      type: TagPayload,
      args: { input: t.arg({ type: ArchiveTagInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "delete");
        const result = await context.services.evidence.archiveTag(args.input);
        if (result.resource)
          invalidateVisibilityDependentLoaders(context.loaders, {
            kind: "tag",
            id: result.resource.id,
          });
        return withResource(result, "tag");
      },
    }),
    tagPerson: t.field({
      type: PersonTagPayload,
      args: { input: t.arg({ type: TagPersonInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "update");
        requirePermission(context, "person", "update");
        const result = await context.services.evidence.tagPerson(args.input);
        if (result.resource) context.loaders.tagsBySubject.clearAll();
        return withResource(result, "personTag");
      },
    }),
    untagPerson: t.field({
      type: PersonTagPayload,
      args: { input: t.arg({ type: TagPersonInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "update");
        requirePermission(context, "person", "update");
        const result = await context.services.evidence.untagPerson(args.input);
        if (result.resource) context.loaders.tagsBySubject.clearAll();
        return withResource(result, "personTag");
      },
    }),
    tagFact: t.field({
      type: FactTagPayload,
      args: { input: t.arg({ type: TagFactInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "update");
        requirePermission(context, "fact", "update");
        const result = await context.services.evidence.tagFact(args.input);
        if (result.resource) context.loaders.tagsBySubject.clearAll();
        return withResource(result, "factTag");
      },
    }),
    untagFact: t.field({
      type: FactTagPayload,
      args: { input: t.arg({ type: TagFactInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "update");
        requirePermission(context, "fact", "update");
        const result = await context.services.evidence.untagFact(args.input);
        if (result.resource) context.loaders.tagsBySubject.clearAll();
        return withResource(result, "factTag");
      },
    }),
    tagRelationship: t.field({
      type: RelationshipTagPayload,
      args: { input: t.arg({ type: TagRelationshipInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "update");
        requirePermission(context, "relationship", "update");
        const result = await context.services.evidence.tagRelationship(
          args.input,
        );
        if (result.resource) context.loaders.tagsBySubject.clearAll();
        return withResource(result, "relationshipTag");
      },
    }),
    untagRelationship: t.field({
      type: RelationshipTagPayload,
      args: { input: t.arg({ type: TagRelationshipInput, required: true }) },
      resolve: async (_r, args, context) => {
        requirePermission(context, "tag", "update");
        requirePermission(context, "relationship", "update");
        const result = await context.services.evidence.untagRelationship(
          args.input,
        );
        if (result.resource) context.loaders.tagsBySubject.clearAll();
        return withResource(result, "relationshipTag");
      },
    }),
  }));
}
