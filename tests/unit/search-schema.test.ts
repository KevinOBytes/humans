import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { queryRuns, savedQueries, searchDocuments } from "@/db/schema/search";

describe("Task 12 search persistence contract", () => {
  it("stores bounded source contributions with a maintained weighted vector", () => {
    const config = getTableConfig(searchDocuments);
    expect(config.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "source_kind",
        "source_id",
        "source_version",
        "chunk_ordinal",
        "result_kind",
        "result_id",
        "subject_person_id",
        "sensitivity",
        "document_schema_version",
        "title_text",
        "body_text",
        "display_text",
        "search_vector",
      ]),
    );
    expect(
      config.columns.find(({ name }) => name === "search_vector")?.generated,
    ).toMatchObject({ type: "always", mode: "stored" });
    expect(config.indexes.map(({ config: { name } }) => name)).toEqual(
      expect.arrayContaining([
        "search_documents_search_vector_gin",
        "search_documents_workspace_result_page_idx",
        "search_documents_workspace_source_idx",
      ]),
    );
  });

  it("persists only closed saved ASTs and principal-attributed runs", () => {
    const saved = getTableConfig(savedQueries);
    expect(saved.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "owner_principal_id",
        "query_ast",
        "ast_version",
        "query_hash",
        "version",
        "archived_at",
      ]),
    );
    expect(saved.columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([
        "graphql_document",
        "variables",
        "structured_filter",
      ]),
    );

    const runs = getTableConfig(queryRuns);
    expect(runs.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "actor_principal_id",
        "actor_kind",
        "query_hash",
        "outcome",
      ]),
    );
    expect(runs.columns.map(({ name }) => name)).not.toContain("actor_id");
  });
});
