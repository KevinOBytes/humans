import "server-only";

import type { Database } from "@/modules/auth/bootstrap-admin";

export const SEARCH_INDEX_SOURCE_KINDS = [
  "person",
  "person_name",
  "fact_definition",
  "fact",
  "relationship_type",
  "relationship",
  "source",
  "person_address",
  "evidence_item",
  "evidence_excerpt",
  "note",
] as const;

export type SearchIndexMutation = Readonly<{
  action: "upsert" | "remove";
  sourceId: string;
  sourceKind: (typeof SEARCH_INDEX_SOURCE_KINDS)[number];
  sourceVersion: number;
  workspaceId: string;
}>;

export interface SearchIndexMaintenance {
  readonly mode: "disabled" | "transactional";
  apply(
    database: Database,
    mutations: readonly SearchIndexMutation[],
  ): Promise<void>;
}

export const disabledSearchIndexMaintenance: SearchIndexMaintenance =
  Object.freeze({
    mode: "disabled" as const,
    async apply(): Promise<void> {},
  });
