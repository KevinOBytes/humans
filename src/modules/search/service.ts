import "server-only";

import { sql } from "drizzle-orm";
import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import type { RequestOperationLimiter } from "@/graphql/operation-limiter";
import type { ProtectedExactInput } from "@/lib/security/protected-exact";
import {
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import type { Database } from "@/modules/auth/bootstrap-admin";
import { createProtectedExactLookupService } from "@/modules/people/protected-exact-service";

import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchQueryBinding,
} from "./cursor";
import type { Task12Metrics } from "./metrics";
import {
  canonicalSearchJson,
  foldSearchDiacritics,
  normalizeSearchInput,
  normalizedSearchWorkCost,
  type NormalizedSearchInput,
} from "./normalization";
import { createSearchRepository } from "./repository";
import { createSavedQueryService } from "./saved-query";
import type { SearchConnection, SearchSnippetPart } from "./types";

const SEARCH_POLICY = {
  capacity: 2_000,
  refillAmount: 2_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;
const SEARCH_CLIENT_POLICY = {
  capacity: 4_000,
  refillAmount: 4_000,
  refillIntervalMs: 60_000,
  ttlMs: 60_000,
} as const;

export type SearchRuntime = Readonly<{
  cursorHmacKey: string;
  encryptionKey?: string;
  protectedLookupHmacKey: string;
}>;

export type SearchServiceContext = ResearchServiceContext & {
  metrics: Task12Metrics;
  operationLimiter: RequestOperationLimiter;
};

function permissionForKind(
  kind: NormalizedSearchInput["kinds"][number],
): readonly string[] {
  if (kind === "PERSON" || kind === "ADDRESS") return ["person:read"];
  if (kind === "FACT") return ["fact:read", "person:read"];
  if (kind === "RELATIONSHIP") return ["relationship:read", "person:read"];
  return ["evidence:read", "source:read"];
}

function queryMaterial(input: NormalizedSearchInput) {
  return canonicalSearchJson({
    filters: input.filters,
    kinds: input.kinds,
    match: input.match,
    version: input.version,
  });
}

function positiveTerms(query: string): string[] {
  const terms = new Map<string, string>();
  let offset = 0;
  while (offset < query.length && terms.size < 16) {
    while (/\s/u.test(query[offset] ?? "")) offset += 1;
    const negative = query[offset] === "-";
    if (negative) offset += 1;
    let token = "";
    const quoted = query[offset] === '"';
    if (quoted) {
      const end = query.indexOf('"', offset + 1);
      token = query.slice(offset + 1, end < 0 ? query.length : end);
      offset = end < 0 ? query.length : end + 1;
    } else {
      const start = offset;
      while (offset < query.length && !/\s/u.test(query[offset] ?? ""))
        offset += 1;
      token = query.slice(start, offset);
    }
    if (negative || (!quoted && /^or$/iu.test(token))) continue;
    for (const term of token.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}_']*/gu) ??
      []) {
      terms.set(term.toLocaleLowerCase("und"), term);
      if (terms.size >= 16) break;
    }
  }
  return [...terms.values()].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function buildSearchSnippet(
  text: string,
  query: string,
): readonly SearchSnippetPart[] {
  const terms = positiveTerms(foldSearchDiacritics(query));
  if (!terms.length || !text) return Object.freeze([{ text, matched: false }]);
  let foldedText = "";
  const foldedRanges: Array<Readonly<{ end: number; start: number }>> = [];
  let originalOffset = 0;
  for (const character of text) {
    const start = originalOffset;
    originalOffset += character.length;
    const folded = foldSearchDiacritics(character);
    foldedText += folded;
    for (let index = 0; index < folded.length; index += 1)
      foldedRanges.push({ start, end: originalOffset });
  }
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    const matches = foldedText.matchAll(
      new RegExp(escapeRegularExpression(term), "giu"),
    );
    for (const match of matches) {
      const start = foldedRanges[match.index]?.start;
      const end = foldedRanges[match.index + match[0].length - 1]?.end;
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
      if (ranges.length >= 32) break;
    }
    if (ranges.length >= 32) break;
  }
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range[0] <= prior[1]) prior[1] = Math.max(prior[1], range[1]);
    else merged.push([...range]);
  }
  const parts: SearchSnippetPart[] = [];
  let offset = 0;
  for (const [start, end] of merged) {
    if (start > offset)
      parts.push({ text: text.slice(offset, start), matched: false });
    parts.push({ text: text.slice(start, end), matched: true });
    offset = end;
  }
  if (offset < text.length)
    parts.push({ text: text.slice(offset), matched: false });
  return Object.freeze(
    parts.map((part) => Object.freeze(part)) as SearchSnippetPart[],
  );
}

function protectedLookup(input: NormalizedSearchInput): ProtectedExactInput {
  if (input.match.type !== "protectedExact")
    throw new Error("Expected a protected search.");
  return input.match.kind === "PHONE"
    ? { kind: "PHONE", value: input.match.value }
    : {
        kind: "PERSON_IDENTIFIER",
        namespace: input.match.namespace ?? "",
        value: input.match.value,
      };
}

function outcomeCode(error: unknown) {
  return error && typeof error === "object"
    ? (error as { extensions?: { code?: unknown } }).extensions?.code
    : undefined;
}

function isStatementTimeout(error: unknown): boolean {
  let candidate = error;
  for (
    let depth = 0;
    depth < 5 && candidate && typeof candidate === "object";
    depth += 1
  ) {
    if ((candidate as { code?: unknown }).code === "57014") return true;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("Invalid search timestamp.");
  return parsed.toISOString();
}

export function createSearchService(
  context: SearchServiceContext,
  runtime: SearchRuntime,
) {
  const audit = createAuditService(context);

  const search = async (raw: unknown): Promise<SearchConnection> => {
    const started = performance.now();
    let mode: "TEXT" | "PROTECTED_EXACT" = "TEXT";
    try {
      if (!context.permissions.has("search:read"))
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      const input = normalizeSearchInput(raw);
      mode = input.match.type === "text" ? "TEXT" : "PROTECTED_EXACT";
      if (
        input.kinds.some((kind) =>
          permissionForKind(kind).some(
            (permission) => !context.permissions.has(permission),
          ),
        )
      )
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      if (
        input.match.type === "protectedExact" &&
        (input.kinds.length !== 1 ||
          input.kinds[0] !== "PERSON" ||
          Object.keys(input.filters).length !== 0)
      )
        throw createGraphQLError(
          "VALIDATION_FAILED",
          publicErrorMessage("VALIDATION_FAILED"),
        );
      await context.operationLimiter.consume({
        operationClass: "search.read",
        cost: normalizedSearchWorkCost(input).budget,
        policy: SEARCH_POLICY,
        clientPolicy: SEARCH_CLIENT_POLICY,
      });
      const branch = input.match.type === "text" ? "text" : "protectedExact";
      const queryHash = searchQueryBinding(runtime.cursorHmacKey, {
        branch,
        query: queryMaterial(input),
        workspaceId: context.workspaceId,
      });
      const cursor = input.after
        ? decodeSearchCursor(input.after, {
            branch,
            queryHash,
            secret: runtime.cursorHmacKey,
            workspaceId: context.workspaceId,
          })
        : null;
      const textQuery = input.match.type === "text" ? input.match.query : null;
      const result = await context.database.transaction(async (transaction) => {
        const database = transaction as Database;
        await database.execute(sql`SET LOCAL statement_timeout = '2000ms'`);
        const repository = createSearchRepository(database, context);
        if (input.match.type === "protectedExact") {
          const lookup = createProtectedExactLookupService(
            { ...context, database },
            { blindIndexKey: runtime.protectedLookupHmacKey },
          );
          const page = await lookup.lookup({
            afterPersonId:
              cursor?.branch === "protectedExact" ? cursor.personId : null,
            first: input.first,
            lookup: protectedLookup(input),
          });
          const peopleRows = await repository.protectedPeople(
            page.nodes.map(({ personId }) => personId),
          );
          const peopleById = new Map(peopleRows.map((row) => [row.id, row]));
          const nodes = page.nodes.flatMap(({ personId }) => {
            const person = peopleById.get(personId);
            return person
              ? [
                  {
                    id: person.id,
                    kind: "PERSON" as const,
                    rank: null,
                    snippet: [{ text: person.title, matched: false }],
                    subjectPersonId: person.id,
                    title: person.title,
                    updatedAt: person.updatedAt.toISOString(),
                  },
                ]
              : [];
          });
          await audit.write(database, {
            action: "search.execute",
            changedFields: ["mode", "resultCount"],
            metadata: {
              mode,
              resultCount: nodes.length,
              resultKinds: ["PERSON"],
            },
            resourceKind: "search",
          });
          return {
            nodes,
            pageInfo: {
              hasNextPage: page.nextPersonId !== null,
              endCursor: page.nextPersonId
                ? encodeSearchCursor(
                    {
                      branch: "protectedExact",
                      kind: "PERSON",
                      personId: page.nextPersonId,
                      queryHash,
                      workspaceId: context.workspaceId,
                    },
                    runtime.cursorHmacKey,
                  )
                : null,
            },
          };
        }
        const textRows = await repository.searchText({
          cursor: cursor?.branch === "text" ? cursor : null,
          search: input as NormalizedSearchInput & {
            match: { type: "text"; query: string };
          },
        });
        const hasNextPage = textRows.length > input.first;
        const returned = textRows.slice(0, input.first);
        const nodes = returned.map((row) => ({
          id: row.id,
          kind: row.kind,
          rank: row.rank,
          snippet: buildSearchSnippet(row.displayText, textQuery!),
          subjectPersonId: row.subjectPersonId,
          title: row.title,
          updatedAt: iso(row.updatedAt),
        }));
        const last = returned.at(-1);
        await audit.write(database, {
          action: "search.execute",
          changedFields: ["mode", "resultCount", "resultKinds"],
          metadata: {
            mode,
            resultCount: nodes.length,
            resultKinds: [...new Set(nodes.map(({ kind }) => kind))].sort(),
          },
          resourceKind: "search",
        });
        return {
          nodes,
          pageInfo: {
            hasNextPage,
            endCursor:
              hasNextPage && last
                ? encodeSearchCursor(
                    {
                      branch: "text",
                      kind: last.kind,
                      queryHash,
                      rank: last.rank,
                      resourceId: last.id,
                      updatedAt: iso(last.updatedAt),
                      workspaceId: context.workspaceId,
                    },
                    runtime.cursorHmacKey,
                  )
                : null,
          },
        };
      });
      context.metrics.searchRequest({
        durationSeconds: (performance.now() - started) / 1_000,
        mode,
        outcome: result.nodes.length ? "SUCCESS" : "EMPTY",
        resultCount: result.nodes.length,
      });
      return result;
    } catch (error) {
      const safeError = isStatementTimeout(error)
        ? createGraphQLError(
            "PROVIDER_UNAVAILABLE",
            publicErrorMessage("PROVIDER_UNAVAILABLE"),
            { requestId: context.requestId },
          )
        : error;
      const code = outcomeCode(safeError);
      context.metrics.searchRequest({
        durationSeconds: (performance.now() - started) / 1_000,
        mode,
        outcome:
          code === "VALIDATION_FAILED"
            ? "INVALID"
            : code === "FORBIDDEN" || code === "RATE_LIMITED"
              ? "DENIED"
              : code === "PROVIDER_UNAVAILABLE"
                ? "UNAVAILABLE"
                : "ERROR",
        resultCount: 0,
      });
      throw safeError;
    }
  };
  return {
    search,
    ...createSavedQueryService(context, runtime, search),
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
