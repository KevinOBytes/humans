"use client";

import { createElement, useMemo } from "react";

import { executeBrowserGraphQL } from "@/graphql/client";
import {
  useFragment as readFragment,
  type FragmentType,
} from "@/graphql/generated/fragment-masking";
import {
  SearchWorkbenchArchiveSavedQueryDocument,
  SearchWorkbenchCreateSavedQueryDocument,
  SearchWorkbenchHitFragmentDoc,
  SearchWorkbenchPageFragmentDoc,
  SearchWorkbenchRunSavedQueryDocument,
  SearchWorkbenchSavedQueriesDocument,
  SearchWorkbenchSavedQueryByIdDocument,
  SearchWorkbenchSavedQueryFragmentDoc,
  SearchWorkbenchSearchDocument,
  SearchWorkbenchUpdateSavedQueryDocument,
  type SearchWorkbenchPageFragment,
  type SearchWorkbenchSavedQueryFragment,
} from "@/graphql/generated/graphql";

import type {
  SearchWorkbenchAdapter,
  SearchWorkbenchPage,
  SearchWorkbenchSavedPage,
  SearchWorkbenchSavedQuery,
} from "./search-workbench";
import { SearchWorkbench } from "./search-workbench";

class SearchWorkbenchRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The search request could not be completed.");
    this.name = "SearchWorkbenchRequestError";
    this.code = code;
  }
}

function failed(errors: readonly { code: string }[]): never {
  throw new SearchWorkbenchRequestError(errors[0]?.code ?? "INTERNAL");
}

function required<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined)
    throw new SearchWorkbenchRequestError(`INVALID_RESPONSE_${field}`);
  return value;
}

function page(
  value: SearchWorkbenchPageFragment | null | undefined,
): SearchWorkbenchPage {
  const connection = required(value, "PAGE");
  const nodes = readFragment(
    SearchWorkbenchHitFragmentDoc,
    required(connection.nodes, "NODES"),
  );
  const pageInfo = required(connection.pageInfo, "PAGE_INFO");
  return {
    nodes: nodes.map((hit, index) => ({
      id: required(hit.id, `HIT_${index}_ID`),
      kind: required(hit.kind, `HIT_${index}_KIND`),
      rank: hit.rank ?? null,
      snippet: required(hit.snippet, `HIT_${index}_SNIPPET`).map(
        (part, partIndex) => ({
          matched: required(
            part.matched,
            `HIT_${index}_SNIPPET_${partIndex}_MATCHED`,
          ),
          text: required(part.text, `HIT_${index}_SNIPPET_${partIndex}_TEXT`),
        }),
      ),
      title: required(hit.title, `HIT_${index}_TITLE`),
      updatedAt: required(hit.updatedAt, `HIT_${index}_UPDATED_AT`),
    })),
    pageInfo: {
      endCursor: pageInfo.endCursor ?? null,
      hasNextPage: pageInfo.hasNextPage,
    },
  };
}

function saved(
  value: SearchWorkbenchSavedQueryFragment | null | undefined,
): SearchWorkbenchSavedQuery {
  const row = required(value, "SAVED_QUERY");
  return {
    archivedAt: row.archivedAt ?? null,
    createdAt: required(row.createdAt, "SAVED_QUERY_CREATED_AT"),
    id: required(row.id, "SAVED_QUERY_ID"),
    name: required(row.name, "SAVED_QUERY_NAME"),
    ownerPrincipalId: required(
      row.ownerPrincipalId,
      "SAVED_QUERY_OWNER_PRINCIPAL_ID",
    ),
    queryAst: row.queryAst,
    sharing: required(row.sharing, "SAVED_QUERY_SHARING"),
    updatedAt: required(row.updatedAt, "SAVED_QUERY_UPDATED_AT"),
    version: required(row.version, "SAVED_QUERY_VERSION"),
  };
}

function savedPage(
  value: readonly FragmentType<typeof SearchWorkbenchSavedQueryFragmentDoc>[],
  pageInfo: { endCursor: string | null; hasNextPage: boolean } | null,
): SearchWorkbenchSavedPage {
  return {
    nodes: readFragment(SearchWorkbenchSavedQueryFragmentDoc, value).map(saved),
    pageInfo: {
      endCursor: required(pageInfo, "SAVED_PAGE_INFO").endCursor ?? null,
      hasNextPage: required(pageInfo, "SAVED_PAGE_INFO").hasNextPage,
    },
  };
}

export function createBrowserSearchWorkbenchAdapter(): SearchWorkbenchAdapter {
  return {
    async archiveSaved(id, expectedVersion) {
      const response = await executeBrowserGraphQL(
        SearchWorkbenchArchiveSavedQueryDocument,
        { expectedVersion, id },
      );
      if (!response.ok) return failed(response.errors);
      return response.data.archiveSavedQuery
        ? saved(
            readFragment(
              SearchWorkbenchSavedQueryFragmentDoc,
              response.data.archiveSavedQuery,
            ),
          )
        : null;
    },
    async createSaved(input) {
      const response = await executeBrowserGraphQL(
        SearchWorkbenchCreateSavedQueryDocument,
        { input },
      );
      if (!response.ok) return failed(response.errors);
      return response.data.createSavedQuery
        ? saved(
            readFragment(
              SearchWorkbenchSavedQueryFragmentDoc,
              response.data.createSavedQuery,
            ),
          )
        : null;
    },
    async listSaved(after) {
      const response = await executeBrowserGraphQL(
        SearchWorkbenchSavedQueriesDocument,
        { first: 25, ...(after ? { after } : {}) },
      );
      if (!response.ok) return failed(response.errors);
      return savedPage(
        required(response.data.savedQueries.nodes, "SAVED_NODES"),
        response.data.savedQueries.pageInfo,
      );
    },
    async readSaved(id) {
      const response = await executeBrowserGraphQL(
        SearchWorkbenchSavedQueryByIdDocument,
        { id },
      );
      if (!response.ok) return failed(response.errors);
      return response.data.savedQuery
        ? saved(
            readFragment(
              SearchWorkbenchSavedQueryFragmentDoc,
              response.data.savedQuery,
            ),
          )
        : null;
    },
    async runSaved(id) {
      const response = await executeBrowserGraphQL(
        SearchWorkbenchRunSavedQueryDocument,
        { id },
      );
      if (!response.ok) return failed(response.errors);
      return page(
        response.data.runSavedQuery
          ? readFragment(
              SearchWorkbenchPageFragmentDoc,
              response.data.runSavedQuery,
            )
          : null,
      );
    },
    async search(input) {
      const response = await executeBrowserGraphQL(
        SearchWorkbenchSearchDocument,
        { input },
      );
      if (!response.ok) return failed(response.errors);
      return page(
        readFragment(SearchWorkbenchPageFragmentDoc, response.data.search),
      );
    },
    async updateSaved(input) {
      const response = await executeBrowserGraphQL(
        SearchWorkbenchUpdateSavedQueryDocument,
        { input },
      );
      if (!response.ok) return failed(response.errors);
      return response.data.updateSavedQuery
        ? saved(
            readFragment(
              SearchWorkbenchSavedQueryFragmentDoc,
              response.data.updateSavedQuery,
            ),
          )
        : null;
    },
  };
}

export function BrowserSearchWorkbench(props: {
  canManageSaved: boolean;
  viewerPrincipalId: string;
  workspaceIdentity: string;
}) {
  const adapter = useMemo(() => createBrowserSearchWorkbenchAdapter(), []);
  return createElement(SearchWorkbench, { ...props, adapter });
}
