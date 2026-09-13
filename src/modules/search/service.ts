import "server-only";

import { createHash, createHmac } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@/db/id";
import { caseResourceLinks } from "@/db/schema/cases";
import { facts } from "@/db/schema/facts";
import { exportArtifacts } from "@/db/schema/search";
import { files } from "@/db/schema/files";
import { auditEvents } from "@/db/schema/operations";
import { relationships } from "@/db/schema/relationships";
import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import type { RequestOperationLimiter } from "@/graphql/operation-limiter";
import type { ProtectedExactInput } from "@/lib/security/protected-exact";
import {
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { runResearchTransaction } from "@/modules/audit/transactions";
import {
  createCasesService,
  requireCaseResource,
} from "@/modules/cases/service";
import { checkPurposeCoverage } from "@/modules/governance/coverage";
import type { ObjectStore } from "@/lib/storage/types";
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
import {
  analyzeResearch,
  normalizeResearchFacets,
  type AnalysisResult,
  type ResearchAnalysisRow,
  type ResearchAnalysisKind,
  type ResearchFacetInput,
} from "./analysis";
import {
  exportArtifactStorageKey,
  isExportArtifactRecoverable,
  previewExport as buildExportPreview,
  serializeRedactedExport,
  verifyExportCommitToken,
  type ExportRedactionProfile,
} from "@/modules/exports/preview";
import { createExportApprovalService } from "@/modules/exports/approval-service";

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

export const BULK_EXPORT_ALERT_ROW_THRESHOLD = 100;
/**
 * A search page is capped at 100 rows. The search repository also computes a
 * count of the complete authorized result set before cursor pagination. The
 * alert records that count, rather than treating a single page as the query's
 * total. PostgreSQL statement_timeout and the existing operation budgets keep
 * the count bounded operationally; the query material itself is never logged.
 */
export const BULK_QUERY_ALERT_RESULT_THRESHOLD = 100;

export type SearchRuntime = Readonly<{
  cursorHmacKey: string;
  encryptionKey?: string;
  protectedLookupHmacKey: string;
  exportArtifacts?: Readonly<{
    objectStore: ObjectStore;
    storageBucket: string;
    storageProvider: "minio" | "r2" | "s3";
  }>;
}>;

export type SearchServiceContext = ResearchServiceContext & {
  metrics: Task12Metrics;
  operationLimiter: RequestOperationLimiter;
};

type ExportGovernanceSubject = Readonly<{
  personId: string;
  fieldDefinitionId: string | null;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
}>;

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

/**
 * Return a stable opaque UUID for a query alert. The query binding is already
 * an HMAC over the workspace and normalized query, so this derived resource
 * identifier does not disclose the search terms while allowing retries and
 * pagination of the same query to share one audit record.
 */
export function bulkQueryAlertResourceId(queryHash: string): string {
  const digest = createHash("sha256")
    .update(`humans:search:bulk-alert:v1\\0${queryHash}`, "utf8")
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function createSearchService(
  context: SearchServiceContext,
  runtime: SearchRuntime,
) {
  const audit = createAuditService(context);

  async function writeBulkQueryAlert(
    database: Database,
    input: {
      hasNextPage: boolean;
      mode: "TEXT" | "PROTECTED_EXACT";
      queryHash: string;
      resultCount: number;
      countScope: "whole_query" | "page";
    },
  ): Promise<void> {
    if (input.resultCount < BULK_QUERY_ALERT_RESULT_THRESHOLD) return;
    const resourceId = bulkQueryAlertResourceId(input.queryHash);
    // Serialize the check-and-insert for the same workspace/query so retries
    // and concurrent identical requests cannot produce duplicate alerts.
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`humans:search:bulk-alert:${context.workspaceId}:${input.queryHash}`}, 0))`,
    );
    const [existing] = await database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, context.workspaceId),
          eq(auditEvents.action, "search.bulk_alert"),
          eq(auditEvents.resourceKind, "search_query"),
          eq(auditEvents.resourceId, resourceId),
        ),
      )
      .limit(1);
    if (existing) return;
    await audit.write(database, {
      action: "search.bulk_alert",
      changedFields: ["resultCount"],
      metadata: {
        hasNextPage: input.hasNextPage,
        countScope: input.countScope,
        queryMode: input.mode,
        rowCount: input.resultCount,
        threshold: BULK_QUERY_ALERT_RESULT_THRESHOLD,
      },
      resourceId,
      resourceKind: "search_query",
    });
  }

  function requireExportActor(): Extract<
    SearchServiceContext["actor"],
    { type: "user" }
  > {
    if (
      context.actor.type !== "user" ||
      !context.permissions.has("workspace:update") ||
      !context.permissions.has("file:create")
    ) {
      throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
    }
    return context.actor;
  }

  function hmac(secret: string, purpose: string, material: string): string {
    if (!/^[0-9a-f]{64}$/iu.test(secret))
      throw new TypeError("Invalid export protection key");
    return createHmac("sha256", Buffer.from(secret, "hex"))
      .update(`humans:${purpose}:v1\\0`, "utf8")
      .update(material, "utf8")
      .digest("hex");
  }

  function normalizedIdempotencyKey(value: string): string {
    const normalized =
      typeof value === "string" ? value.normalize("NFKC").trim() : "";
    if (!normalized || Buffer.byteLength(normalized, "utf8") > 128) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The idempotency key is invalid.",
      );
    }
    return normalized;
  }

  const search = async (
    raw: unknown,
    analysis?: { caseId?: string },
  ): Promise<
    SearchConnection & { analysisRows?: readonly ResearchAnalysisRow[] }
  > => {
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
          await writeBulkQueryAlert(database, {
            hasNextPage: page.nextPersonId !== null,
            mode,
            queryHash,
            resultCount: page.totalCount,
            countScope: "whole_query",
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
          analysis,
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
          sensitivity: row.sensitivity,
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
        await writeBulkQueryAlert(database, {
          hasNextPage,
          mode,
          queryHash,
          resultCount: Number(returned[0]?.totalCount ?? 0),
          countScope: "whole_query",
        });
        return {
          nodes,
          ...(analysis
            ? {
                analysisRows: returned.flatMap((row) =>
                  row.analysis ? [row.analysis] : [],
                ),
              }
            : {}),
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
    async analyze(input: {
      kind: ResearchAnalysisKind;
      query: string;
      facets?: ResearchFacetInput;
      first?: number;
    }): Promise<AnalysisResult> {
      if (!context.permissions.has("search:read"))
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      const facets = normalizeResearchFacets(input.facets);
      if (facets.consentStatus?.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "Consent-status analysis requires purpose-scoped coverage and is not available on this endpoint.",
        );
      if (facets.caseId)
        await createCasesService(context).getCase(facets.caseId);
      const connection = await search(
        {
          version: 1,
          match: { type: "text", query: input.query },
          kinds: ["PERSON", "FACT", "ADDRESS", "RELATIONSHIP", "EVIDENCE"],
          filters: {
            ...(input.facets?.sensitivity
              ? { sensitivities: input.facets.sensitivity }
              : {}),
            ...(input.facets?.temporalRange?.from
              ? { from: input.facets.temporalRange.from }
              : {}),
            ...(input.facets?.temporalRange?.until
              ? { until: input.facets.temporalRange.until }
              : {}),
          },
          first: Math.min(Math.max(input.first ?? 100, 1), 100),
        },
        { caseId: facets.caseId },
      );
      const result = analyzeResearch({
        kind: input.kind,
        context: {
          workspaceId: context.workspaceId,
          purpose: "search_analysis",
          allowedSensitivity: "restricted",
          maxRows: input.first ?? 100,
        },
        facets,
        rows: connection.analysisRows ?? [],
      });
      return {
        ...result,
        explanation: {
          ...result.explanation,
          methodology: `${result.explanation.methodology} Facets apply to the first ${Math.min(Math.max(input.first ?? 100, 1), 100)} authorized search hits, not a workspace-wide aggregation. Missing dates, values and provenance remain unknown; non-public fact values and context are withheld.`,
        },
      };
    },
    async previewExport(input: {
      query: string;
      purpose: string;
      caseId?: string | null;
      redactionProfile: ExportRedactionProfile;
      first?: number;
    }) {
      if (!context.permissions.has("search:read"))
        throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
      if (!input.purpose.normalize("NFKC").trim()) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "An export purpose is required.",
        );
      }
      if (input.caseId) await createCasesService(context).getCase(input.caseId);
      const connection = await search({
        version: 1,
        match: { type: "text", query: input.query },
        kinds: ["PERSON", "FACT", "ADDRESS", "RELATIONSHIP", "EVIDENCE"],
        filters: {},
        first: Math.min(Math.max(input.first ?? 100, 1), 100),
      });
      const governanceSubjects: ExportGovernanceSubject[] = [];
      for (const node of connection.nodes) {
        const sensitivity = node.sensitivity ?? ("internal" as const);
        let resourceKind: "person" | "fact" | "relationship" = "person";
        let resourceId = node.subjectPersonId;
        let fieldDefinitionId: string | null = null;
        if (node.kind === "PERSON") resourceId = node.id;
        if (node.kind === "ADDRESS") resourceKind = "person";
        if (node.kind === "FACT") {
          resourceKind = "fact";
          const [fact] = await context.database
            .select({
              factDefinitionId: facts.factDefinitionId,
              personId: facts.personId,
            })
            .from(facts)
            .where(
              and(
                eq(facts.workspaceId, context.workspaceId),
                eq(facts.id, node.id),
                isNull(facts.deletedAt),
              ),
            )
            .limit(1);
          resourceId = fact?.personId ?? resourceId;
          fieldDefinitionId = fact?.factDefinitionId ?? null;
        }
        if (node.kind === "RELATIONSHIP") {
          resourceKind = "relationship";
          const [relationship] = await context.database
            .select({
              sourcePersonId: relationships.sourcePersonId,
              targetPersonId: relationships.targetPersonId,
            })
            .from(relationships)
            .where(
              and(
                eq(relationships.workspaceId, context.workspaceId),
                eq(relationships.id, node.id),
                isNull(relationships.deletedAt),
              ),
            )
            .limit(1);
          if (!relationship) resourceId = null;
          else {
            resourceId = relationship.sourcePersonId;
            governanceSubjects.push({
              personId: relationship.targetPersonId,
              fieldDefinitionId: null,
              sensitivity,
            });
          }
        }
        // Evidence and source-only hits do not have a complete person subject
        // contract. Refuse them rather than exporting an ungoverned title.
        if (!resourceId || node.kind === "EVIDENCE")
          throw createGraphQLError(
            "FORBIDDEN",
            publicErrorMessage("FORBIDDEN"),
          );
        if (input.caseId) {
          await requireCaseResource(
            context,
            resourceKind,
            node.kind === "ADDRESS" ? resourceId : node.id,
          );
          const [link] = await context.database
            .select({ id: caseResourceLinks.id })
            .from(caseResourceLinks)
            .where(
              and(
                eq(caseResourceLinks.workspaceId, context.workspaceId),
                eq(caseResourceLinks.caseId, input.caseId),
                eq(caseResourceLinks.resourceKind, resourceKind),
                eq(
                  caseResourceLinks.resourceId,
                  node.kind === "ADDRESS" ? resourceId : node.id,
                ),
                isNull(caseResourceLinks.deletedAt),
              ),
            )
            .limit(1);
          if (!link)
            throw createGraphQLError(
              "FORBIDDEN",
              publicErrorMessage("FORBIDDEN"),
            );
        }
        governanceSubjects.push({
          personId: resourceId,
          fieldDefinitionId,
          sensitivity,
        });
      }
      const uniqueSubjects = [
        ...new Map(
          governanceSubjects.map((subject) => [
            `${subject.personId}:${subject.fieldDefinitionId ?? "*"}`,
            subject,
          ]),
        ).values(),
      ];
      for (const subject of uniqueSubjects) {
        const coverage = await checkPurposeCoverage(context, {
          personId: subject.personId,
          purpose: input.purpose.normalize("NFKC").trim(),
          caseReference: input.caseId ?? null,
          scope: "export",
          effectiveSensitivity: subject.sensitivity,
          fieldDefinitionId: subject.fieldDefinitionId,
        });
        if (!coverage.allowed) {
          throw createGraphQLError(
            "FORBIDDEN",
            "Current export-purpose coverage is required.",
          );
        }
      }
      return buildExportPreview({
        workspaceId: context.workspaceId,
        actorPrincipalId: context.actor.principalId,
        purpose: input.purpose,
        caseId: input.caseId,
        redactionProfile: input.redactionProfile,
        rows: connection.nodes.map((node) => ({
          id: node.id,
          sensitivity: node.sensitivity ?? "internal",
          values: {
            title: node.title,
            kind: node.kind,
            subjectPersonId: node.subjectPersonId,
            updatedAt: node.updatedAt,
          },
          fieldSensitivity: {
            title: node.sensitivity ?? "internal",
            kind: node.sensitivity ?? "internal",
            subjectPersonId: node.sensitivity ?? "internal",
            updatedAt: node.sensitivity ?? "internal",
          },
          sourceIds: [],
        })),
        governanceSubjects: uniqueSubjects.map(
          ({ personId, fieldDefinitionId }) => ({
            personId,
            fieldDefinitionId,
          }),
        ),
        hmacKey: runtime.encryptionKey ?? runtime.cursorHmacKey,
      });
    },
    async commitExport(input: {
      query: string;
      purpose: string;
      caseId?: string | null;
      redactionProfile: ExportRedactionProfile;
      first?: number;
      format: "JSON" | "CSV";
      commitToken: string;
      idempotencyKey: string;
    }) {
      const actor = requireExportActor();
      const artifactRuntime = runtime.exportArtifacts;
      const protectionKey = runtime.encryptionKey ?? runtime.cursorHmacKey;
      if (!artifactRuntime?.objectStore.putInternal) {
        throw createGraphQLError(
          "PROVIDER_UNAVAILABLE",
          publicErrorMessage("PROVIDER_UNAVAILABLE"),
        );
      }
      const preview = await this.previewExport({
        query: input.query,
        purpose: input.purpose,
        caseId: input.caseId,
        redactionProfile: input.redactionProfile,
        first: input.first,
      });
      const now = new Date();
      verifyExportCommitToken({
        token: input.commitToken,
        workspaceId: context.workspaceId,
        actorPrincipalId: actor.principalId,
        purpose: preview.purpose,
        caseId: preview.caseId,
        redactionProfile: preview.redactionProfile,
        previewHash: preview.previewHash,
        hmacKey: protectionKey,
        now,
      });
      if (preview.approvalRequired) {
        await createExportApprovalService(context).requireApproved({
          workspaceId: context.workspaceId,
          actorPrincipalId: actor.principalId,
          purpose: preview.purpose,
          caseId: preview.caseId,
          redactionProfile: preview.redactionProfile,
          previewHash: preview.previewHash,
          now,
        });
      }
      const idempotencyHash = hmac(
        protectionKey,
        "export-artifact-idempotency",
        `${context.workspaceId}\\0${actor.principalId}\\0${normalizedIdempotencyKey(input.idempotencyKey)}`,
      );
      const queryHash = createHash("sha256")
        .update(input.query.normalize("NFKC"), "utf8")
        .digest("hex");
      const requestHash = hmac(
        protectionKey,
        "export-artifact-request",
        JSON.stringify({
          caseId: preview.caseId,
          format: input.format,
          previewHash: preview.previewHash,
          purpose: preview.purpose,
          queryHash,
          redactionProfile: preview.redactionProfile,
        }),
      );
      const content = Buffer.from(
        serializeRedactedExport(preview, input.format),
        "utf8",
      );
      const checksum = createHash("sha256").update(content).digest("hex");
      let artifactId = newId();
      let fileId = newId();
      const extension = input.format === "JSON" ? "json" : "csv";
      let storageKey = exportArtifactStorageKey(artifactId, input.format);
      const originalName = `humans-export-${artifactId}.${extension}`;
      const sensitivity = preview.redactionProfile.toLowerCase() as
        "public" | "internal" | "confidential" | "restricted";
      const claimed = await runResearchTransaction(
        context,
        {
          requiredPermissions: [
            "workspace:update",
            "file:create",
            "search:read",
          ],
        },
        async (scoped) => {
          await scoped.database.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`humans:export:${context.workspaceId}:${idempotencyHash}`}, 0))`,
          );
          const [existing] = await scoped.database
            .select()
            .from(exportArtifacts)
            .where(
              and(
                eq(exportArtifacts.workspaceId, scoped.workspaceId),
                eq(exportArtifacts.idempotencyHash, idempotencyHash),
              ),
            )
            .limit(1)
            .for("update");
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw createGraphQLError(
                "CONFLICT",
                "The idempotency key is bound to another export.",
              );
            }
            return { artifact: existing, created: false };
          }
          const [file] = await scoped.database
            .insert(files)
            .values({
              id: fileId,
              workspaceId: scoped.workspaceId,
              storageProvider: artifactRuntime.storageProvider,
              storageBucket: artifactRuntime.storageBucket,
              storageKey,
              originalName,
              mediaType:
                input.format === "JSON" ? "application/json" : "text/csv",
              detectedType:
                input.format === "JSON" ? "application/json" : "text/csv",
              byteSize: content.byteLength,
              checksum,
              encryptionMetadata: {
                generated: "governed_export",
                redactionProfile: preview.redactionProfile,
                governanceSubjects: preview.governanceSubjects,
              },
              quarantineState: "quarantined",
              scanState: "not_required",
              ocrState: "not_requested",
              extractionState: "not_requested",
              sensitivity,
              uploadedBy: scoped.actor.id,
              createdBy: scoped.actor.id,
              updatedBy: scoped.actor.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!file) throw new Error("Export file creation failed");
          const [artifact] = await scoped.database
            .insert(exportArtifacts)
            .values({
              id: artifactId,
              workspaceId: scoped.workspaceId,
              fileId: file.id,
              caseId: preview.caseId,
              purpose: preview.purpose,
              queryHash,
              previewHash: preview.previewHash,
              redactionProfile: preview.redactionProfile,
              format: input.format,
              state: "writing",
              expiresAt: new Date(preview.expiresAt),
              rowCount: preview.rows.length,
              fieldCounts: preview.fieldCounts,
              legalHoldCheckedAt: now,
              idempotencyHash,
              requestHash,
              createdBy: scoped.actor.principalId,
              updatedBy: scoped.actor.principalId,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!artifact) throw new Error("Export artifact creation failed");
          await createAuditService(scoped).write(scoped.database, {
            action: "export.artifact_writing",
            resourceKind: "export_artifact",
            resourceId: artifact.id,
            changedFields: ["state", "format", "redactionProfile", "rowCount"],
            metadata: { caseId: preview.caseId, purpose: preview.purpose },
          });
          return { artifact, created: true };
        },
      );
      if (!claimed.created) {
        if (claimed.artifact.state === "ready") return claimed.artifact;
        // A client may safely retry the exact same commit after a process
        // crash or object-store timeout. The durable artifact row and its
        // idempotency/request hashes are the recovery fence; the deterministic
        // object key makes a repeated put idempotent at the provider boundary.
        // Never revive an expired artifact or one in an unknown state.
        if (!isExportArtifactRecoverable(claimed.artifact.state)) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The export is no longer eligible for recovery.",
          );
        }
        artifactId = claimed.artifact.id;
        fileId = claimed.artifact.fileId;
        storageKey = exportArtifactStorageKey(artifactId, input.format);
      }
      try {
        await artifactRuntime.objectStore.putInternal({
          workspaceId: context.workspaceId,
          key: storageKey,
          content,
          contentType:
            input.format === "JSON" ? "application/json" : "text/csv",
          checksumSha256: checksum,
        });
      } catch (error) {
        await runResearchTransaction(
          context,
          {
            requiredPermissions: [
              "workspace:update",
              "file:create",
              "search:read",
            ],
          },
          async (scoped) => {
            const [failed] = await scoped.database
              .update(exportArtifacts)
              .set({
                state: "failed",
                updatedAt: new Date(),
                updatedBy: scoped.actor.principalId,
              })
              .where(
                and(
                  eq(exportArtifacts.workspaceId, scoped.workspaceId),
                  eq(exportArtifacts.id, artifactId),
                  inArray(exportArtifacts.state, ["writing", "failed"]),
                ),
              )
              .returning({ id: exportArtifacts.id });
            if (failed) {
              await createAuditService(scoped).write(scoped.database, {
                action: "export.artifact_failed",
                resourceKind: "export_artifact",
                resourceId: artifactId,
                changedFields: ["state"],
              });
            }
          },
        );
        throw error;
      }
      return runResearchTransaction(
        context,
        {
          requiredPermissions: [
            "workspace:update",
            "file:create",
            "search:read",
          ],
        },
        async (scoped) => {
          const [artifact] = await scoped.database
            .update(exportArtifacts)
            .set({
              state: "ready",
              updatedAt: new Date(),
              updatedBy: scoped.actor.principalId,
              version: sql`${exportArtifacts.version} + 1`,
            })
            .where(
              and(
                eq(exportArtifacts.workspaceId, scoped.workspaceId),
                eq(exportArtifacts.id, artifactId),
                inArray(exportArtifacts.state, ["writing", "failed"]),
              ),
            )
            .returning();
          if (!artifact) {
            // Another retry may have completed the same deterministic write
            // while this request was uploading. Return that committed row
            // instead of surfacing a false conflict to the caller.
            const [alreadyReady] = await scoped.database
              .select()
              .from(exportArtifacts)
              .where(
                and(
                  eq(exportArtifacts.workspaceId, scoped.workspaceId),
                  eq(exportArtifacts.id, artifactId),
                  eq(exportArtifacts.state, "ready"),
                ),
              )
              .limit(1);
            if (alreadyReady) return alreadyReady;
            throw createGraphQLError(
              "CONFLICT",
              publicErrorMessage("CONFLICT"),
            );
          }
          await scoped.database
            .update(files)
            .set({
              quarantineState: "available",
              updatedAt: new Date(),
              updatedBy: scoped.actor.id,
            })
            .where(
              and(
                eq(files.workspaceId, scoped.workspaceId),
                eq(files.id, fileId),
                eq(files.quarantineState, "quarantined"),
              ),
            );
          const auditReference = await createAuditService(scoped).write(
            scoped.database,
            {
              action: "export.artifact_ready",
              resourceKind: "export_artifact",
              resourceId: artifact.id,
              changedFields: ["state", "fileId", "expiresAt"],
              metadata: { rowCount: artifact.rowCount },
            },
          );
          if (artifact.rowCount >= BULK_EXPORT_ALERT_ROW_THRESHOLD) {
            await createAuditService(scoped).write(scoped.database, {
              action: "export.bulk_alert",
              resourceKind: "export_artifact",
              resourceId: artifact.id,
              changedFields: ["state"],
              metadata: {
                caseScoped: artifact.caseId !== null,
                redactionProfile: artifact.redactionProfile,
                rowCount: artifact.rowCount,
                threshold: BULK_EXPORT_ALERT_ROW_THRESHOLD,
              },
            });
          }
          const [audited] = await scoped.database
            .update(exportArtifacts)
            .set({
              auditReference,
              updatedAt: new Date(),
              updatedBy: scoped.actor.principalId,
            })
            .where(
              and(
                eq(exportArtifacts.workspaceId, scoped.workspaceId),
                eq(exportArtifacts.id, artifact.id),
              ),
            )
            .returning();
          return audited ?? artifact;
        },
      );
    },
    ...createSavedQueryService(context, runtime, search),
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
