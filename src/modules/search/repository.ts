import "server-only";

import { and, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

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
import {
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import type { Database } from "@/modules/auth/bootstrap-admin";

import type { SearchCursorPayload } from "./cursor";
import type { NormalizedSearchInput } from "./normalization";

const resultPeople = alias(people, "search_result_people");
const sourcePersonNames = alias(personNames, "search_source_person_names");
const factPeople = alias(people, "search_fact_people");
const resultFactDefinitions = alias(
  factDefinitions,
  "search_result_fact_definitions",
);
const relationshipSourcePeople = alias(
  people,
  "search_relationship_source_people",
);
const relationshipTargetPeople = alias(
  people,
  "search_relationship_target_people",
);
const resultFacts = alias(facts, "search_result_facts");
const resultRelationships = alias(relationships, "search_result_relationships");
const resultRelationshipTypes = alias(
  relationshipTypes,
  "search_result_relationship_types",
);
const resultSources = alias(sources, "search_result_sources");
const resultEvidence = alias(evidenceItems, "search_result_evidence");
const evidenceSources = alias(sources, "search_evidence_sources");
const resultEvidenceExcerpts = alias(
  evidenceExcerpts,
  "search_result_evidence_excerpts",
);
const resultEvidenceNotes = alias(notes, "search_result_evidence_notes");
const resultAddresses = alias(addresses, "search_result_addresses");
const resultPersonAddresses = alias(
  personAddresses,
  "search_result_person_addresses",
);
const addressPeople = alias(people, "search_address_people");

function anyOf(column: SQLWrapper, values: readonly string[] | undefined): SQL {
  return values?.length ? inArray(column, [...values]) : sql`true`;
}

function temporal(
  input: NormalizedSearchInput["filters"],
  columns: {
    from: SQLWrapper;
    until: SQLWrapper;
  },
): SQL {
  const at = input.at ?? null;
  const from = input.from ?? null;
  const until = input.until ?? null;
  return (
    and(
      at
        ? sql`(${columns.from} IS NULL OR ${columns.from} <= ${at}::timestamptz) AND (${columns.until} IS NULL OR ${columns.until} >= ${at}::timestamptz)`
        : undefined,
      from
        ? sql`(${columns.until} IS NULL OR ${columns.until} >= ${from}::timestamptz)`
        : undefined,
      until
        ? sql`(${columns.from} IS NULL OR ${columns.from} <= ${until}::timestamptz)`
        : undefined,
    ) ?? sql`true`
  );
}

export type TextSearchRow = {
  displayText: string;
  id: string;
  kind: NormalizedSearchInput["kinds"][number];
  rank: number;
  subjectPersonId: string | null;
  title: string;
  updatedAt: Date | string;
};

export function createSearchRepository(
  database: Database,
  context: Pick<ResearchServiceContext, "actor" | "workspaceId">,
  diagnostics?: Readonly<{
    explain(statement: SQL): Promise<void>;
  }>,
) {
  const personVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: resultPeople.id,
    sensitivity: resultPeople.sensitivity,
  });
  const personContributionVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: resultPeople.id,
    sensitivity: sql`d.sensitivity`,
  });
  const factVisibility = resourceVisibilitySql(context, {
    resourceKind: "fact",
    id: resultFacts.id,
    sensitivity: resultFacts.sensitivity,
  });
  const factContributionVisibility = resourceVisibilitySql(context, {
    resourceKind: "fact",
    id: resultFacts.id,
    sensitivity: sql`d.sensitivity`,
  });
  const factPersonVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: factPeople.id,
    sensitivity: factPeople.sensitivity,
  });
  const addressPersonVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: addressPeople.id,
    sensitivity: addressPeople.sensitivity,
  });
  const relationshipVisibility = resourceVisibilitySql(context, {
    resourceKind: "relationship",
    id: resultRelationships.id,
    sensitivity: resultRelationships.sensitivity,
  });
  const relationshipContributionVisibility = resourceVisibilitySql(context, {
    resourceKind: "relationship",
    id: resultRelationships.id,
    sensitivity: sql`d.sensitivity`,
  });
  const relationshipSourceVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: relationshipSourcePeople.id,
    sensitivity: relationshipSourcePeople.sensitivity,
  });
  const relationshipTargetVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: relationshipTargetPeople.id,
    sensitivity: relationshipTargetPeople.sensitivity,
  });
  const sourceVisibility = resourceVisibilitySql(context, {
    resourceKind: "source",
    id: resultSources.id,
    sensitivity: resultSources.sensitivity,
  });
  const sourceContributionVisibility = resourceVisibilitySql(context, {
    resourceKind: "source",
    id: resultSources.id,
    sensitivity: sql`d.sensitivity`,
  });
  const evidenceVisibility = resourceVisibilitySql(context, {
    resourceKind: "evidenceItem",
    id: resultEvidence.id,
    sensitivity: resultEvidence.sensitivity,
  });
  const evidenceContributionVisibility = resourceVisibilitySql(context, {
    resourceKind: "evidenceItem",
    id: resultEvidence.id,
    sensitivity: sql`d.sensitivity`,
  });
  const evidenceSourceVisibility = resourceVisibilitySql(context, {
    resourceKind: "source",
    id: evidenceSources.id,
    sensitivity: evidenceSources.sensitivity,
  });
  const evidenceNoteVisibility = resourceVisibilitySql(context, {
    resourceKind: "note",
    id: resultEvidenceNotes.id,
    sensitivity: resultEvidenceNotes.sensitivity,
  });
  const addressVisibility = resourceVisibilitySql(context, {
    resourceKind: "address",
    id: resultAddresses.id,
    sensitivity: resultAddresses.sensitivity,
  });
  const addressContributionVisibility = resourceVisibilitySql(context, {
    resourceKind: "address",
    id: resultAddresses.id,
    sensitivity: sql`d.sensitivity`,
  });

  return {
    async protectedPeople(ids: readonly string[]) {
      if (!ids.length) return [];
      return database
        .select({
          id: resultPeople.id,
          title: resultPeople.displayName,
          updatedAt: resultPeople.updatedAt,
        })
        .from(resultPeople)
        .where(
          and(
            inArray(resultPeople.id, [...ids]),
            sql`${resultPeople.workspaceId} = ${context.workspaceId}::uuid`,
            sql`${resultPeople.deletedAt} IS NULL`,
            personVisibility,
          ),
        );
    },
    async searchText(input: {
      cursor: Extract<SearchCursorPayload, { branch: "text" }> | null;
      search: NormalizedSearchInput & {
        match: { type: "text"; query: string };
      };
    }): Promise<TextSearchRow[]> {
      const filter = input.search.filters;
      const cursor = input.cursor;
      const statement = sql`
        WITH authorized_matches AS (
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${people} AS "search_result_people"
            ON ${resultPeople.workspaceId} = d.workspace_id
           AND ${resultPeople.id} = d.result_id
           AND ${resultPeople.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'PERSON'
            AND d.source_kind = 'person'
            AND d.source_id = ${resultPeople.id}
            AND d.source_version = ${resultPeople.version}
            AND ${resultPeople.updatedAt} <= d.updated_at
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultPeople.id, filter.personIds)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${personVisibility}
            AND ${personContributionVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${personNames} AS "search_source_person_names"
            ON ${sourcePersonNames.workspaceId} = d.workspace_id
           AND ${sourcePersonNames.id} = d.source_id
           AND ${sourcePersonNames.version} = d.source_version
           AND ${sourcePersonNames.deletedAt} IS NULL
           AND ${sourcePersonNames.updatedAt} <= d.updated_at
          INNER JOIN ${people} AS "search_result_people"
            ON ${resultPeople.workspaceId} = ${sourcePersonNames.workspaceId}
           AND ${resultPeople.id} = ${sourcePersonNames.personId}
           AND ${resultPeople.id} = d.result_id
           AND ${resultPeople.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'PERSON'
            AND d.source_kind = 'person_name'
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultPeople.id, filter.personIds)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${personVisibility}
            AND ${personContributionVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${evidenceExcerpts} AS "search_result_evidence_excerpts"
            ON ${resultEvidenceExcerpts.workspaceId} = d.workspace_id
           AND ${resultEvidenceExcerpts.id} = d.source_id
           AND ${resultEvidenceExcerpts.redactionState} = 'clear'
          INNER JOIN ${evidenceItems} AS "search_result_evidence"
            ON ${resultEvidence.workspaceId} = ${resultEvidenceExcerpts.workspaceId}
           AND ${resultEvidence.id} = ${resultEvidenceExcerpts.evidenceItemId}
           AND ${resultEvidence.id} = d.result_id
           AND ${resultEvidence.reviewState} = 'accepted'
           AND ${resultEvidence.deletedAt} IS NULL
          INNER JOIN ${sources} AS "search_evidence_sources"
            ON ${evidenceSources.workspaceId} = ${resultEvidence.workspaceId}
           AND ${evidenceSources.id} = ${resultEvidence.sourceId}
           AND ${evidenceSources.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'EVIDENCE'
            AND d.source_kind = 'evidence_excerpt'
            AND d.source_version = 1
            AND ${resultEvidenceExcerpts.createdAt} <= d.updated_at
            AND ${resultEvidence.updatedAt} <= d.updated_at
            AND ${evidenceSources.updatedAt} <= d.updated_at
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultEvidence.sourceId, filter.sourceIds)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${evidenceVisibility}
            AND ${evidenceContributionVisibility}
            AND ${evidenceSourceVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${notes} AS "search_result_evidence_notes"
            ON ${resultEvidenceNotes.workspaceId} = d.workspace_id
           AND ${resultEvidenceNotes.id} = d.source_id
           AND ${resultEvidenceNotes.version} = d.source_version
           AND ${resultEvidenceNotes.deletedAt} IS NULL
          INNER JOIN ${evidenceItems} AS "search_result_evidence"
            ON ${resultEvidence.workspaceId} = ${resultEvidenceNotes.workspaceId}
           AND ${resultEvidence.id} = ${resultEvidenceNotes.evidenceItemId}
           AND ${resultEvidence.id} = d.result_id
           AND ${resultEvidence.reviewState} = 'accepted'
           AND ${resultEvidence.deletedAt} IS NULL
          INNER JOIN ${sources} AS "search_evidence_sources"
            ON ${evidenceSources.workspaceId} = ${resultEvidence.workspaceId}
           AND ${evidenceSources.id} = ${resultEvidence.sourceId}
           AND ${evidenceSources.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'EVIDENCE'
            AND d.source_kind = 'note'
            AND ${resultEvidenceNotes.updatedAt} <= d.updated_at
            AND ${resultEvidence.updatedAt} <= d.updated_at
            AND ${evidenceSources.updatedAt} <= d.updated_at
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultEvidence.sourceId, filter.sourceIds)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${evidenceVisibility}
            AND ${evidenceContributionVisibility}
            AND ${evidenceSourceVisibility}
            AND ${evidenceNoteVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${facts} AS "search_result_facts"
            ON ${resultFacts.workspaceId} = d.workspace_id
           AND ${resultFacts.id} = d.result_id
           AND ${resultFacts.deletedAt} IS NULL
          INNER JOIN ${people} AS "search_fact_people"
            ON ${factPeople.workspaceId} = ${resultFacts.workspaceId}
           AND ${factPeople.id} = ${resultFacts.personId}
           AND ${factPeople.deletedAt} IS NULL
          INNER JOIN ${factDefinitions} AS "search_result_fact_definitions"
           ON ${resultFactDefinitions.workspaceId} = ${resultFacts.workspaceId}
           AND ${resultFactDefinitions.id} = ${resultFacts.factDefinitionId}
           AND ${resultFactDefinitions.deletedAt} IS NULL
           AND ${resultFactDefinitions.state} = 'active'
           AND ${resultFactDefinitions.searchable} = true
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'FACT'
            AND d.source_kind = 'fact'
            AND d.source_id = ${resultFacts.id}
            AND d.source_version = ${resultFacts.version}
            AND ${resultFacts.updatedAt} <= d.updated_at
            AND ${resultFactDefinitions.updatedAt} <= d.updated_at
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultFacts.personId, filter.personIds)}
            AND ${anyOf(resultFacts.factDefinitionId, filter.factDefinitionIds)}
            AND ${anyOf(resultFacts.state, filter.factStates)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${temporal(filter, {
              from: resultFacts.validEarliestAt,
              until: resultFacts.validLatestAt,
            })}
            AND ${factVisibility}
            AND ${factContributionVisibility}
            AND ${factPersonVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${relationships} AS "search_result_relationships"
            ON ${resultRelationships.workspaceId} = d.workspace_id
           AND ${resultRelationships.id} = d.result_id
           AND ${resultRelationships.deletedAt} IS NULL
          INNER JOIN ${relationshipTypes} AS "search_result_relationship_types"
            ON ${resultRelationshipTypes.workspaceId} = ${resultRelationships.workspaceId}
           AND ${resultRelationshipTypes.id} = ${resultRelationships.relationshipTypeId}
           AND ${resultRelationshipTypes.deletedAt} IS NULL
          INNER JOIN ${people} AS "search_relationship_source_people"
            ON ${relationshipSourcePeople.workspaceId} = ${resultRelationships.workspaceId}
           AND ${relationshipSourcePeople.id} = ${resultRelationships.sourcePersonId}
           AND ${relationshipSourcePeople.deletedAt} IS NULL
          INNER JOIN ${people} AS "search_relationship_target_people"
            ON ${relationshipTargetPeople.workspaceId} = ${resultRelationships.workspaceId}
           AND ${relationshipTargetPeople.id} = ${resultRelationships.targetPersonId}
           AND ${relationshipTargetPeople.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'RELATIONSHIP'
            AND d.source_kind = 'relationship'
            AND d.source_id = ${resultRelationships.id}
            AND d.source_version = ${resultRelationships.version}
            AND ${resultRelationships.updatedAt} <= d.updated_at
            AND ${resultRelationshipTypes.updatedAt} <= d.updated_at
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultRelationships.relationshipTypeId, filter.relationshipTypeIds)}
            AND ${
              filter.personIds?.length
                ? or(
                    inArray(
                      resultRelationships.sourcePersonId,
                      filter.personIds,
                    ),
                    inArray(
                      resultRelationships.targetPersonId,
                      filter.personIds,
                    ),
                  )
                : sql`true`
            }
            AND ${anyOf(resultRelationships.state, filter.relationshipStates)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${temporal(filter, {
              from: resultRelationships.validFrom,
              until: resultRelationships.validUntil,
            })}
            AND ${relationshipVisibility}
            AND ${relationshipContributionVisibility}
            AND ${relationshipSourceVisibility}
            AND ${relationshipTargetVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${relationships} AS "search_result_relationships"
            ON ${resultRelationships.workspaceId} = d.workspace_id
           AND ${resultRelationships.id} = d.result_id
           AND ${resultRelationships.deletedAt} IS NULL
           AND ${resultRelationships.updatedAt} <= d.updated_at
          INNER JOIN ${relationshipTypes} AS "search_result_relationship_types"
            ON ${resultRelationshipTypes.workspaceId} = ${resultRelationships.workspaceId}
           AND ${resultRelationshipTypes.id} = ${resultRelationships.relationshipTypeId}
           AND ${resultRelationshipTypes.id} = d.source_id
           AND ${resultRelationshipTypes.version} = d.source_version
           AND ${resultRelationshipTypes.deletedAt} IS NULL
           AND ${resultRelationshipTypes.updatedAt} <= d.updated_at
          INNER JOIN ${people} AS "search_relationship_source_people"
            ON ${relationshipSourcePeople.workspaceId} = ${resultRelationships.workspaceId}
           AND ${relationshipSourcePeople.id} = ${resultRelationships.sourcePersonId}
           AND ${relationshipSourcePeople.deletedAt} IS NULL
          INNER JOIN ${people} AS "search_relationship_target_people"
            ON ${relationshipTargetPeople.workspaceId} = ${resultRelationships.workspaceId}
           AND ${relationshipTargetPeople.id} = ${resultRelationships.targetPersonId}
           AND ${relationshipTargetPeople.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'RELATIONSHIP'
            AND d.source_kind = 'relationship_type'
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultRelationships.relationshipTypeId, filter.relationshipTypeIds)}
            AND ${
              filter.personIds?.length
                ? or(
                    inArray(
                      resultRelationships.sourcePersonId,
                      filter.personIds,
                    ),
                    inArray(
                      resultRelationships.targetPersonId,
                      filter.personIds,
                    ),
                  )
                : sql`true`
            }
            AND ${anyOf(resultRelationships.state, filter.relationshipStates)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${temporal(filter, {
              from: resultRelationships.validFrom,
              until: resultRelationships.validUntil,
            })}
            AND ${relationshipVisibility}
            AND ${relationshipContributionVisibility}
            AND ${relationshipSourceVisibility}
            AND ${relationshipTargetVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${sources} AS "search_result_sources"
            ON ${resultSources.workspaceId} = d.workspace_id
           AND ${resultSources.id} = d.result_id
           AND ${resultSources.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'EVIDENCE'
            AND d.source_kind = 'source'
            AND d.source_id = ${resultSources.id}
            AND d.source_version = ${resultSources.version}
            AND ${resultSources.updatedAt} <= d.updated_at
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultSources.id, filter.sourceIds)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${sourceVisibility}
            AND ${sourceContributionVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${evidenceItems} AS "search_result_evidence"
            ON ${resultEvidence.workspaceId} = d.workspace_id
           AND ${resultEvidence.id} = d.result_id
           AND ${resultEvidence.deletedAt} IS NULL
          INNER JOIN ${sources} AS "search_evidence_sources"
            ON ${evidenceSources.workspaceId} = ${resultEvidence.workspaceId}
           AND ${evidenceSources.id} = ${resultEvidence.sourceId}
           AND ${evidenceSources.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'EVIDENCE'
            AND d.source_kind = 'evidence_item'
            AND d.source_id = ${resultEvidence.id}
            AND d.source_version = ${resultEvidence.version}
            AND ${resultEvidence.updatedAt} <= d.updated_at
            AND ${evidenceSources.updatedAt} <= d.updated_at
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(resultEvidence.sourceId, filter.sourceIds)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${evidenceVisibility}
            AND ${evidenceContributionVisibility}
            AND ${evidenceSourceVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})

          UNION ALL
          SELECT d.*,
                 ts_rank_cd(d.search_vector, websearch_to_tsquery('simple'::regconfig, ${input.search.match.query}), 32)::double precision AS rank
          FROM ${searchDocuments} d
          INNER JOIN ${addresses} AS "search_result_addresses"
            ON ${resultAddresses.workspaceId} = d.workspace_id
           AND ${resultAddresses.id} = d.result_id
           AND ${resultAddresses.deletedAt} IS NULL
          INNER JOIN ${personAddresses} AS "search_result_person_addresses"
            ON ${resultPersonAddresses.workspaceId} = ${resultAddresses.workspaceId}
           AND ${resultPersonAddresses.id} = d.source_id
           AND ${resultPersonAddresses.addressId} = ${resultAddresses.id}
           AND ${resultPersonAddresses.personId} = d.subject_person_id
           AND ${resultPersonAddresses.version} = d.source_version
           AND ${resultPersonAddresses.deletedAt} IS NULL
          INNER JOIN ${people} AS "search_address_people"
            ON ${addressPeople.workspaceId} = ${resultPersonAddresses.workspaceId}
           AND ${addressPeople.id} = ${resultPersonAddresses.personId}
           AND ${addressPeople.deletedAt} IS NULL
          WHERE d.workspace_id = ${context.workspaceId}::uuid
            AND d.result_kind = 'ADDRESS'
            AND d.source_kind = 'person_address'
            AND ${resultAddresses.updatedAt} <= d.updated_at
            AND ${resultPersonAddresses.updatedAt} <= d.updated_at
            AND ${anyOf(sql`d.result_kind`, input.search.kinds)}
            AND ${anyOf(addressPeople.id, filter.personIds)}
            AND ${anyOf(sql`d.sensitivity`, filter.sensitivities)}
            AND ${addressVisibility}
            AND ${addressContributionVisibility}
            AND ${addressPersonVisibility}
            AND d.search_vector @@ websearch_to_tsquery('simple'::regconfig, ${input.search.match.query})
        ), ranked AS (
          SELECT authorized_matches.*,
                 row_number() OVER (
                   PARTITION BY result_kind, result_id
                   ORDER BY rank DESC, updated_at DESC, source_kind ASC,
                            source_id ASC, chunk_ordinal ASC
                 ) AS contribution_rank
          FROM authorized_matches
        ), winning AS (
          SELECT * FROM ranked WHERE contribution_rank = 1
        )
        SELECT result_kind AS kind, result_id AS id, title_text AS title,
               subject_person_id AS "subjectPersonId",
               display_text AS "displayText", updated_at AS "updatedAt", rank
        FROM winning
        WHERE ${
          cursor
            ? sql`(
                rank < ${cursor.rank}
                OR (rank = ${cursor.rank} AND updated_at < ${cursor.updatedAt}::timestamptz)
                OR (rank = ${cursor.rank} AND updated_at = ${cursor.updatedAt}::timestamptz AND result_kind > ${cursor.kind})
                OR (rank = ${cursor.rank} AND updated_at = ${cursor.updatedAt}::timestamptz AND result_kind = ${cursor.kind} AND result_id > ${cursor.resourceId}::uuid)
              )`
            : sql`true`
        }
        ORDER BY rank DESC, updated_at DESC, result_kind ASC, result_id ASC
        LIMIT ${input.search.first + 1}
      `;
      await diagnostics?.explain(statement);
      const rows = await database.execute(statement);
      return rows as unknown as TextSearchRow[];
    },
  };
}
