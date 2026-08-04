import { notFound } from "next/navigation";

import { getAppContext } from "@/app/(app)/app-session";
import { GraphExplorer } from "@/components/graph/graph-explorer";
import type { GraphSavedViewSummary } from "@/components/graph/graph-saved-views";
import {
  graphPageResult,
  savedViewGraphFilter,
  savedViewPositions,
} from "@/components/graph/graph-page-model";
import { useFragment as readFragment } from "@/graphql/generated/fragment-masking";
import {
  GraphPageDocument,
  GraphSavedViewPageDocument,
  PageDetailsFragmentDoc,
  RelationshipTypeOptionsDocument,
  type GraphFilterInput,
} from "@/graphql/generated/graphql";
import { executeServerGraphQL } from "@/graphql/server-client";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// The GraphQL complexity gate permits this catalog at the standard UI page size.
const PAGE_SIZE = 25;
const POSITION_PAGE_SIZE = 250;

async function loadSavedView(id: string) {
  const data = await executeServerGraphQL(GraphSavedViewPageDocument, {
    id,
    positionsFirst: POSITION_PAGE_SIZE,
  });
  if (!data.graphView) return null;
  return {
    positions: savedViewPositions(data.graphView),
    positionsTruncated: data.graphView.positions.pageInfo.hasNextPage,
    view: data.graphView,
  };
}

async function loadRelationshipTypes() {
  const data = await executeServerGraphQL(RelationshipTypeOptionsDocument, {
    first: PAGE_SIZE,
  });
  if (!data.relationshipTypes) return { options: [], truncated: false };
  const options = (data.relationshipTypes.nodes ?? []).map(
    (relationshipType) => {
      if (!relationshipType.id || !relationshipType.forwardLabel) {
        throw new Error(
          "The relationship type catalog response was incomplete.",
        );
      }
      return {
        id: relationshipType.id,
        label: relationshipType.forwardLabel,
      };
    },
  );
  const pageInfo = readFragment(
    PageDetailsFragmentDoc,
    data.relationshipTypes.pageInfo,
  );
  if (!pageInfo)
    throw new Error("The relationship type catalog omitted page information.");
  return {
    options: options.sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id),
    ),
    truncated: pageInfo.hasNextPage,
  };
}

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAppContext();
  if (!context.viewer) return null;
  const params = await searchParams;
  const requestedView =
    typeof params.view === "string" && UUID_PATTERN.test(params.view)
      ? params.view
      : null;
  if (params.view !== undefined && !requestedView) notFound();

  let filter: GraphFilterInput = {
    mode: "WORKSPACE",
    nodeLimit: 1_000,
    edgeLimit: 4_000,
    includeIsolates: false,
  };
  let positions: ReturnType<typeof savedViewPositions> = [];
  let positionsTruncated = false;
  let initialSavedView: GraphSavedViewSummary | null = null;
  let layoutAlgorithm: "CIRCLE" | "FORCE_ATLAS_2" = "CIRCLE";
  if (requestedView) {
    const saved = await loadSavedView(requestedView);
    if (!saved) notFound();
    filter = savedViewGraphFilter(saved.view);
    positions = saved.positions;
    positionsTruncated = saved.positionsTruncated;
    if (
      !saved.view.id ||
      !saved.view.name ||
      !saved.view.sharing ||
      saved.view.version == null
    ) {
      throw new Error("The saved graph view metadata was incomplete.");
    }
    initialSavedView = {
      id: saved.view.id,
      name: saved.view.name,
      sharing: saved.view.sharing,
      version: saved.view.version,
    };
    if (saved.view.layout?.algorithm === "FORCE_ATLAS_2") {
      layoutAlgorithm = "FORCE_ATLAS_2";
    }
  }

  const [data, relationshipCatalog] = await Promise.all([
    executeServerGraphQL(GraphPageDocument, { filter }),
    loadRelationshipTypes(),
  ]);
  if (!data.graph) throw new Error("The authorized graph was not returned.");
  const result = graphPageResult(data.graph);
  const permissions = context.viewer.permissions;
  return (
    <GraphExplorer
      workspaceIdentity={context.viewer.workspace.id}
      result={result}
      initialLayoutAlgorithm={layoutAlgorithm}
      initialPositions={positions}
      initialPositionsTruncated={positionsTruncated}
      initialSavedView={initialSavedView}
      initialViewId={requestedView}
      relationshipTypes={relationshipCatalog.options}
      relationshipTypesTruncated={relationshipCatalog.truncated}
      canArchiveRelationships={permissions.includes("relationship:delete")}
      canArchiveViews={permissions.includes("graphView:delete")}
      canCreateRelationships={permissions.includes("relationship:create")}
      canReadAnalysis={permissions.includes("analysis:read")}
      canReadViews={permissions.includes("graphView:read")}
      canRunAnalysis={["graph:run", "analysis:create", "analysis:run"].every(
        (permission) => permissions.includes(permission),
      )}
      canSaveViews={permissions.includes("graphView:create")}
      canUpdateRelationships={permissions.includes("relationship:update")}
      canUpdateViews={permissions.includes("graphView:update")}
    />
  );
}
