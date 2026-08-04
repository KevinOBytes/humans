import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  gte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  analysisResults,
  analysisRuns,
  graphSnapshots,
  graphViewNodes,
  graphViews,
  personMetrics,
} from "@/db/schema/graph";
import { people } from "@/db/schema/people";
import { relationshipTypes, relationships } from "@/db/schema/relationships";
import type { Database } from "@/modules/auth/bootstrap-admin";

import { validateStoredGraphSnapshotManifest } from "./snapshot-manifest";
import { GRAPH_RELATIONSHIP_STATES, type NormalizedGraphFilter } from "./types";

const sourcePeople = alias(people, "graph_source_people");
const targetPeople = alias(people, "graph_target_people");
const viewRootPeople = alias(people, "graph_view_root_people");
const viewPositionPeople = alias(people, "graph_view_position_people");
const snapshotPeople = alias(people, "graph_snapshot_people");
const snapshotRelationships = alias(
  relationships,
  "graph_snapshot_relationships",
);
const snapshotRelationshipTypes = alias(
  relationshipTypes,
  "graph_snapshot_relationship_types",
);
const snapshotSourcePeople = alias(people, "graph_snapshot_source_people");
const snapshotTargetPeople = alias(people, "graph_snapshot_target_people");
const ANALYSIS_INSERT_BATCH_SIZE = 1_000;

export type GraphVisibilityFactory = (columns: {
  id: SQLWrapper;
  sensitivity: SQLWrapper;
}) => SQL;

export type GraphPersonRow = Pick<
  typeof people.$inferSelect,
  "id" | "displayName" | "sortName" | "status" | "sensitivity" | "version"
>;
export type GraphRelationshipRow = {
  id: string;
  sourcePersonId: string;
  targetPersonId: string;
  relationshipTypeId: string;
  relationshipTypeVersion: number;
  labelOverride: string | null;
  strength: string | null;
  confidence: string;
  state: string;
  sensitivity: (typeof relationships.$inferSelect)["sensitivity"];
  temporalSemantics: (typeof relationships.$inferSelect)["temporalSemantics"];
  temporalPrecision: (typeof relationships.$inferSelect)["temporalPrecision"];
  validFrom: Date | null;
  validUntil: Date | null;
  version: number;
  forwardLabel: string;
  inverseLabel: string;
  directed: boolean;
  source: GraphPersonRow;
  target: GraphPersonRow;
};

export type GraphViewRow = typeof graphViews.$inferSelect;
export type GraphViewNodeRow = typeof graphViewNodes.$inferSelect;
export type AnalysisRunRow = typeof analysisRuns.$inferSelect;
export type AnalysisResultRow = typeof analysisResults.$inferSelect;
export type GraphSnapshotRow = typeof graphSnapshots.$inferSelect;

function personSelection(
  table: typeof people | typeof sourcePeople | typeof targetPeople,
) {
  return {
    id: table.id,
    displayName: table.displayName,
    sortName: table.sortName,
    status: table.status,
    sensitivity: table.sensitivity,
    version: table.version,
  };
}

function relationshipFilter(filter: NormalizedGraphFilter) {
  const at = filter.at ? new Date(filter.at) : null;
  const from = filter.from ? new Date(filter.from) : null;
  const until = filter.until ? new Date(filter.until) : null;
  return and(
    inArray(relationships.state, [...GRAPH_RELATIONSHIP_STATES]),
    filter.relationshipTypeIds.length
      ? inArray(relationships.relationshipTypeId, filter.relationshipTypeIds)
      : undefined,
    filter.relationshipStates.length
      ? inArray(relationships.state, filter.relationshipStates)
      : undefined,
    filter.sensitivities.length
      ? inArray(relationships.sensitivity, filter.sensitivities)
      : undefined,
    filter.minimumConfidence === null
      ? undefined
      : sql`${relationships.confidence} >= ${filter.minimumConfidence}`,
    at
      ? and(
          or(isNull(relationships.validFrom), lte(relationships.validFrom, at)),
          or(
            isNull(relationships.validUntil),
            gte(relationships.validUntil, at),
          ),
        )
      : undefined,
    from
      ? or(
          isNull(relationships.validUntil),
          gte(relationships.validUntil, from),
        )
      : undefined,
    until
      ? or(isNull(relationships.validFrom), lte(relationships.validFrom, until))
      : undefined,
  );
}

function graphEdgeSelection() {
  return {
    id: relationships.id,
    sourcePersonId: relationships.sourcePersonId,
    targetPersonId: relationships.targetPersonId,
    relationshipTypeId: relationships.relationshipTypeId,
    relationshipTypeVersion: relationshipTypes.version,
    labelOverride: relationships.labelOverride,
    strength: relationships.strength,
    confidence: relationships.confidence,
    state: relationships.state,
    sensitivity: relationships.sensitivity,
    temporalSemantics: relationships.temporalSemantics,
    temporalPrecision: relationships.temporalPrecision,
    validFrom: relationships.validFrom,
    validUntil: relationships.validUntil,
    version: relationships.version,
    forwardLabel: relationshipTypes.forwardLabel,
    inverseLabel: relationshipTypes.inverseLabel,
    directed: relationshipTypes.directed,
    source: personSelection(sourcePeople),
    target: personSelection(targetPeople),
  };
}

function viewSensitivityFilter(filters: SQLWrapper, sensitivity: SQLWrapper) {
  const values = sql`CASE
    WHEN jsonb_typeof(${filters}->'sensitivities') = 'array'
      THEN ${filters}->'sensitivities'
    ELSE '[]'::jsonb
  END`;
  return sql`(
    jsonb_array_length(${values}) = 0
    OR jsonb_exists(${values}, ${sensitivity}::text)
  )`;
}

function allViewRootsVisible(input: {
  filters: SQLWrapper;
  personVisibility: GraphVisibilityFactory;
  workspaceId: string;
}) {
  const roots = sql`CASE
    WHEN jsonb_typeof(${input.filters}->'rootPersonIds') = 'array'
      THEN ${input.filters}->'rootPersonIds'
    ELSE '[]'::jsonb
  END`;
  return sql`NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(${roots}) AS graph_view_root(root_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM ${people} AS "graph_view_root_people"
      WHERE ${viewRootPeople.workspaceId} = ${input.workspaceId}::uuid
        AND ${viewRootPeople.id}::text = graph_view_root.root_id
        AND ${viewRootPeople.deletedAt} IS NULL
        AND ${input.personVisibility({
          id: viewRootPeople.id,
          sensitivity: viewRootPeople.sensitivity,
        })}
        AND ${viewSensitivityFilter(input.filters, viewRootPeople.sensitivity)}
    )
  )`;
}

function allViewPositionsVisible(input: {
  filters: SQLWrapper;
  personVisibility: GraphVisibilityFactory;
  viewId: SQLWrapper;
  workspaceId: string;
}) {
  return sql`NOT EXISTS (
    SELECT 1
    FROM ${graphViewNodes}
    WHERE ${graphViewNodes.workspaceId} = ${input.workspaceId}::uuid
      AND ${graphViewNodes.graphViewId} = ${input.viewId}
      AND NOT EXISTS (
        SELECT 1
        FROM ${people} AS "graph_view_position_people"
        WHERE ${viewPositionPeople.workspaceId} = ${graphViewNodes.workspaceId}
          AND ${viewPositionPeople.id} = ${graphViewNodes.personId}
          AND ${viewPositionPeople.deletedAt} IS NULL
          AND ${input.personVisibility({
            id: viewPositionPeople.id,
            sensitivity: viewPositionPeople.sensitivity,
          })}
          AND ${viewSensitivityFilter(
            input.filters,
            viewPositionPeople.sensitivity,
          )}
      )
  )`;
}

function viewActorAccess(actorId: string | null) {
  return actorId
    ? or(eq(graphViews.ownerId, actorId), eq(graphViews.sharing, "workspace"))
    : eq(graphViews.sharing, "workspace");
}

function allSnapshotRootsVisible(input: {
  personVisibility: GraphVisibilityFactory;
  queryInput: SQLWrapper;
  workspaceId: string;
}) {
  const roots = sql`${input.queryInput}->'rootPersonIds'`;
  return sql`(
    jsonb_typeof(${roots}) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(${roots}) AS graph_snapshot_root(root_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${people} AS "graph_snapshot_people"
        WHERE ${snapshotPeople.workspaceId} = ${input.workspaceId}::uuid
          AND ${snapshotPeople.id}::text = graph_snapshot_root.root_id
          AND ${snapshotPeople.deletedAt} IS NULL
          AND ${input.personVisibility({
            id: snapshotPeople.id,
            sensitivity: snapshotPeople.sensitivity,
          })}
          AND ${viewSensitivityFilter(
            input.queryInput,
            snapshotPeople.sensitivity,
          )}
      )
    )
  )`;
}

function allSnapshotPeopleVisible(input: {
  includedPersonVersions: SQLWrapper;
  personVisibility: GraphVisibilityFactory;
  queryInput: SQLWrapper;
  workspaceId: string;
}) {
  return sql`(
    jsonb_typeof(${input.includedPersonVersions}) = 'object'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(${input.includedPersonVersions})
        AS graph_snapshot_person(person_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${people} AS "graph_snapshot_people"
        WHERE ${snapshotPeople.workspaceId} = ${input.workspaceId}::uuid
          AND ${snapshotPeople.id}::text = graph_snapshot_person.person_id
          AND ${snapshotPeople.deletedAt} IS NULL
          AND ${input.personVisibility({
            id: snapshotPeople.id,
            sensitivity: snapshotPeople.sensitivity,
          })}
          AND ${viewSensitivityFilter(
            input.queryInput,
            snapshotPeople.sensitivity,
          )}
      )
    )
  )`;
}

function allSnapshotRelationshipsVisible(input: {
  includedRelationshipVersions: SQLWrapper;
  personVisibility: GraphVisibilityFactory;
  queryInput: SQLWrapper;
  relationshipVisibility: GraphVisibilityFactory;
  workspaceId: string;
}) {
  return sql`(
    jsonb_typeof(${input.includedRelationshipVersions}) = 'object'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(${input.includedRelationshipVersions})
        AS graph_snapshot_relationship(relationship_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${relationships} AS "graph_snapshot_relationships"
        INNER JOIN ${relationshipTypes} AS "graph_snapshot_relationship_types"
          ON ${snapshotRelationshipTypes.workspaceId} = ${snapshotRelationships.workspaceId}
          AND ${snapshotRelationshipTypes.id} = ${snapshotRelationships.relationshipTypeId}
          AND ${snapshotRelationshipTypes.deletedAt} IS NULL
        INNER JOIN ${people} AS "graph_snapshot_source_people"
          ON ${snapshotSourcePeople.workspaceId} = ${snapshotRelationships.workspaceId}
          AND ${snapshotSourcePeople.id} = ${snapshotRelationships.sourcePersonId}
          AND ${snapshotSourcePeople.deletedAt} IS NULL
          AND ${input.personVisibility({
            id: snapshotSourcePeople.id,
            sensitivity: snapshotSourcePeople.sensitivity,
          })}
          AND ${viewSensitivityFilter(
            input.queryInput,
            snapshotSourcePeople.sensitivity,
          )}
        INNER JOIN ${people} AS "graph_snapshot_target_people"
          ON ${snapshotTargetPeople.workspaceId} = ${snapshotRelationships.workspaceId}
          AND ${snapshotTargetPeople.id} = ${snapshotRelationships.targetPersonId}
          AND ${snapshotTargetPeople.deletedAt} IS NULL
          AND ${input.personVisibility({
            id: snapshotTargetPeople.id,
            sensitivity: snapshotTargetPeople.sensitivity,
          })}
          AND ${viewSensitivityFilter(
            input.queryInput,
            snapshotTargetPeople.sensitivity,
          )}
        WHERE ${snapshotRelationships.workspaceId} = ${input.workspaceId}::uuid
          AND ${snapshotRelationships.id}::text = graph_snapshot_relationship.relationship_id
          AND ${snapshotRelationships.deletedAt} IS NULL
          AND ${input.relationshipVisibility({
            id: snapshotRelationships.id,
            sensitivity: snapshotRelationships.sensitivity,
          })}
          AND ${viewSensitivityFilter(
            input.queryInput,
            snapshotRelationships.sensitivity,
          )}
      )
    )
  )`;
}

// Historical analysis is readable only while every stored root and manifest
// entity remains live and currently visible under both the actor policy and
// the snapshot's sensitivity filter. Version drift is handled by reruns.
function analysisRunAuthorization(input: {
  actorId: string | null;
  personVisibility: GraphVisibilityFactory;
  relationshipVisibility: GraphVisibilityFactory;
  workspaceId: string;
}) {
  return and(
    allSnapshotRootsVisible({
      personVisibility: input.personVisibility,
      queryInput: graphSnapshots.queryInput,
      workspaceId: input.workspaceId,
    }),
    allSnapshotPeopleVisible({
      includedPersonVersions: graphSnapshots.includedPersonVersions,
      personVisibility: input.personVisibility,
      queryInput: graphSnapshots.queryInput,
      workspaceId: input.workspaceId,
    }),
    allSnapshotRelationshipsVisible({
      includedRelationshipVersions: graphSnapshots.includedRelationshipVersions,
      personVisibility: input.personVisibility,
      queryInput: graphSnapshots.queryInput,
      relationshipVisibility: input.relationshipVisibility,
      workspaceId: input.workspaceId,
    }),
    or(
      and(isNull(graphSnapshots.graphViewId), isNull(graphViews.id)),
      and(
        isNotNull(graphViews.id),
        isNull(graphViews.deletedAt),
        viewActorAccess(input.actorId),
        allViewRootsVisible({
          filters: graphViews.filters,
          personVisibility: input.personVisibility,
          workspaceId: input.workspaceId,
        }),
        allViewPositionsVisible({
          filters: graphViews.filters,
          personVisibility: input.personVisibility,
          viewId: graphViews.id,
          workspaceId: input.workspaceId,
        }),
      ),
    ),
  );
}

function analysisRunSelection() {
  return {
    id: analysisRuns.id,
    workspaceId: analysisRuns.workspaceId,
    actorPrincipalId: analysisRuns.actorPrincipalId,
    actorKind: analysisRuns.actorKind,
    algorithm: analysisRuns.algorithm,
    algorithmVersion: analysisRuns.algorithmVersion,
    configurationHash: analysisRuns.configurationHash,
    graphSnapshotId: analysisRuns.graphSnapshotId,
    configuration: analysisRuns.configuration,
    state: analysisRuns.state,
    startedAt: analysisRuns.startedAt,
    completedAt: analysisRuns.completedAt,
    errorSummary: analysisRuns.errorSummary,
    createdAt: analysisRuns.createdAt,
    createdBy: analysisRuns.createdBy,
  };
}

export function createGraphRepository(database: Database) {
  const edges = (input: {
    workspaceId: string;
    filter: NormalizedGraphFilter;
    relationshipVisibility: GraphVisibilityFactory;
    personVisibility: GraphVisibilityFactory;
    extra?: SQL;
    limit: number;
  }) =>
    database
      .select(graphEdgeSelection())
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
        sourcePeople,
        and(
          eq(sourcePeople.workspaceId, relationships.workspaceId),
          eq(sourcePeople.id, relationships.sourcePersonId),
          isNull(sourcePeople.deletedAt),
          input.personVisibility({
            id: sourcePeople.id,
            sensitivity: sourcePeople.sensitivity,
          }),
        ),
      )
      .innerJoin(
        targetPeople,
        and(
          eq(targetPeople.workspaceId, relationships.workspaceId),
          eq(targetPeople.id, relationships.targetPersonId),
          isNull(targetPeople.deletedAt),
          input.personVisibility({
            id: targetPeople.id,
            sensitivity: targetPeople.sensitivity,
          }),
        ),
      )
      .where(
        and(
          eq(relationships.workspaceId, input.workspaceId),
          isNull(relationships.deletedAt),
          input.relationshipVisibility({
            id: relationships.id,
            sensitivity: relationships.sensitivity,
          }),
          relationshipFilter(input.filter),
          input.extra,
        ),
      )
      .orderBy(asc(relationships.id))
      .limit(input.limit);

  return {
    async listVisiblePeople(input: {
      workspaceId: string;
      filter: NormalizedGraphFilter;
      personVisibility: GraphVisibilityFactory;
      limit: number;
    }) {
      return database
        .select(personSelection(people))
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            isNull(people.deletedAt),
            input.personVisibility({
              id: people.id,
              sensitivity: people.sensitivity,
            }),
            input.filter.sensitivities.length
              ? inArray(people.sensitivity, input.filter.sensitivities)
              : undefined,
          ),
        )
        .orderBy(
          asc(sql`coalesce(${people.sortName}, ${people.displayName})`),
          asc(people.id),
        )
        .limit(input.limit);
    },
    async getVisiblePeopleByIds(input: {
      workspaceId: string;
      ids: readonly string[];
      filter: NormalizedGraphFilter;
      personVisibility: GraphVisibilityFactory;
    }) {
      if (!input.ids.length) return [];
      return database
        .select(personSelection(people))
        .from(people)
        .where(
          and(
            eq(people.workspaceId, input.workspaceId),
            inArray(people.id, [...input.ids]),
            isNull(people.deletedAt),
            input.personVisibility({
              id: people.id,
              sensitivity: people.sensitivity,
            }),
            input.filter.sensitivities.length
              ? inArray(people.sensitivity, input.filter.sensitivities)
              : undefined,
          ),
        )
        .orderBy(asc(people.id));
    },
    listVisibleIncidentEdges(input: {
      workspaceId: string;
      frontierIds: readonly string[];
      filter: NormalizedGraphFilter;
      relationshipVisibility: GraphVisibilityFactory;
      personVisibility: GraphVisibilityFactory;
      limit: number;
    }) {
      if (!input.frontierIds.length) return Promise.resolve([]);
      return edges({
        ...input,
        extra: or(
          inArray(relationships.sourcePersonId, [...input.frontierIds]),
          inArray(relationships.targetPersonId, [...input.frontierIds]),
        ),
      });
    },
    listVisibleEdgesAmongPeople(input: {
      workspaceId: string;
      personIds: readonly string[];
      filter: NormalizedGraphFilter;
      relationshipVisibility: GraphVisibilityFactory;
      personVisibility: GraphVisibilityFactory;
      limit: number;
    }) {
      if (!input.personIds.length) return Promise.resolve([]);
      return edges({
        ...input,
        extra: and(
          inArray(relationships.sourcePersonId, [...input.personIds]),
          inArray(relationships.targetPersonId, [...input.personIds]),
        ),
      });
    },
    async listViews(input: {
      workspaceId: string;
      actorId: string | null;
      personVisibility: GraphVisibilityFactory;
      limit: number;
      cursor?: { name: string; id: string } | null;
    }) {
      return database
        .select()
        .from(graphViews)
        .where(
          and(
            eq(graphViews.workspaceId, input.workspaceId),
            isNull(graphViews.deletedAt),
            viewActorAccess(input.actorId),
            allViewRootsVisible({
              filters: graphViews.filters,
              personVisibility: input.personVisibility,
              workspaceId: input.workspaceId,
            }),
            input.cursor
              ? or(
                  gt(graphViews.name, input.cursor.name),
                  and(
                    eq(graphViews.name, input.cursor.name),
                    gt(graphViews.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(graphViews.name), asc(graphViews.id))
        .limit(input.limit);
    },
    async getView(input: {
      workspaceId: string;
      id: string;
      actorId: string | null;
    }) {
      const [row] = await database
        .select()
        .from(graphViews)
        .where(
          and(
            eq(graphViews.workspaceId, input.workspaceId),
            eq(graphViews.id, input.id),
            isNull(graphViews.deletedAt),
            viewActorAccess(input.actorId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getOwnedViewForUpdate(input: {
      workspaceId: string;
      id: string;
      ownerId: string;
    }) {
      const [row] = await database
        .select()
        .from(graphViews)
        .where(
          and(
            eq(graphViews.workspaceId, input.workspaceId),
            eq(graphViews.id, input.id),
            eq(graphViews.ownerId, input.ownerId),
            isNull(graphViews.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      return row ?? null;
    },
    async createView(input: {
      workspaceId: string;
      value: Omit<typeof graphViews.$inferInsert, "workspaceId">;
    }) {
      const [row] = await database
        .insert(graphViews)
        .values({ ...input.value, workspaceId: input.workspaceId })
        .returning();
      if (!row) throw new Error("Graph view insert did not return a row");
      return row;
    },
    async updateViewIfVersion(input: {
      workspaceId: string;
      id: string;
      ownerId: string;
      expectedVersion: number;
      patch: Partial<typeof graphViews.$inferInsert>;
    }) {
      const [row] = await database
        .update(graphViews)
        .set({ ...input.patch, version: sql`${graphViews.version} + 1` })
        .where(
          and(
            eq(graphViews.workspaceId, input.workspaceId),
            eq(graphViews.id, input.id),
            eq(graphViews.ownerId, input.ownerId),
            eq(graphViews.version, input.expectedVersion),
            isNull(graphViews.deletedAt),
          ),
        )
        .returning();
      return row ?? null;
    },
    async replaceViewNodes(input: {
      workspaceId: string;
      viewId: string;
      actorId: string;
      nodes: ReadonlyArray<{
        id: string;
        personId: string;
        x: number;
        y: number;
      }>;
    }) {
      await database
        .delete(graphViewNodes)
        .where(
          and(
            eq(graphViewNodes.workspaceId, input.workspaceId),
            eq(graphViewNodes.graphViewId, input.viewId),
          ),
        );
      if (input.nodes.length)
        await database.insert(graphViewNodes).values(
          input.nodes.map((node) => ({
            id: node.id,
            workspaceId: input.workspaceId,
            graphViewId: input.viewId,
            personId: node.personId,
            positionX: String(node.x),
            positionY: String(node.y),
            createdBy: input.actorId,
            updatedBy: input.actorId,
          })),
        );
    },
    async viewNodes(input: {
      workspaceId: string;
      viewId: string;
      afterPersonId?: string | null;
      limit: number;
    }) {
      return database
        .select()
        .from(graphViewNodes)
        .where(
          and(
            eq(graphViewNodes.workspaceId, input.workspaceId),
            eq(graphViewNodes.graphViewId, input.viewId),
            input.afterPersonId
              ? gt(graphViewNodes.personId, input.afterPersonId)
              : undefined,
          ),
        )
        .orderBy(asc(graphViewNodes.personId))
        .limit(input.limit);
    },
    async visibleViewNodes(input: {
      workspaceId: string;
      viewId: string;
      afterPersonId?: string | null;
      filter: NormalizedGraphFilter;
      personVisibility: GraphVisibilityFactory;
      limit: number;
    }) {
      return database
        .select({
          personId: graphViewNodes.personId,
          positionX: graphViewNodes.positionX,
          positionY: graphViewNodes.positionY,
        })
        .from(graphViewNodes)
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, graphViewNodes.workspaceId),
            eq(people.id, graphViewNodes.personId),
            isNull(people.deletedAt),
            input.personVisibility({
              id: people.id,
              sensitivity: people.sensitivity,
            }),
            input.filter.sensitivities.length
              ? inArray(people.sensitivity, input.filter.sensitivities)
              : undefined,
          ),
        )
        .where(
          and(
            eq(graphViewNodes.workspaceId, input.workspaceId),
            eq(graphViewNodes.graphViewId, input.viewId),
            input.afterPersonId
              ? gt(graphViewNodes.personId, input.afterPersonId)
              : undefined,
          ),
        )
        .orderBy(asc(graphViewNodes.personId))
        .limit(input.limit);
    },
    async insertSnapshot(input: typeof graphSnapshots.$inferInsert) {
      if (!validateStoredGraphSnapshotManifest(input).valid)
        throw new Error("The graph snapshot manifest is invalid.");
      const [row] = await database
        .insert(graphSnapshots)
        .values(input)
        .returning();
      if (!row) throw new Error("Graph snapshot insert did not return a row");
      if (!validateStoredGraphSnapshotManifest(row).valid)
        throw new Error("The graph snapshot manifest is invalid.");
      return row;
    },
    async getSnapshot(input: { workspaceId: string; id: string }) {
      const [row] = await database
        .select()
        .from(graphSnapshots)
        .where(
          and(
            eq(graphSnapshots.workspaceId, input.workspaceId),
            eq(graphSnapshots.id, input.id),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getReplayableSnapshot(input: {
      workspaceId: string;
      id: string;
      actorPrincipalId: string;
      actorKind: "USER" | "API_KEY";
    }) {
      const [row] = await database
        .select()
        .from(graphSnapshots)
        .where(
          and(
            eq(graphSnapshots.workspaceId, input.workspaceId),
            eq(graphSnapshots.id, input.id),
            eq(graphSnapshots.actorPrincipalId, input.actorPrincipalId),
            eq(graphSnapshots.actorKind, input.actorKind),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async getAuthorizedSnapshot(input: {
      workspaceId: string;
      id: string;
      actorId: string | null;
      personVisibility: GraphVisibilityFactory;
      relationshipVisibility: GraphVisibilityFactory;
    }) {
      const [row] = await database
        .select({ snapshot: graphSnapshots })
        .from(graphSnapshots)
        .leftJoin(
          graphViews,
          and(
            eq(graphViews.workspaceId, graphSnapshots.workspaceId),
            eq(graphViews.id, graphSnapshots.graphViewId),
          ),
        )
        .where(
          and(
            eq(graphSnapshots.workspaceId, input.workspaceId),
            eq(graphSnapshots.id, input.id),
            analysisRunAuthorization(input),
          ),
        )
        .limit(1);
      return row?.snapshot ?? null;
    },
    async insertAnalysisRun(input: typeof analysisRuns.$inferInsert) {
      const [row] = await database
        .insert(analysisRuns)
        .values(input)
        .returning();
      if (!row) throw new Error("Analysis run insert did not return a row");
      return row;
    },
    async finalizeAnalysisRun(input: {
      completedAt: Date;
      id: string;
      workspaceId: string;
    }) {
      const [row] = await database
        .update(analysisRuns)
        .set({ state: "completed", completedAt: input.completedAt })
        .where(
          and(
            eq(analysisRuns.workspaceId, input.workspaceId),
            eq(analysisRuns.id, input.id),
            eq(analysisRuns.state, "running"),
            isNull(analysisRuns.completedAt),
          ),
        )
        .returning();
      if (!row) throw new Error("Analysis run finalize failed.");
      return row;
    },
    async insertAnalysisResults(
      values: Array<typeof analysisResults.$inferInsert>,
    ) {
      for (
        let offset = 0;
        offset < values.length;
        offset += ANALYSIS_INSERT_BATCH_SIZE
      )
        await database
          .insert(analysisResults)
          .values(values.slice(offset, offset + ANALYSIS_INSERT_BATCH_SIZE));
    },
    async insertPersonMetrics(
      values: Array<typeof personMetrics.$inferInsert>,
    ) {
      for (
        let offset = 0;
        offset < values.length;
        offset += ANALYSIS_INSERT_BATCH_SIZE
      )
        await database
          .insert(personMetrics)
          .values(values.slice(offset, offset + ANALYSIS_INSERT_BATCH_SIZE));
    },
    async getAuthorizedAnalysisRun(input: {
      workspaceId: string;
      id: string;
      actorId: string | null;
      personVisibility: GraphVisibilityFactory;
      relationshipVisibility: GraphVisibilityFactory;
    }) {
      const [row] = await database
        .select(analysisRunSelection())
        .from(analysisRuns)
        .innerJoin(
          graphSnapshots,
          and(
            eq(graphSnapshots.workspaceId, analysisRuns.workspaceId),
            eq(graphSnapshots.id, analysisRuns.graphSnapshotId),
          ),
        )
        .leftJoin(
          graphViews,
          and(
            eq(graphViews.workspaceId, graphSnapshots.workspaceId),
            eq(graphViews.id, graphSnapshots.graphViewId),
          ),
        )
        .where(
          and(
            eq(analysisRuns.workspaceId, input.workspaceId),
            eq(analysisRuns.id, input.id),
            analysisRunAuthorization(input),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async listAnalysisRuns(input: {
      workspaceId: string;
      actorId: string | null;
      afterId?: string | null;
      personVisibility: GraphVisibilityFactory;
      relationshipVisibility: GraphVisibilityFactory;
      limit: number;
    }) {
      return database
        .select(analysisRunSelection())
        .from(analysisRuns)
        .innerJoin(
          graphSnapshots,
          and(
            eq(graphSnapshots.workspaceId, analysisRuns.workspaceId),
            eq(graphSnapshots.id, analysisRuns.graphSnapshotId),
          ),
        )
        .leftJoin(
          graphViews,
          and(
            eq(graphViews.workspaceId, graphSnapshots.workspaceId),
            eq(graphViews.id, graphSnapshots.graphViewId),
          ),
        )
        .where(
          and(
            eq(analysisRuns.workspaceId, input.workspaceId),
            input.afterId ? gt(analysisRuns.id, input.afterId) : undefined,
            analysisRunAuthorization(input),
          ),
        )
        .orderBy(asc(analysisRuns.id))
        .limit(input.limit);
    },
    async getAnalysisResults(input: {
      workspaceId: string;
      runId: string;
      after?: { id: string; rank: number | null } | null;
      personVisibility: GraphVisibilityFactory;
      limit: number;
    }) {
      return database
        .select({
          id: analysisResults.id,
          analysisRunId: analysisResults.analysisRunId,
          resultKind: analysisResults.resultKind,
          payloadHash: analysisResults.payloadHash,
          payloadSchema: analysisResults.payloadSchema,
          subjectPersonId: analysisResults.subjectPersonId,
          numericValue: analysisResults.numericValue,
          rank: analysisResults.rank,
          explanation: analysisResults.explanation,
          createdAt: analysisResults.createdAt,
        })
        .from(analysisResults)
        .innerJoin(
          people,
          and(
            eq(people.workspaceId, analysisResults.workspaceId),
            eq(people.id, analysisResults.subjectPersonId),
            isNull(people.deletedAt),
            input.personVisibility({
              id: people.id,
              sensitivity: people.sensitivity,
            }),
          ),
        )
        .where(
          and(
            eq(analysisResults.workspaceId, input.workspaceId),
            eq(analysisResults.analysisRunId, input.runId),
            input.after
              ? input.after.rank === null
                ? and(
                    isNull(analysisResults.rank),
                    gt(analysisResults.id, input.after.id),
                  )
                : or(
                    gt(analysisResults.rank, input.after.rank),
                    isNull(analysisResults.rank),
                    and(
                      eq(analysisResults.rank, input.after.rank),
                      gt(analysisResults.id, input.after.id),
                    ),
                  )
              : undefined,
          ),
        )
        .orderBy(asc(analysisResults.rank), asc(analysisResults.id))
        .limit(input.limit);
    },
  };
}
