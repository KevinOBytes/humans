import "server-only";

import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { newId } from "@/db/id";
import {
  evidenceExcerpts,
  evidenceItems,
  notes,
  personAddresses,
  sources,
} from "@/db/schema/evidence";
import { factDefinitions, facts } from "@/db/schema/facts";
import { addresses } from "@/db/schema/locations";
import { people, personNames } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import { searchDocuments } from "@/db/schema/search";
import type { Database } from "@/modules/auth/bootstrap-admin";

import {
  SEARCH_INDEX_SOURCE_KINDS,
  type SearchIndexMaintenance,
  type SearchIndexMutation,
} from "./index-maintenance";
import type { Task12Metrics } from "./metrics";
import { foldSearchDiacritics } from "./normalization";

type Sensitivity = "public" | "internal" | "confidential" | "restricted";
type Contribution = {
  bodyText: string;
  displayText: string;
  redactedText: string;
  resultId: string;
  resultKind: "PERSON" | "FACT" | "ADDRESS" | "RELATIONSHIP" | "EVIDENCE";
  sensitivity: Sensitivity;
  subjectPersonId: string | null;
  updatedAt: Date;
};

const MAX_CONTRIBUTIONS = 64;
const indexedRelationshipSource = alias(people, "indexed_relationship_source");
const indexedRelationshipTarget = alias(people, "indexed_relationship_target");

function latestTimestamp(...values: Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

function boundedText(value: string | null | undefined, maxBytes: number) {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  let result = "";
  for (const character of normalized) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function safeTypedFactValue(input: {
  valueBoolean: boolean | null;
  valueDateEnd: string | null;
  valueDateStart: string | null;
  valueDecimal: string | null;
  valueTimestamp: Date | null;
  valueType: string;
}): string {
  switch (input.valueType) {
    case "boolean":
      return input.valueBoolean == null ? "" : String(input.valueBoolean);
    case "date":
      return input.valueDateStart ?? "";
    case "date_range":
      return input.valueDateStart && input.valueDateEnd
        ? `${input.valueDateStart} ${input.valueDateEnd}`
        : "";
    case "timestamp":
      return input.valueTimestamp?.toISOString() ?? "";
    case "duration":
    case "quantity":
      // Units are user-controlled free text, so only the typed numeric payload
      // is eligible for full-text indexing.
      return input.valueDecimal ?? "";
    default:
      // Free-form text/rich-text/URI and raw integer/decimal values are not an
      // independently safe content class. Their definition label remains
      // searchable, but their value can never enter a search document.
      return "";
  }
}

function contribution(
  input: Omit<Contribution, "bodyText" | "displayText" | "redactedText"> & {
    bodyText?: string | null;
    displayText: string;
    redactedText: string;
  },
): Contribution | null {
  const redactedText = foldSearchDiacritics(
    boundedText(input.redactedText, 512),
  );
  const displayText = boundedText(input.displayText, 8_192);
  if (!redactedText || !displayText) return null;
  return {
    ...input,
    bodyText: foldSearchDiacritics(boundedText(input.bodyText, 8_192)),
    displayText,
    redactedText,
  };
}

function addressLocality(input: {
  countryCode: string | null;
  locality: string | null;
  postalCode: string | null;
  region: string | null;
}): string {
  return [input.locality, input.region, input.postalCode, input.countryCode]
    .map((value) => boundedText(value, 512))
    .filter(Boolean)
    .join(", ");
}

const sensitivityRank = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
} as const;

function strictestSensitivity(...values: Sensitivity[]): Sensitivity {
  return values.reduce((strictest, value) =>
    sensitivityRank[value] > sensitivityRank[strictest] ? value : strictest,
  );
}

async function loadContributions(
  database: Database,
  mutation: SearchIndexMutation,
): Promise<Contribution[]> {
  const common = and(
    eq(people.workspaceId, mutation.workspaceId),
    isNull(people.deletedAt),
  );
  switch (mutation.sourceKind) {
    case "person": {
      const [row] = await database
        .select({
          id: people.id,
          displayName: people.displayName,
          sensitivity: people.sensitivity,
          updatedAt: people.updatedAt,
        })
        .from(people)
        .where(
          and(
            common,
            eq(people.id, mutation.sourceId),
            eq(people.version, mutation.sourceVersion),
          ),
        )
        .limit(1);
      const item = row
        ? contribution({
            redactedText: row.displayName,
            displayText: row.displayName,
            resultKind: "PERSON",
            resultId: row.id,
            subjectPersonId: row.id,
            sensitivity: row.sensitivity,
            updatedAt: row.updatedAt,
          })
        : null;
      return item ? [item] : [];
    }
    case "person_name": {
      const [row] = await database
        .select({
          id: personNames.id,
          personId: personNames.personId,
          fullName: personNames.fullName,
          sensitivity: personNames.sensitivity,
          updatedAt: personNames.updatedAt,
        })
        .from(personNames)
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, personNames.workspaceId),
            eq(people.id, personNames.personId),
            isNull(people.deletedAt),
          ),
        )
        .where(
          and(
            eq(personNames.workspaceId, mutation.workspaceId),
            eq(personNames.id, mutation.sourceId),
            eq(personNames.version, mutation.sourceVersion),
            isNull(personNames.deletedAt),
          ),
        )
        .limit(1);
      const item = row
        ? contribution({
            redactedText: row.fullName,
            displayText: row.fullName,
            resultKind: "PERSON",
            resultId: row.personId,
            subjectPersonId: row.personId,
            sensitivity: row.sensitivity,
            updatedAt: row.updatedAt,
          })
        : null;
      return item ? [item] : [];
    }
    case "fact": {
      const [row] = await database
        .select({
          id: facts.id,
          personId: facts.personId,
          label: factDefinitions.label,
          valueBoolean: facts.valueBoolean,
          valueDateEnd: facts.valueDateEnd,
          valueDateStart: facts.valueDateStart,
          valueDecimal: facts.valueDecimal,
          valueTimestamp: facts.valueTimestamp,
          valueType: facts.valueType,
          sensitivity: facts.sensitivity,
          searchable: factDefinitions.searchable,
          definitionState: factDefinitions.state,
          definitionUpdatedAt: factDefinitions.updatedAt,
          updatedAt: facts.updatedAt,
        })
        .from(facts)
        .innerJoin(
          factDefinitions,
          and(
            eq(factDefinitions.workspaceId, facts.workspaceId),
            eq(factDefinitions.id, facts.factDefinitionId),
            isNull(factDefinitions.deletedAt),
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, facts.workspaceId),
            eq(people.id, facts.personId),
            isNull(people.deletedAt),
          ),
        )
        .where(
          and(
            eq(facts.workspaceId, mutation.workspaceId),
            eq(facts.id, mutation.sourceId),
            eq(facts.version, mutation.sourceVersion),
            isNull(facts.deletedAt),
          ),
        )
        .limit(1);
      if (!row?.searchable || row.definitionState !== "active") return [];
      const value = safeTypedFactValue(row);
      const item = contribution({
        redactedText: row.label,
        bodyText: value,
        displayText: value ? `${row.label}: ${value}` : row.label,
        resultKind: "FACT",
        resultId: row.id,
        subjectPersonId: row.personId,
        sensitivity: row.sensitivity,
        updatedAt: latestTimestamp(row.updatedAt, row.definitionUpdatedAt),
      });
      return item ? [item] : [];
    }
    case "fact_definition": {
      // Definitions contain no independently authorized result target. Their
      // maintenance event removes any legacy definition-sourced fan-out;
      // canonical fact sources are refreshed by bounded transactional fan-out.
      return [];
    }
    case "relationship": {
      const [row] = await database
        .select({
          id: relationships.id,
          sourcePersonId: relationships.sourcePersonId,
          label: relationships.labelOverride,
          forwardLabel: relationshipTypes.forwardLabel,
          sensitivity: relationships.sensitivity,
          typeUpdatedAt: relationshipTypes.updatedAt,
          updatedAt: relationships.updatedAt,
        })
        .from(relationships)
        .innerJoin(
          relationshipTypes,
          and(
            eq(relationshipTypes.workspaceId, relationships.workspaceId),
            eq(relationshipTypes.id, relationships.relationshipTypeId),
            isNull(relationshipTypes.deletedAt),
          ),
        )
        .innerJoin(
          indexedRelationshipSource,
          and(
            eq(
              indexedRelationshipSource.workspaceId,
              relationships.workspaceId,
            ),
            eq(indexedRelationshipSource.id, relationships.sourcePersonId),
            isNull(indexedRelationshipSource.deletedAt),
          ),
        )
        .innerJoin(
          indexedRelationshipTarget,
          and(
            eq(
              indexedRelationshipTarget.workspaceId,
              relationships.workspaceId,
            ),
            eq(indexedRelationshipTarget.id, relationships.targetPersonId),
            isNull(indexedRelationshipTarget.deletedAt),
          ),
        )
        .where(
          and(
            eq(relationships.workspaceId, mutation.workspaceId),
            eq(relationships.id, mutation.sourceId),
            eq(relationships.version, mutation.sourceVersion),
            isNull(relationships.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return [];
      const label = row.label ?? row.forwardLabel;
      const item = contribution({
        redactedText: label,
        displayText: label,
        resultKind: "RELATIONSHIP",
        resultId: row.id,
        subjectPersonId: row.sourcePersonId,
        sensitivity: row.sensitivity,
        updatedAt: latestTimestamp(row.updatedAt, row.typeUpdatedAt),
      });
      return item ? [item] : [];
    }
    case "relationship_type": {
      // Type events fan out into canonical relationship documents below.
      return [];
    }
    case "source": {
      const [row] = await database
        .select({
          id: sources.id,
          title: sources.title,
          sensitivity: sources.sensitivity,
          updatedAt: sources.updatedAt,
        })
        .from(sources)
        .where(
          and(
            eq(sources.workspaceId, mutation.workspaceId),
            eq(sources.id, mutation.sourceId),
            eq(sources.version, mutation.sourceVersion),
            isNull(sources.deletedAt),
          ),
        )
        .limit(1);
      const item = row
        ? contribution({
            redactedText: row.title,
            displayText: row.title,
            resultKind: "EVIDENCE",
            resultId: row.id,
            subjectPersonId: null,
            sensitivity: row.sensitivity,
            updatedAt: row.updatedAt,
          })
        : null;
      return item ? [item] : [];
    }
    case "person_address": {
      const [row] = await database
        .select({
          addressId: addresses.id,
          countryCode: addresses.countryCode,
          locality: addresses.locality,
          personId: personAddresses.personId,
          postalCode: addresses.postalCode,
          region: addresses.region,
          sensitivity: addresses.sensitivity,
          addressUpdatedAt: addresses.updatedAt,
          associationUpdatedAt: personAddresses.updatedAt,
        })
        .from(personAddresses)
        .innerJoin(
          addresses,
          and(
            eq(addresses.workspaceId, personAddresses.workspaceId),
            eq(addresses.id, personAddresses.addressId),
            isNull(addresses.deletedAt),
          ),
        )
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, personAddresses.workspaceId),
            eq(people.id, personAddresses.personId),
            isNull(people.deletedAt),
          ),
        )
        .where(
          and(
            eq(personAddresses.workspaceId, mutation.workspaceId),
            eq(personAddresses.id, mutation.sourceId),
            eq(personAddresses.version, mutation.sourceVersion),
            isNull(personAddresses.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return [];
      const locality = addressLocality(row);
      const item = contribution({
        redactedText: locality,
        displayText: locality,
        resultKind: "ADDRESS",
        resultId: row.addressId,
        subjectPersonId: row.personId,
        sensitivity: row.sensitivity,
        updatedAt: latestTimestamp(
          row.addressUpdatedAt,
          row.associationUpdatedAt,
        ),
      });
      return item ? [item] : [];
    }
    case "evidence_item": {
      const [row] = await database
        .select({
          id: evidenceItems.id,
          sourceTitle: sources.title,
          evidenceSensitivity: evidenceItems.sensitivity,
          sourceSensitivity: sources.sensitivity,
          evidenceUpdatedAt: evidenceItems.updatedAt,
          sourceUpdatedAt: sources.updatedAt,
        })
        .from(evidenceItems)
        .innerJoin(
          sources,
          and(
            eq(sources.workspaceId, evidenceItems.workspaceId),
            eq(sources.id, evidenceItems.sourceId),
            isNull(sources.deletedAt),
          ),
        )
        .where(
          and(
            eq(evidenceItems.workspaceId, mutation.workspaceId),
            eq(evidenceItems.id, mutation.sourceId),
            eq(evidenceItems.version, mutation.sourceVersion),
            eq(evidenceItems.reviewState, "accepted"),
            isNull(evidenceItems.deletedAt),
          ),
        )
        .limit(1);
      const item = row
        ? contribution({
            redactedText: row.sourceTitle,
            displayText: row.sourceTitle,
            resultKind: "EVIDENCE",
            resultId: row.id,
            subjectPersonId: null,
            sensitivity: strictestSensitivity(
              row.evidenceSensitivity,
              row.sourceSensitivity,
            ),
            updatedAt: latestTimestamp(
              row.evidenceUpdatedAt,
              row.sourceUpdatedAt,
            ),
          })
        : null;
      return item ? [item] : [];
    }
    case "evidence_excerpt": {
      const [row] = await database
        .select({
          evidenceItemId: evidenceItems.id,
          excerpt: evidenceExcerpts.excerpt,
          sourceTitle: sources.title,
          evidenceSensitivity: evidenceItems.sensitivity,
          sourceSensitivity: sources.sensitivity,
          excerptCreatedAt: evidenceExcerpts.createdAt,
          evidenceUpdatedAt: evidenceItems.updatedAt,
          sourceUpdatedAt: sources.updatedAt,
        })
        .from(evidenceExcerpts)
        .innerJoin(
          evidenceItems,
          and(
            eq(evidenceItems.workspaceId, evidenceExcerpts.workspaceId),
            eq(evidenceItems.id, evidenceExcerpts.evidenceItemId),
            eq(evidenceItems.reviewState, "accepted"),
            isNull(evidenceItems.deletedAt),
          ),
        )
        .innerJoin(
          sources,
          and(
            eq(sources.workspaceId, evidenceItems.workspaceId),
            eq(sources.id, evidenceItems.sourceId),
            isNull(sources.deletedAt),
          ),
        )
        .where(
          and(
            eq(evidenceExcerpts.workspaceId, mutation.workspaceId),
            eq(evidenceExcerpts.id, mutation.sourceId),
            eq(evidenceExcerpts.redactionState, "clear"),
          ),
        )
        .limit(1);
      const item = row
        ? contribution({
            redactedText: row.sourceTitle,
            bodyText: row.excerpt,
            displayText: `${row.sourceTitle}: ${row.excerpt}`,
            resultKind: "EVIDENCE",
            resultId: row.evidenceItemId,
            subjectPersonId: null,
            sensitivity: strictestSensitivity(
              row.evidenceSensitivity,
              row.sourceSensitivity,
            ),
            updatedAt: latestTimestamp(
              row.excerptCreatedAt,
              row.evidenceUpdatedAt,
              row.sourceUpdatedAt,
            ),
          })
        : null;
      return item ? [item] : [];
    }
    case "note": {
      const [row] = await database
        .select({
          evidenceItemId: evidenceItems.id,
          noteText: sql<string>`coalesce(${notes.plainText}, ${notes.sanitizedMarkdown}, '')`,
          sourceTitle: sources.title,
          noteSensitivity: notes.sensitivity,
          evidenceSensitivity: evidenceItems.sensitivity,
          sourceSensitivity: sources.sensitivity,
          noteUpdatedAt: notes.updatedAt,
          evidenceUpdatedAt: evidenceItems.updatedAt,
          sourceUpdatedAt: sources.updatedAt,
        })
        .from(notes)
        .innerJoin(
          evidenceItems,
          and(
            eq(evidenceItems.workspaceId, notes.workspaceId),
            eq(evidenceItems.id, notes.evidenceItemId),
            eq(evidenceItems.reviewState, "accepted"),
            isNull(evidenceItems.deletedAt),
          ),
        )
        .innerJoin(
          sources,
          and(
            eq(sources.workspaceId, evidenceItems.workspaceId),
            eq(sources.id, evidenceItems.sourceId),
            isNull(sources.deletedAt),
          ),
        )
        .where(
          and(
            eq(notes.workspaceId, mutation.workspaceId),
            eq(notes.id, mutation.sourceId),
            eq(notes.version, mutation.sourceVersion),
            isNull(notes.deletedAt),
          ),
        )
        .limit(1);
      const item = row
        ? contribution({
            redactedText: row.sourceTitle,
            bodyText: row.noteText,
            displayText: `${row.sourceTitle}: ${row.noteText}`,
            resultKind: "EVIDENCE",
            resultId: row.evidenceItemId,
            subjectPersonId: null,
            sensitivity: strictestSensitivity(
              row.noteSensitivity,
              row.evidenceSensitivity,
              row.sourceSensitivity,
            ),
            updatedAt: latestTimestamp(
              row.noteUpdatedAt,
              row.evidenceUpdatedAt,
              row.sourceUpdatedAt,
            ),
          })
        : null;
      return item ? [item] : [];
    }
  }
}

async function dependentMutations(
  database: Database,
  mutation: SearchIndexMutation,
): Promise<SearchIndexMutation[]> {
  const result: SearchIndexMutation[] = [];
  let afterId: string | null = null;
  while (true) {
    let rows: Array<{
      id: string;
      sourceKind: SearchIndexMutation["sourceKind"];
      version: number;
    }> = [];
    if (mutation.sourceKind === "fact_definition") {
      rows = await database
        .select({ id: facts.id, version: facts.version })
        .from(facts)
        .where(
          and(
            eq(facts.workspaceId, mutation.workspaceId),
            eq(facts.factDefinitionId, mutation.sourceId),
            isNull(facts.deletedAt),
            afterId ? gt(facts.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(facts.id))
        .limit(MAX_CONTRIBUTIONS)
        .then((items) =>
          items.map((item) => ({ ...item, sourceKind: "fact" as const })),
        );
    } else if (mutation.sourceKind === "relationship_type") {
      rows = await database
        .select({ id: relationships.id, version: relationships.version })
        .from(relationships)
        .where(
          and(
            eq(relationships.workspaceId, mutation.workspaceId),
            eq(relationships.relationshipTypeId, mutation.sourceId),
            isNull(relationships.deletedAt),
            afterId ? gt(relationships.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(relationships.id))
        .limit(MAX_CONTRIBUTIONS)
        .then((items) =>
          items.map((item) => ({
            ...item,
            sourceKind: "relationship" as const,
          })),
        );
    } else if (mutation.sourceKind === "source") {
      rows = await database
        .select({ id: evidenceItems.id, version: evidenceItems.version })
        .from(evidenceItems)
        .where(
          and(
            eq(evidenceItems.workspaceId, mutation.workspaceId),
            eq(evidenceItems.sourceId, mutation.sourceId),
            isNull(evidenceItems.deletedAt),
            afterId ? gt(evidenceItems.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(evidenceItems.id))
        .limit(MAX_CONTRIBUTIONS)
        .then((items) =>
          items.map((item) => ({
            ...item,
            sourceKind: "evidence_item" as const,
          })),
        );
    } else if (mutation.sourceKind === "evidence_item") {
      const excerpts = await database
        .select({ id: evidenceExcerpts.id })
        .from(evidenceExcerpts)
        .where(
          and(
            eq(evidenceExcerpts.workspaceId, mutation.workspaceId),
            eq(evidenceExcerpts.evidenceItemId, mutation.sourceId),
            afterId ? gt(evidenceExcerpts.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(evidenceExcerpts.id))
        .limit(MAX_CONTRIBUTIONS);
      rows = excerpts.map(({ id }) => ({
        id,
        sourceKind: "evidence_excerpt" as const,
        version: 1,
      }));
    } else {
      break;
    }
    if (!rows.length) break;
    result.push(
      ...rows.map((row) => ({
        action: "upsert" as const,
        sourceId: row.id,
        sourceKind: row.sourceKind,
        sourceVersion: row.version,
        workspaceId: mutation.workspaceId,
      })),
    );
    afterId = rows.at(-1)!.id;
    if (rows.length < MAX_CONTRIBUTIONS) break;
  }
  if (mutation.sourceKind === "evidence_item") {
    afterId = null;
    while (true) {
      const rows = await database
        .select({ id: notes.id, version: notes.version })
        .from(notes)
        .where(
          and(
            eq(notes.workspaceId, mutation.workspaceId),
            eq(notes.evidenceItemId, mutation.sourceId),
            isNull(notes.deletedAt),
            afterId ? gt(notes.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(notes.id))
        .limit(MAX_CONTRIBUTIONS);
      if (!rows.length) break;
      result.push(
        ...rows.map((row) => ({
          action: "upsert" as const,
          sourceId: row.id,
          sourceKind: "note" as const,
          sourceVersion: row.version,
          workspaceId: mutation.workspaceId,
        })),
      );
      afterId = rows.at(-1)!.id;
      if (rows.length < MAX_CONTRIBUTIONS) break;
    }
  }
  return result;
}

export function createSearchIndexMaintenance(input: {
  metrics: Task12Metrics;
}): SearchIndexMaintenance {
  return Object.freeze({
    mode: "transactional" as const,
    async apply(database: Database, mutations: readonly SearchIndexMutation[]) {
      const pending = [...mutations];
      for (let index = 0; index < pending.length; index += 1) {
        const mutation = pending[index]!;
        try {
          const [current] = await database
            .select({ sourceVersion: searchDocuments.sourceVersion })
            .from(searchDocuments)
            .where(
              and(
                eq(searchDocuments.workspaceId, mutation.workspaceId),
                eq(searchDocuments.resourceKind, mutation.sourceKind),
                eq(searchDocuments.resourceId, mutation.sourceId),
              ),
            )
            .orderBy(desc(searchDocuments.sourceVersion))
            .limit(1);
          if (current && current.sourceVersion > mutation.sourceVersion) {
            input.metrics.indexMaintenance({
              outcome: "STALE",
              sourceKind: mutation.sourceKind,
            });
            continue;
          }
          const predicate = and(
            eq(searchDocuments.workspaceId, mutation.workspaceId),
            eq(searchDocuments.resourceKind, mutation.sourceKind),
            eq(searchDocuments.resourceId, mutation.sourceId),
          );
          if (mutation.action === "remove") {
            await database.delete(searchDocuments).where(predicate);
            input.metrics.indexMaintenance({
              outcome: "REMOVED",
              sourceKind: mutation.sourceKind,
            });
            continue;
          }
          const documents = await loadContributions(database, mutation);
          await database.delete(searchDocuments).where(predicate);
          if (documents.length)
            await database.insert(searchDocuments).values(
              documents.map((document, chunkOrdinal) => ({
                id: newId(),
                workspaceId: mutation.workspaceId,
                resourceKind: mutation.sourceKind,
                resourceId: mutation.sourceId,
                sourceVersion: mutation.sourceVersion,
                chunkOrdinal,
                resultKind: document.resultKind,
                resultId: document.resultId,
                subjectPersonId: document.subjectPersonId,
                sensitivity: document.sensitivity,
                redactedText: document.redactedText,
                bodyText: document.bodyText,
                displayText: document.displayText,
                updatedAt: document.updatedAt,
              })),
            );
          pending.push(...(await dependentMutations(database, mutation)));
          input.metrics.indexMaintenance({
            outcome: documents.length ? "UPSERTED" : "REMOVED",
            sourceKind: mutation.sourceKind,
          });
        } catch (error) {
          input.metrics.indexMaintenance({
            outcome: "ERROR",
            sourceKind: mutation.sourceKind,
          });
          throw error;
        }
      }
    },
  });
}

export async function reindexWorkspace(input: {
  batchSize: number;
  database: Database;
  dryRun: boolean;
  maintenance: SearchIndexMaintenance;
  workspaceId: string;
}): Promise<{ processed: number; upserted: number }> {
  if (
    !Number.isInteger(input.batchSize) ||
    input.batchSize < 1 ||
    input.batchSize > 500
  )
    throw new TypeError("The reindex batch size must be between 1 and 500.");
  let processed = 0;
  let afterKind: string | null = null;
  let afterId: string | null = null;
  while (true) {
    const rows = (await input.database.execute(sql`
      WITH reindex_sources AS (
        SELECT 'person'::text AS source_kind, id, version FROM ${people}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'person_name', id, version FROM ${personNames}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'fact_definition', id, version FROM ${factDefinitions}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'fact', id, version FROM ${facts}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'relationship_type', id, version FROM ${relationshipTypes}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'relationship', id, version FROM ${relationships}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'source', id, version FROM ${sources}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'person_address', id, version FROM ${personAddresses}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'evidence_item', id, version FROM ${evidenceItems}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
        UNION ALL SELECT 'evidence_excerpt', id, 1 AS version FROM ${evidenceExcerpts}
          WHERE workspace_id = ${input.workspaceId}::uuid
        UNION ALL SELECT 'note', id, version FROM ${notes}
          WHERE workspace_id = ${input.workspaceId}::uuid AND deleted_at IS NULL
      )
      SELECT source_kind AS "sourceKind", id, version
      FROM reindex_sources
      WHERE ${afterKind}::text IS NULL
        OR (source_kind, id) > (${afterKind}::text, ${afterId}::uuid)
      ORDER BY source_kind ASC, id ASC
      LIMIT ${input.batchSize}
    `)) as unknown as Array<{
      id: string;
      sourceKind: SearchIndexMutation["sourceKind"];
      version: number;
    }>;
    if (!rows.length) break;
    const mutations: SearchIndexMutation[] = rows.map((row) => {
      if (!SEARCH_INDEX_SOURCE_KINDS.includes(row.sourceKind))
        throw new Error("The reindex source kind is invalid.");
      return {
        action: "upsert",
        sourceId: row.id,
        sourceKind: row.sourceKind,
        sourceVersion: row.version,
        workspaceId: input.workspaceId,
      };
    });
    if (!input.dryRun)
      await input.database.transaction(async (transaction) => {
        await input.maintenance.apply(transaction as Database, mutations);
      });
    processed += mutations.length;
    const last = rows.at(-1)!;
    afterKind = last.sourceKind;
    afterId = last.id;
    if (rows.length < input.batchSize) break;
  }
  return { processed, upserted: input.dryRun ? 0 : processed };
}
