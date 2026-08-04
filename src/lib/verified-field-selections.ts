import type { FactSummaryFragment } from "@/graphql/generated/graphql";
import { readOpaqueCursor } from "@/lib/research-pagination";

export type FieldSelectionPage = {
  nodes: readonly ({
    namespace?: string | null;
    fieldKey?: string | null;
    factId?: string | null;
    version?: number | null;
  } | null)[];
  hasNextPage: boolean;
  endCursor?: string | null;
};

export type VerifiedFieldSelections = {
  byField: Map<string, { factId: string; version: number | null }>;
  verified: boolean;
};

/**
 * Reads every page needed to verify the presentation selection for the facts
 * currently displayed. Cursor cycles, malformed cursors, missing connections,
 * and the defensive page ceiling all fail closed so the UI never offers a
 * selection action based on incomplete authority data.
 */
export async function readVerifiedFieldSelections(
  facts: readonly Pick<FactSummaryFragment, "namespace" | "fieldKey">[],
  loadPage: (after: string | undefined) => Promise<FieldSelectionPage | null>,
  maxPages = 25,
): Promise<VerifiedFieldSelections> {
  const needed = new Set(
    facts.flatMap((fact) =>
      fact.namespace && fact.fieldKey
        ? [`${fact.namespace}:${fact.fieldKey}`]
        : [],
    ),
  );
  const byField = new Map<string, { factId: string; version: number | null }>();
  let after: string | undefined;
  const seen = new Set<string>();

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await loadPage(after);
    if (!page) return { byField, verified: false };
    for (const selection of page.nodes) {
      if (selection?.namespace && selection.fieldKey && selection.factId) {
        byField.set(`${selection.namespace}:${selection.fieldKey}`, {
          factId: selection.factId,
          version: selection.version ?? null,
        });
      }
    }
    if ([...needed].every((key) => byField.has(key))) {
      return { byField, verified: true };
    }
    if (!page.hasNextPage) return { byField, verified: true };
    const next = readOpaqueCursor(page.endCursor ?? undefined);
    if (!next || next === after || seen.has(next)) {
      return { byField, verified: false };
    }
    seen.add(next);
    after = next;
  }
  return { byField, verified: false };
}
