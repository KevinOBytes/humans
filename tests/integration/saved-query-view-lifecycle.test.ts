// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ArchiveGraphViewDocument,
  CreateGraphViewDocument,
  GraphSavedViewPageDocument,
  GraphWorkspaceControlsDocument,
  SearchWorkbenchArchiveSavedQueryDocument,
  SearchWorkbenchCreateSavedQueryDocument,
  SearchWorkbenchRunSavedQueryDocument,
  SearchWorkbenchSavedQueriesDocument,
  SearchWorkbenchSavedQueryByIdDocument,
  SearchWorkbenchUpdateSavedQueryDocument,
  UpdateGraphViewDocument,
} from "@/graphql/generated/graphql";

import { expectGraphQLError, type OperationResult } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function dataField<T>(
  result: OperationResult<Record<string, T>>,
  field: string,
): T {
  expect(result.body?.errors).toBeUndefined();
  const value = result.body?.data?.[field];
  if (value == null) throw new Error(`Missing GraphQL field ${field}`);
  return value;
}

const savedSearchAst = {
  filters: {},
  kinds: ["PERSON"],
  match: { query: "lifecycle needle", type: "text" },
  pageSize: 10,
  schema: "humans.search-query",
  version: 1,
};

const graphFilter = {
  edgeLimit: 10,
  includeIsolates: true,
  mode: "WORKSPACE" as const,
  nodeLimit: 10,
};

liveDescribe("saved-query and graph-view lifecycle release matrix", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("enforces ownership, workspace sharing, optimistic versions, archive exclusion, and tenant isolation", async () => {
    const owner = await fixture.createActor();
    const member = await fixture.createWorkspaceMember(owner, "analyst");
    const foreign = await fixture.createActor();

    const saved = dataField<{
      id: string;
      sharing: string;
      version: number;
    }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "SearchWorkbenchCreateSavedQuery",
        query: SearchWorkbenchCreateSavedQueryDocument,
        variables: {
          input: {
            name: "Lifecycle saved query",
            queryAst: savedSearchAst,
            sharing: "WORKSPACE",
          },
        },
      }),
      "createSavedQuery",
    );
    expect(saved).toMatchObject({ sharing: "WORKSPACE", version: 1 });

    const memberSavedQueries = dataField<{ nodes: Array<{ id: string }> }>(
      await fixture.execute({
        jar: member.jar,
        operationName: "SearchWorkbenchSavedQueries",
        query: SearchWorkbenchSavedQueriesDocument,
        variables: { first: 10 },
      }),
      "savedQueries",
    );
    expect(memberSavedQueries.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: saved.id })]),
    );

    expectGraphQLError(
      await fixture.execute({
        jar: member.jar,
        operationName: "SearchWorkbenchUpdateSavedQuery",
        query: SearchWorkbenchUpdateSavedQueryDocument,
        variables: {
          input: {
            expectedVersion: saved.version,
            id: saved.id,
            name: "Member cannot update",
          },
        },
      }),
      "CONFLICT",
    );

    const updatedSaved = dataField<{ name: string; version: number }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "SearchWorkbenchUpdateSavedQuery",
        query: SearchWorkbenchUpdateSavedQueryDocument,
        variables: {
          input: {
            expectedVersion: saved.version,
            id: saved.id,
            name: "Lifecycle saved query updated",
          },
        },
      }),
      "updateSavedQuery",
    );
    expect(updatedSaved).toEqual(
      expect.objectContaining({
        name: "Lifecycle saved query updated",
        version: 2,
      }),
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "SearchWorkbenchUpdateSavedQuery",
        query: SearchWorkbenchUpdateSavedQueryDocument,
        variables: {
          input: {
            expectedVersion: saved.version,
            id: saved.id,
            name: "Stale saved query update",
          },
        },
      }),
      "CONFLICT",
    );
    expect(
      (
        await fixture.execute({
          jar: foreign.jar,
          operationName: "SearchWorkbenchSavedQueryById",
          query: SearchWorkbenchSavedQueryByIdDocument,
          variables: { id: saved.id },
        })
      ).body,
    ).toEqual({ data: { savedQuery: null } });

    const archivedSaved = dataField<{ archivedAt: string; version: number }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "SearchWorkbenchArchiveSavedQuery",
        query: SearchWorkbenchArchiveSavedQueryDocument,
        variables: { expectedVersion: updatedSaved.version, id: saved.id },
      }),
      "archiveSavedQuery",
    );
    expect(archivedSaved).toMatchObject({ version: 3 });
    expect(archivedSaved.archivedAt).toBeTruthy();
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "SearchWorkbenchRunSavedQuery",
        query: SearchWorkbenchRunSavedQueryDocument,
        variables: { id: saved.id },
      }),
      "NOT_FOUND",
    );
    expect(
      dataField<{ nodes: Array<{ id: string }> }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "SearchWorkbenchSavedQueries",
          query: SearchWorkbenchSavedQueriesDocument,
          variables: { first: 10 },
        }),
        "savedQueries",
      ).nodes,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: saved.id })]),
    );

    const view = dataField<{
      id: string;
      sharing: string;
      version: number;
    }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "CreateGraphView",
        query: CreateGraphViewDocument,
        variables: {
          input: {
            filter: graphFilter,
            name: "Lifecycle graph view",
            sharing: "WORKSPACE",
          },
        },
      }),
      "createGraphView",
    );
    expect(view).toMatchObject({ sharing: "WORKSPACE", version: 1 });
    expect(
      dataField<{ nodes: Array<{ id: string }> }>(
        await fixture.execute({
          jar: member.jar,
          operationName: "GraphWorkspaceControls",
          query: GraphWorkspaceControlsDocument,
          variables: { viewsFirst: 10 },
        }),
        "graphViews",
      ).nodes,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: view.id })]),
    );

    expectGraphQLError(
      await fixture.execute({
        jar: member.jar,
        operationName: "UpdateGraphView",
        query: UpdateGraphViewDocument,
        variables: {
          input: {
            expectedVersion: view.version,
            id: view.id,
            name: "Member cannot update",
          },
        },
      }),
      "NOT_FOUND",
    );
    const updatedView = dataField<{ name: string; version: number }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "UpdateGraphView",
        query: UpdateGraphViewDocument,
        variables: {
          input: {
            expectedVersion: view.version,
            id: view.id,
            name: "Lifecycle graph view updated",
          },
        },
      }),
      "updateGraphView",
    );
    expect(updatedView).toEqual(
      expect.objectContaining({
        name: "Lifecycle graph view updated",
        version: 2,
      }),
    );
    expectGraphQLError(
      await fixture.execute({
        jar: owner.jar,
        operationName: "UpdateGraphView",
        query: UpdateGraphViewDocument,
        variables: {
          input: {
            expectedVersion: view.version,
            id: view.id,
            name: "Stale graph view update",
          },
        },
      }),
      "CONFLICT",
    );
    expect(
      (
        await fixture.execute({
          jar: foreign.jar,
          operationName: "GraphSavedViewPage",
          query: GraphSavedViewPageDocument,
          variables: { id: view.id },
        })
      ).body,
    ).toEqual({ data: { graphView: null } });

    const archivedView = dataField<{ id: string; version: number }>(
      await fixture.execute({
        jar: owner.jar,
        operationName: "ArchiveGraphView",
        query: ArchiveGraphViewDocument,
        variables: {
          input: { expectedVersion: updatedView.version, id: view.id },
        },
      }),
      "archiveGraphView",
    );
    expect(archivedView).toEqual({ id: view.id, version: 3 });
    expect(
      (
        await fixture.execute({
          jar: owner.jar,
          operationName: "GraphSavedViewPage",
          query: GraphSavedViewPageDocument,
          variables: { id: view.id },
        })
      ).body,
    ).toEqual({ data: { graphView: null } });
    expect(
      dataField<{ nodes: Array<{ id: string }> }>(
        await fixture.execute({
          jar: owner.jar,
          operationName: "GraphWorkspaceControls",
          query: GraphWorkspaceControlsDocument,
          variables: { viewsFirst: 10 },
        }),
        "graphViews",
      ).nodes,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: view.id })]),
    );
  });
});
