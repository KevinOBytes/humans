import "server-only";

import { sql } from "drizzle-orm";
import { caseMembers, caseResourceLinks, cases } from "@/db/schema/cases";
import { evidenceItems, sources } from "@/db/schema/evidence";
import { facts } from "@/db/schema/facts";
import { relationships, relationshipTypes } from "@/db/schema/relationships";
import {
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";

/** Used only inside the search statement, whose winning CTE has already applied
 * live resource, person, source, contribution, and case visibility predicates.
 * No indexed title is promoted to a fact value. Non-public fact context remains
 * withheld until request-bound field disclosure is available to this surface. */
export function researchAnalysisMetadataSql(
  context: Pick<ResearchServiceContext, "actor" | "workspaceId">,
  caseId?: string,
) {
  const sourceVisibility = resourceVisibilitySql(context, {
    resourceKind: "source",
    id: sources.id,
    sensitivity: sources.sensitivity,
  });
  const linkedCase = caseId
    ? sql`(
    SELECT ${caseResourceLinks.caseId}
    FROM ${caseResourceLinks}
    INNER JOIN ${caseMembers}
      ON ${caseMembers.workspaceId} = ${caseResourceLinks.workspaceId}
     AND ${caseMembers.caseId} = ${caseResourceLinks.caseId}
    INNER JOIN ${cases}
      ON ${cases.workspaceId} = ${caseResourceLinks.workspaceId}
     AND ${cases.id} = ${caseResourceLinks.caseId}
    WHERE ${caseResourceLinks.workspaceId} = ${context.workspaceId}::uuid
      AND ${caseResourceLinks.resourceId} = winning.result_id
      AND ${caseResourceLinks.resourceKind} = lower(winning.result_kind)
      AND ${caseResourceLinks.caseId} = ${caseId}::uuid
      AND ${caseMembers.principalId} = ${context.actor.principalId}::uuid
      AND ${caseMembers.deletedAt} IS NULL
      AND ${caseResourceLinks.deletedAt} IS NULL
      AND ${cases.deletedAt} IS NULL
    LIMIT 1
  )`
    : sql`NULL::uuid`;

  return sql`jsonb_build_object(
    'id', winning.result_id,
    'workspaceId', winning.workspace_id,
    'kind', winning.result_kind,
    'title', winning.title_text,
    'subjectPersonId', winning.subject_person_id,
    'sensitivity', winning.sensitivity,
    'caseId', ${linkedCase},
    'value', NULL
  ) || COALESCE(CASE winning.result_kind
    WHEN 'FACT' THEN (
      SELECT jsonb_build_object(
        'fieldKey', ${facts.namespace} || ':' || ${facts.fieldKey},
        'reviewState', ${facts.reviewState},
        'validFrom', ${facts.validEarliestAt},
        'validUntil', ${facts.validLatestAt},
        'observedAt', ${facts.observedAt},
        'value', CASE WHEN ${facts.encryptedValue} IS NULL THEN
          COALESCE(to_jsonb(${facts.valueText}), to_jsonb(${facts.valueDecimal}),
            to_jsonb(${facts.valueBoolean}), to_jsonb(${facts.valueTimestamp}),
            CASE WHEN ${facts.valueDateEnd} IS NOT NULL
              THEN jsonb_build_object('start', ${facts.valueDateStart}, 'end', ${facts.valueDateEnd})
              ELSE to_jsonb(${facts.valueDateStart}) END,
            ${facts.valueJson})
          ELSE NULL END
      ) FROM ${facts}
      WHERE ${facts.workspaceId} = winning.workspace_id
        AND ${facts.id} = winning.result_id
        AND ${facts.sensitivity} = 'public'
        AND ${facts.deletedAt} IS NULL
    )
    WHEN 'RELATIONSHIP' THEN (
      SELECT jsonb_build_object(
        'sourcePersonId', ${relationships.sourcePersonId},
        'targetPersonId', ${relationships.targetPersonId},
        'directed', ${relationshipTypes.directed},
        'relationshipState', ${relationships.state},
        'reviewState', ${relationships.reviewState},
        'observedAt', ${relationships.observedAt},
        'validFrom', ${relationships.validFrom},
        'validUntil', ${relationships.validUntil}
      ) FROM ${relationships}
      INNER JOIN ${relationshipTypes}
        ON ${relationshipTypes.workspaceId} = ${relationships.workspaceId}
       AND ${relationshipTypes.id} = ${relationships.relationshipTypeId}
      WHERE ${relationships.workspaceId} = winning.workspace_id
        AND ${relationships.id} = winning.result_id
        AND ${relationships.deletedAt} IS NULL
    )
    WHEN 'EVIDENCE' THEN (
      SELECT jsonb_build_object(
        'sourceId', ${sources.id},
        'sourceTitle', ${sources.title},
        'sourceUrl', ${sources.canonicalUrl},
        'sourceReliability', ${sources.reliability},
        'observedAt', CASE WHEN winning.source_kind = 'source'
          THEN ${sources.collectedAt} ELSE ${evidenceItems.capturedAt} END,
        'reviewState', CASE WHEN winning.source_kind = 'source'
          THEN NULL ELSE ${evidenceItems.reviewState} END
      ) FROM ${sources}
      LEFT JOIN ${evidenceItems}
        ON ${evidenceItems.workspaceId} = ${sources.workspaceId}
       AND ${evidenceItems.sourceId} = ${sources.id}
       AND ${evidenceItems.id} = winning.result_id
       AND ${evidenceItems.deletedAt} IS NULL
      WHERE ${sources.workspaceId} = winning.workspace_id
        AND ${sources.deletedAt} IS NULL
        AND ${sourceVisibility}
        AND ((winning.source_kind = 'source' AND ${sources.id} = winning.result_id)
          OR (winning.source_kind <> 'source' AND ${evidenceItems.id} IS NOT NULL))
      LIMIT 1
    )
    ELSE '{}'::jsonb
  END, '{}'::jsonb)`;
}
