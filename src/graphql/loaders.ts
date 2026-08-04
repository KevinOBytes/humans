import DataLoader from "dataloader";

import type { PersonRow } from "@/modules/people/repository";
import type { PeopleService } from "@/modules/people/service";
import type {
  FactDefinitionRow,
  FactRelationshipRow,
  FactRevisionRow,
  FactRow,
  PersonFieldSelectionRow,
} from "@/modules/facts/repository";
import type { FactsService } from "@/modules/facts/service";
import type { Connection } from "@/modules/people/service";
import type {
  RelationshipRow,
  RelationshipTypeRow,
} from "@/modules/relationships/repository";
import type { RelationshipsService } from "@/modules/relationships/service";
import type {
  EvidenceExcerptRow,
  EvidenceItemRow,
  FactEvidenceRow,
  NoteRow,
  RelationshipEvidenceRow,
  SourceRow,
  TagRow,
} from "@/modules/evidence/repository";
import type { EvidenceService } from "@/modules/evidence/service";
import type { AuditQueryService } from "@/modules/audit/service";
import type { ActorAttribution } from "@/modules/audit/service";
import type { GraphService } from "@/modules/graph/service";
import type { FileRow } from "@/modules/files/repository";
import type { FilesService } from "@/modules/files/service";
import type { ImportMappingRow, ImportRow } from "@/modules/imports/repository";
import type { ImportsService } from "@/modules/imports/service";
import type { SearchService } from "@/modules/search/service";
import type { SettingsService } from "@/modules/settings/service";
import type { LocationsService } from "@/modules/locations/service";
import type { createAiAnalysisService } from "@/modules/ai/service";

export type SafeWorkspace = {
  id: string;
  name: string;
  organizationId: string;
};

export type GraphQLServices = {
  loadWorkspaces(
    ids: readonly string[],
  ): Promise<readonly (SafeWorkspace | null)[]>;
  people: PeopleService;
  facts: FactsService;
  relationships: RelationshipsService;
  evidence: EvidenceService;
  audit: AuditQueryService;
  graph: GraphService;
  files: FilesService;
  imports: ImportsService;
  search: SearchService;
  settings: SettingsService;
  locations: LocationsService;
  ai: ReturnType<typeof createAiAnalysisService>;
};

export type GraphQLLoaders = {
  person: DataLoader<string, PersonRow | null>;
  fact: DataLoader<string, FactRow | null>;
  factDefinition: DataLoader<string, FactDefinitionRow | null>;
  factsByPerson: DataLoader<
    { personId: string; first: number; after: string | null },
    Connection<FactRow>,
    string
  >;
  fieldSelectionsByPerson: DataLoader<
    { personId: string; first: number; after: string | null },
    Connection<PersonFieldSelectionRow>,
    string
  >;
  factRevisions: DataLoader<
    { factId: string; first: number; after: string | null },
    Connection<FactRevisionRow>,
    string
  >;
  factRelationships: DataLoader<
    { factId: string; first: number; after: string | null },
    Connection<FactRelationshipRow>,
    string
  >;
  revisionSnapshot: DataLoader<
    { revisionId: string; side: "before" | "after"; snapshot: unknown },
    Record<string, unknown> | null,
    string
  >;
  relationship: DataLoader<string, RelationshipRow | null>;
  relationshipType: DataLoader<string, RelationshipTypeRow | null>;
  relationshipsByPerson: DataLoader<
    { personId: string; first: number; after: string | null },
    Connection<RelationshipRow>,
    string
  >;
  source: DataLoader<string, SourceRow | null>;
  evidenceItem: DataLoader<string, EvidenceItemRow | null>;
  evidenceExcerpts: DataLoader<
    { evidenceItemId: string; first: number; after: string | null },
    Connection<EvidenceExcerptRow>,
    string
  >;
  factEvidence: DataLoader<
    { factId: string; first: number; after: string | null },
    Connection<FactEvidenceRow>,
    string
  >;
  relationshipEvidence: DataLoader<
    { relationshipId: string; first: number; after: string | null },
    Connection<RelationshipEvidenceRow>,
    string
  >;
  notesBySubject: DataLoader<
    {
      kind: "person" | "fact" | "relationship" | "evidence";
      subjectId: string;
      first: number;
      after: string | null;
    },
    Connection<NoteRow>,
    string
  >;
  tagsBySubject: DataLoader<
    {
      kind: "person" | "fact" | "relationship";
      subjectId: string;
      first: number;
      after: string | null;
    },
    Connection<TagRow>,
    string
  >;
  tag: DataLoader<string, TagRow | null>;
  workspace: DataLoader<string, SafeWorkspace | null>;
  actorAttribution: DataLoader<string, ActorAttribution>;
  file: DataLoader<string, FileRow | null>;
  import: DataLoader<string, ImportRow | null>;
  importMapping: DataLoader<string, ImportMappingRow | null>;
};

export type VisibilityDependentParent = {
  id: string;
  kind: "person" | "fact" | "relationship" | "evidence" | "source" | "tag";
};

/**
 * Mutation payloads resolve inside the same GraphQL request as pages that may
 * already have been loaded. Clear every request-scoped page whose membership
 * depends on the changed parent's lifecycle or visibility before resolving the
 * payload. Pagination keys cannot be enumerated safely, so dependent connection
 * loaders are cleared as a group while entity loaders remain ID-scoped.
 */
export function invalidateVisibilityDependentLoaders(
  loaders: GraphQLLoaders,
  parent: VisibilityDependentParent,
): void {
  switch (parent.kind) {
    case "person":
      loaders.person.clear(parent.id);
      // Facts and relationships can become unreadable with their owning person
      // or either relationship endpoint.
      loaders.fact.clearAll();
      loaders.relationship.clearAll();
      loaders.factsByPerson.clearAll();
      loaders.fieldSelectionsByPerson.clearAll();
      loaders.factRevisions.clearAll();
      loaders.factRelationships.clearAll();
      loaders.revisionSnapshot.clearAll();
      loaders.relationshipsByPerson.clearAll();
      loaders.factEvidence.clearAll();
      loaders.relationshipEvidence.clearAll();
      loaders.notesBySubject.clearAll();
      loaders.tagsBySubject.clearAll();
      return;
    case "fact":
      loaders.fact.clear(parent.id);
      loaders.factsByPerson.clearAll();
      loaders.fieldSelectionsByPerson.clearAll();
      loaders.factRevisions.clearAll();
      loaders.factRelationships.clearAll();
      loaders.revisionSnapshot.clearAll();
      loaders.factEvidence.clearAll();
      loaders.notesBySubject.clearAll();
      loaders.tagsBySubject.clearAll();
      return;
    case "relationship":
      loaders.relationship.clear(parent.id);
      loaders.relationshipsByPerson.clearAll();
      loaders.relationshipEvidence.clearAll();
      loaders.notesBySubject.clearAll();
      loaders.tagsBySubject.clearAll();
      return;
    case "evidence":
      loaders.evidenceItem.clear(parent.id);
      loaders.evidenceExcerpts.clearAll();
      loaders.factEvidence.clearAll();
      loaders.relationshipEvidence.clearAll();
      loaders.notesBySubject.clearAll();
      return;
    case "source":
      loaders.source.clear(parent.id);
      return;
    case "tag":
      loaders.tag.clear(parent.id);
      loaders.tagsBySubject.clearAll();
  }
}

export function createLoaders(input: {
  services: GraphQLServices;
  workspaceId: string;
}): GraphQLLoaders {
  const { services, workspaceId } = input;
  return {
    actorAttribution: new DataLoader(
      (keys) => services.audit.resolveAttributions(keys),
      { maxBatchSize: 100 },
    ),
    fact: new DataLoader<string, FactRow | null>(
      (ids) => services.facts.getByIds(ids),
      { maxBatchSize: 100 },
    ),
    file: new DataLoader<string, FileRow | null>(
      (ids) => services.files.getByIds(ids),
      { maxBatchSize: 100 },
    ),
    import: new DataLoader<string, ImportRow | null>(
      (ids) => services.imports.getByIds(ids),
      { maxBatchSize: 100 },
    ),
    importMapping: new DataLoader<string, ImportMappingRow | null>(
      (ids) => services.imports.getMappingsByIds(ids),
      { maxBatchSize: 100 },
    ),
    factDefinition: new DataLoader<string, FactDefinitionRow | null>(
      (ids) => services.facts.getDefinitionsByIds(ids),
      { maxBatchSize: 100 },
    ),
    factsByPerson: new DataLoader(
      async (keys) => services.facts.listForPeople(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) =>
          JSON.stringify([key.personId, key.first, key.after]),
      },
    ),
    fieldSelectionsByPerson: new DataLoader(
      (keys) => services.facts.listSelectionsForPeople(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) =>
          JSON.stringify([key.personId, key.first, key.after]),
      },
    ),
    factRevisions: new DataLoader(
      (keys) => services.facts.listRevisionsForFacts(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) => JSON.stringify([key.factId, key.first, key.after]),
      },
    ),
    factRelationships: new DataLoader(
      (keys) => services.facts.listRelationshipsForFacts(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) => JSON.stringify([key.factId, key.first, key.after]),
      },
    ),
    revisionSnapshot: new DataLoader(
      (keys) =>
        services.facts.redactRevisionSnapshots(keys.map((key) => key.snapshot)),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) => JSON.stringify([key.revisionId, key.side]),
      },
    ),
    relationship: new DataLoader(
      (ids) => services.relationships.getByIds(ids),
      { maxBatchSize: 100 },
    ),
    relationshipType: new DataLoader(
      (ids) => services.relationships.getTypesByIds(ids),
      { maxBatchSize: 100 },
    ),
    relationshipsByPerson: new DataLoader(
      async (keys) => services.relationships.listForPeople(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) =>
          JSON.stringify([key.personId, key.first, key.after]),
      },
    ),
    source: new DataLoader((ids) => services.evidence.getSourcesByIds(ids), {
      maxBatchSize: 100,
    }),
    evidenceItem: new DataLoader(
      (ids) => services.evidence.getEvidenceByIds(ids),
      { maxBatchSize: 100 },
    ),
    evidenceExcerpts: new DataLoader(
      (keys) => services.evidence.listExcerptsForEvidenceItems(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) =>
          JSON.stringify([key.evidenceItemId, key.first, key.after]),
      },
    ),
    factEvidence: new DataLoader(
      (keys) => services.evidence.listFactEvidenceForFacts(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) => JSON.stringify([key.factId, key.first, key.after]),
      },
    ),
    relationshipEvidence: new DataLoader(
      (keys) =>
        services.evidence.listRelationshipEvidenceForRelationships(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) =>
          JSON.stringify([key.relationshipId, key.first, key.after]),
      },
    ),
    notesBySubject: new DataLoader(
      (keys) => services.evidence.listNotesForSubjects(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) =>
          JSON.stringify([key.kind, key.subjectId, key.first, key.after]),
      },
    ),
    tagsBySubject: new DataLoader(
      (keys) => services.evidence.listTagsForSubjects(keys),
      {
        maxBatchSize: 100,
        cacheKeyFn: (key) =>
          JSON.stringify([key.kind, key.subjectId, key.first, key.after]),
      },
    ),
    tag: new DataLoader((ids) => services.evidence.getTagsByIds(ids), {
      maxBatchSize: 100,
    }),
    person: new DataLoader<string, PersonRow | null>(
      async (ids) => services.people.getByIds(ids),
      { maxBatchSize: 100 },
    ),
    workspace: new DataLoader<string, SafeWorkspace | null>(
      async (ids) => {
        const scopedIds = ids.map((id) => (id === workspaceId ? id : ""));
        const loaded = await services.loadWorkspaces(scopedIds);
        return ids.map((id, index) =>
          id === workspaceId ? (loaded[index] ?? null) : null,
        );
      },
      { maxBatchSize: 100 },
    ),
  };
}
