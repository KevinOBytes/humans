import { createGraphQLError } from "@/graphql/errors";
import { decodeResearchCursor, normalizePagination } from "@/graphql/limits";
import {
  canAccessResource,
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  derivePrincipalResearchIdempotency,
  deriveResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  runIdempotentResearchWrite,
  withResearchWriteTransaction as writeTransaction,
  type CanonicalRequestMaterial,
} from "@/modules/audit/transactions";
import {
  normalizeHumanText,
  validateUnitDecimal,
  type ValidationIssue,
} from "@/modules/facts/validation";
import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import { facts, personFieldSelections } from "@/db/schema/facts";
import { addresses, contactPoints } from "@/db/schema/locations";
import {
  evidenceItems,
  notes,
  personAddresses,
  personContactPoints,
  sources,
  personTags,
} from "@/db/schema/evidence";
import { consentRecords } from "@/db/schema/privacy";
import { relationships } from "@/db/schema/relationships";
import {
  externalRecords,
  identityCandidates,
  mergeDecisions,
  people,
  personEvents,
  personIdentifiers,
  personNames,
} from "@/db/schema/people";
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import {
  createPeopleRepository,
  type PersonEventRow,
  type PersonFileRow,
  type PersonNameRow,
  type PersonRow,
} from "./repository";

export type MutationOutcome<T> = {
  resource: T | null;
  issues: ValidationIssue[];
  code:
    | "ARCHIVED"
    | "CONFLICT"
    | "NOT_FOUND"
    | "NOT_VISIBLE"
    | "VALIDATION_FAILED"
    | null;
  currentVersion?: number | null;
};

export type PageInfo = { endCursor: string | null; hasNextPage: boolean };
export type Connection<T> = { nodes: T[]; pageInfo: PageInfo };

function invalid<T>(issues: ValidationIssue[]): MutationOutcome<T> {
  return { resource: null, issues, code: "VALIDATION_FAILED" };
}

function fieldMaterial(
  value: CanonicalRequestMaterial | undefined,
): CanonicalRequestMaterial {
  return value === undefined
    ? { present: false }
    : { present: true, value: value ?? null };
}

export function encodeCursor(order: string, sort: string, id: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, o: order, s: sort, i: id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(
  value: string | null,
  order: string,
): { sort: string; id: string } | null {
  const decoded = decodeResearchCursor(value, order);
  return decoded
    ? { sort: decoded.s as string, id: decoded.i as string }
    : null;
}

function sortValue(row: PersonRow): string {
  return row.sortName ?? row.displayName;
}

const RECENT_PEOPLE_CURSOR_ORDER = "dashboard-people-updated-desc";
const PERSON_NAMES_CURSOR_ORDER = "person-names-created-desc";
const PERSON_EVENTS_CURSOR_ORDER = "person-events-created-desc";
const PERSON_FILES_CURSOR_ORDER = "person-files-created-desc";
const CONTRADICTORY_FACTS_CURSOR_ORDER = "contradictory-facts-asserted-desc";
const PERSON_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const PERSON_RECORD_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const PERSON_REFERENCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PERSON_NAME_KINDS = new Set([
  "legal",
  "preferred",
  "birth",
  "married",
  "former",
  "alias",
  "transliteration",
  "other",
]);
const PERSON_RECORD_STATES = new Set([
  "asserted",
  "verified",
  "disputed",
  "superseded",
  "unknown",
]);
const PERSON_TEMPORAL_SEMANTICS = new Set([
  "exact",
  "approximate",
  "before",
  "after",
  "between",
  "year_only",
  "unknown",
]);
const PERSON_TEMPORAL_PRECISIONS = new Set([
  "instant",
  "second",
  "minute",
  "hour",
  "day",
  "month",
  "year",
  "range",
  "unknown",
]);
const PERSON_SENSITIVITIES = new Set([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

function recordText(
  value: string | null | undefined,
  path: string,
  max: number,
  required = false,
): { value: string | null; issues: ValidationIssue[] } {
  if (value == null) {
    return required
      ? {
          value: null,
          issues: [
            { path: [path], code: "REQUIRED", message: "A value is required." },
          ],
        }
      : { value: null, issues: [] };
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > max ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    return {
      value: null,
      issues: [
        {
          path: [path],
          code: "INVALID_VALUE",
          message: "The value is invalid.",
        },
      ],
    };
  }
  return { value: normalized, issues: [] };
}

function recordDate(
  value: Date | string | null | undefined,
  path: string,
): { value: Date | null | undefined; issues: ValidationIssue[] } {
  if (value === undefined || value === null) return { value, issues: [] };
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return {
      value: null,
      issues: [
        {
          path: [path],
          code: "INVALID_VALUE",
          message: "The date is invalid.",
        },
      ],
    };
  }
  return { value: parsed, issues: [] };
}

function recordEnum(
  value: string | null | undefined,
  path: string,
  allowed: ReadonlySet<string>,
  fallback: string,
): { value: string; issues: ValidationIssue[] } {
  const normalized = (value ?? fallback).toLowerCase();
  return allowed.has(normalized)
    ? { value: normalized, issues: [] }
    : {
        value: fallback,
        issues: [
          {
            path: [path],
            code: "INVALID_VALUE",
            message: "The value is invalid.",
          },
        ],
      };
}

function recordConfidence(
  value: number | null | undefined,
  path = "confidence",
): { value: string; issues: ValidationIssue[] } {
  const normalized = value ?? 1;
  return Number.isFinite(normalized) && normalized >= 0 && normalized <= 1
    ? { value: normalized.toFixed(3), issues: [] }
    : {
        value: "1.000",
        issues: [
          {
            path: [path],
            code: "INVALID_VALUE",
            message: "Confidence must be between 0 and 1.",
          },
        ],
      };
}

function encodeRecentCursor(row: Pick<PersonRow, "id" | "updatedAt">): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      o: RECENT_PEOPLE_CURSOR_ORDER,
      t: row.updatedAt.toISOString(),
      i: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function encodeDateCursor(
  order: string,
  row: Pick<PersonNameRow | PersonEventRow | PersonFileRow, "id" | "createdAt">,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      o: order,
      t: row.createdAt.toISOString(),
      i: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeRecentCursor(
  value: string | null,
): { updatedAt: Date; id: string } | null {
  if (value === null) return null;
  try {
    if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value))
      throw new Error("invalid cursor");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value)
      throw new Error("invalid cursor");
    const decoded = JSON.parse(bytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const updatedAt = new Date(String(decoded.t));
    if (
      Reflect.ownKeys(decoded).length !== 4 ||
      decoded.v !== 1 ||
      decoded.o !== RECENT_PEOPLE_CURSOR_ORDER ||
      typeof decoded.t !== "string" ||
      Number.isNaN(updatedAt.getTime()) ||
      updatedAt.toISOString() !== decoded.t ||
      typeof decoded.i !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        decoded.i,
      )
    )
      throw new Error("invalid cursor");
    return { updatedAt, id: decoded.i.toLowerCase() };
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}

function normalizeDashboardPage(input: {
  first?: number | null;
  after?: string | null;
}): { first: number; after: string | null } {
  const first = input.first ?? 8;
  if (!Number.isInteger(first) || first < 1 || first > 10)
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "first must be between 1 and 10.",
    );
  return { first, after: input.after ?? null };
}

function validateVersion(value: number): ValidationIssue[] {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647
    ? []
    : [
        {
          path: ["expectedVersion"],
          code: "INVALID_VERSION",
          message: "A positive version is required.",
        },
      ];
}

export function createPeopleService(context: ResearchServiceContext) {
  const repository = createPeopleRepository(context.database);
  const audit = createAuditService(context);
  const visibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: people.id,
    sensitivity: people.sensitivity,
  });

  async function visible(row: PersonRow): Promise<boolean> {
    return canAccessResource(context.database, context, {
      id: row.id,
      resourceKind: "person",
      sensitivity: row.sensitivity,
    });
  }

  async function visibleRetryTarget(id: string): Promise<boolean> {
    const [target] = await context.database
      .select({ id: people.id, sensitivity: people.sensitivity })
      .from(people)
      .where(
        and(eq(people.workspaceId, context.workspaceId), eq(people.id, id)),
      )
      .limit(1);
    return target
      ? canAccessResource(context.database, context, {
          id: target.id,
          resourceKind: "person",
          sensitivity: target.sensitivity,
        })
      : false;
  }

  async function replayPerson(
    responseReference: Readonly<
      Record<string, string | number | boolean | null>
    >,
  ): Promise<PersonRow> {
    const personId = responseReference.personId;
    const version = responseReference.version;
    if (
      typeof personId !== "string" ||
      !PERSON_REFERENCE_UUID.test(personId) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The operation response reference is invalid.",
      );
    }
    const [row] = await context.database
      .select()
      .from(people)
      .where(
        and(
          eq(people.workspaceId, context.workspaceId),
          eq(people.id, personId),
          visibility,
        ),
      )
      .limit(1);
    if (!row) {
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
    if (row.version !== version) {
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation response is no longer current.",
      );
    }
    return row;
  }

  async function requireRecordPerson(personId: string): Promise<PersonRow> {
    const person = await repository.getById({
      workspaceId: context.workspaceId,
      id: personId,
      visibility,
    });
    if (!person) {
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
    return person;
  }

  async function visibleRecord(
    resourceKind: "personName" | "personEvent",
    row: PersonNameRow | PersonEventRow,
  ): Promise<boolean> {
    return canAccessResource(context.database, context, {
      id: row.id,
      resourceKind,
      sensitivity: row.sensitivity,
    });
  }

  async function replayPersonName(
    responseReference: Readonly<
      Record<string, string | number | boolean | null>
    >,
  ): Promise<PersonNameRow> {
    const nameId = responseReference.nameId;
    const version = responseReference.version;
    if (
      typeof nameId !== "string" ||
      !PERSON_REFERENCE_UUID.test(nameId) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The operation response reference is invalid.",
      );
    }
    const row = await repository.getNameById({
      workspaceId: context.workspaceId,
      id: nameId,
    });
    if (!row || !(await visibleRecord("personName", row))) {
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
    if (row.version !== version) {
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation response is no longer current.",
      );
    }
    return row;
  }

  async function replayPersonEvent(
    responseReference: Readonly<
      Record<string, string | number | boolean | null>
    >,
  ): Promise<PersonEventRow> {
    const eventId = responseReference.eventId;
    const version = responseReference.version;
    if (
      typeof eventId !== "string" ||
      !PERSON_REFERENCE_UUID.test(eventId) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The operation response reference is invalid.",
      );
    }
    const row = await repository.getEventById({
      workspaceId: context.workspaceId,
      id: eventId,
    });
    if (!row || !(await visibleRecord("personEvent", row))) {
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    }
    if (row.version !== version) {
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation response is no longer current.",
      );
    }
    return row;
  }

  async function maintainPersonSearch(
    writeContext: ResearchServiceContext,
    database: typeof context.database,
    person: PersonRow,
  ): Promise<void> {
    await applySearchIndexMaintenance(writeContext, database, [
      {
        action: "upsert",
        sourceId: person.id,
        sourceKind: "person",
        sourceVersion: person.version,
        workspaceId: writeContext.workspaceId,
      },
    ]);
  }

  return {
    async get(id: string): Promise<PersonRow | null> {
      const row = await repository.getById({
        workspaceId: context.workspaceId,
        id,
        visibility,
      });
      return row;
    },

    async getByIds(
      ids: readonly string[],
    ): Promise<readonly (PersonRow | null)[]> {
      const rows = await repository.getByIds({
        workspaceId: context.workspaceId,
        ids,
        visibility,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },

    async list(input: {
      first?: number | null;
      after?: string | null;
      name?: string | null;
      namePrefix?: string | null;
      nameContains?: string | null;
      status?: string | null;
      sensitivity?: string | null;
    }): Promise<Connection<PersonRow>> {
      const page = normalizePagination(input);
      const name = input.name
        ? normalizeHumanText(input.name, {
            path: ["filter", "name"],
            min: 1,
            max: 200,
          })
        : { value: null, issues: [] as ValidationIssue[] };
      if (name.issues.length > 0) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The people filter is invalid.",
        );
      }
      const normalizedPrefix = input.namePrefix
        ? normalizeHumanText(input.namePrefix, {
            path: ["filter", "namePrefix"],
            min: 1,
            max: 200,
          })
        : { value: null, issues: [] as ValidationIssue[] };
      const normalizedContains = input.nameContains
        ? normalizeHumanText(input.nameContains, {
            path: ["filter", "nameContains"],
            min: 1,
            max: 200,
          })
        : { value: null, issues: [] as ValidationIssue[] };
      if (normalizedPrefix.issues.length || normalizedContains.issues.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The people filter is invalid.",
        );
      const status = input.status?.toLowerCase() ?? null;
      const sensitivity = input.sensitivity?.toLowerCase() ?? null;
      if (
        (status &&
          ![
            "active",
            "deceased",
            "missing",
            "unknown",
            "archived",
            "merged",
          ].includes(status)) ||
        (sensitivity &&
          !["public", "internal", "confidential", "restricted"].includes(
            sensitivity,
          ))
      )
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The people filter is invalid.",
        );
      const cursor = decodeCursor(page.after, "people-name-asc");
      const rows = await repository.list({
        workspaceId: context.workspaceId,
        cursor,
        limit: Math.min(101, page.first + 1),
        name: name.value,
        namePrefix: normalizedPrefix.value,
        nameContains: normalizedContains.value,
        status: status as PersonRow["status"] | null,
        sensitivity: sensitivity as PersonRow["sensitivity"] | null,
        visibility,
      });
      const nodes = rows.slice(0, page.first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor:
            nodes.length === 0
              ? null
              : encodeCursor(
                  "people-name-asc",
                  sortValue(nodes.at(-1)!),
                  nodes.at(-1)!.id,
                ),
        },
      };
    },

    async listRecent(input: {
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<PersonRow>> {
      const page = normalizeDashboardPage(input);
      const rows = await repository.listRecent({
        workspaceId: context.workspaceId,
        cursor: decodeRecentCursor(page.after),
        limit: page.first + 1,
        visibility,
      });
      const nodes = rows.slice(0, page.first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor:
            nodes.length === 0 ? null : encodeRecentCursor(nodes.at(-1)!),
        },
      };
    },

    async listNames(input: {
      personId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<PersonNameRow>> {
      const page = normalizePagination(input);
      const decoded = decodeResearchCursor(
        page.after,
        PERSON_NAMES_CURSOR_ORDER,
      );
      const cursor = decoded
        ? { createdAt: new Date(String(decoded.t)), id: String(decoded.i) }
        : null;
      const rows = await repository.listNames({
        workspaceId: context.workspaceId,
        personId: input.personId,
        cursor,
        limit: page.first + 1,
        visibility: resourceVisibilitySql(context, {
          resourceKind: "personName",
          id: personNames.id,
          sensitivity: personNames.sensitivity,
        }),
        personVisibility: visibility,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeDateCursor(PERSON_NAMES_CURSOR_ORDER, last)
            : null,
        },
      };
    },

    async listEvents(input: {
      personId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<PersonEventRow>> {
      const page = normalizePagination(input);
      const decoded = decodeResearchCursor(
        page.after,
        PERSON_EVENTS_CURSOR_ORDER,
      );
      const cursor = decoded
        ? { createdAt: new Date(String(decoded.t)), id: String(decoded.i) }
        : null;
      const rows = await repository.listEvents({
        workspaceId: context.workspaceId,
        personId: input.personId,
        cursor,
        limit: page.first + 1,
        visibility: resourceVisibilitySql(context, {
          resourceKind: "personEvent",
          id: personEvents.id,
          sensitivity: personEvents.sensitivity,
        }),
        personVisibility: visibility,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeDateCursor(PERSON_EVENTS_CURSOR_ORDER, last)
            : null,
        },
      };
    },

    async createName(input: {
      idempotencyKey?: string | null;
      personId: string;
      kind?: string | null;
      fullName: string;
      givenName?: string | null;
      middleName?: string | null;
      familyName?: string | null;
      prefix?: string | null;
      suffix?: string | null;
      script?: string | null;
      language?: string | null;
      validFrom?: Date | string | null;
      validUntil?: Date | string | null;
      temporalSemantics?: string | null;
      temporalPrecision?: string | null;
      confidence?: number | null;
      sensitivity?: string | null;
      state?: string | null;
    }): Promise<MutationOutcome<PersonNameRow>> {
      const person = await requireRecordPerson(input.personId);
      const fullName = recordText(input.fullName, "fullName", 500, true);
      const fields = [
        fullName,
        ...[
          [input.givenName, "givenName", 200],
          [input.middleName, "middleName", 200],
          [input.familyName, "familyName", 200],
          [input.prefix, "prefix", 100],
          [input.suffix, "suffix", 100],
          [input.script, "script", 100],
          [input.language, "language", 100],
        ].map(([value, path, max]) =>
          recordText(
            value as string | null | undefined,
            path as string,
            max as number,
          ),
        ),
      ];
      const kind = recordEnum(input.kind, "kind", PERSON_NAME_KINDS, "other");
      const temporalSemantics = recordEnum(
        input.temporalSemantics,
        "temporalSemantics",
        PERSON_TEMPORAL_SEMANTICS,
        "unknown",
      );
      const temporalPrecision = recordEnum(
        input.temporalPrecision,
        "temporalPrecision",
        PERSON_TEMPORAL_PRECISIONS,
        "unknown",
      );
      const sensitivity = recordEnum(
        input.sensitivity,
        "sensitivity",
        PERSON_SENSITIVITIES,
        "internal",
      );
      const state = recordEnum(
        input.state,
        "state",
        PERSON_RECORD_STATES,
        "asserted",
      );
      const validFrom = recordDate(input.validFrom, "validFrom");
      const validUntil = recordDate(input.validUntil, "validUntil");
      const confidence = recordConfidence(input.confidence);
      const issues = [
        ...fields.flatMap((field) => field.issues),
        ...kind.issues,
        ...temporalSemantics.issues,
        ...temporalPrecision.issues,
        ...sensitivity.issues,
        ...state.issues,
        ...validFrom.issues,
        ...validUntil.issues,
        ...confidence.issues,
      ];
      if (
        validFrom.value &&
        validUntil.value &&
        validUntil.value < validFrom.value
      ) {
        issues.push({
          path: ["validUntil"],
          code: "INVALID_RANGE",
          message: "The end date must not precede the start date.",
        });
      }
      if (issues.length) return invalid(issues);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person-name creation is not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_RECORD_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person_name.create.graphql",
          requestMaterial: {
            confidence: confidence.value,
            familyName: fields[3].value ?? null,
            fullName: fullName.value!,
            givenName: fields[1].value ?? null,
            kind: kind.value!,
            language: fields[7].value ?? null,
            middleName: fields[2].value ?? null,
            personId: person.id,
            prefix: fields[4].value ?? null,
            script: fields[6].value ?? null,
            sensitivity: sensitivity.value!,
            state: state.value!,
            suffix: fields[5].value ?? null,
            temporalPrecision: temporalPrecision.value!,
            temporalSemantics: temporalSemantics.value!,
            validFrom: validFrom.value?.toISOString() ?? null,
            validUntil: validUntil.value?.toISOString() ?? null,
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["person:update"],
          async (scopedContext) => {
            const outcome = await createPeopleService(scopedContext).createName(
              { ...input, idempotencyKey: null },
            );
            if (!outcome.resource) {
              throw createGraphQLError(
                outcome.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED",
                "The person name could not be created.",
              );
            }
            return {
              nameId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayPersonName(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const now = new Date();
      const [row] = await writeTransaction(context, async (database) => {
        const [created] = await database
          .insert(personNames)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            personId: person.id,
            kind: kind.value as "legal",
            fullName: fullName.value!,
            givenName: fields[1].value,
            middleName: fields[2].value,
            familyName: fields[3].value,
            prefix: fields[4].value,
            suffix: fields[5].value,
            script: fields[6].value,
            language: fields[7].value,
            normalizedForm: fullName.value!.toLocaleLowerCase("en-US"),
            validFrom: validFrom.value ?? null,
            validUntil: validUntil.value ?? null,
            temporalSemantics: temporalSemantics.value as "unknown",
            temporalPrecision: temporalPrecision.value as "unknown",
            confidence: confidence.value,
            sensitivity: sensitivity.value as "internal",
            state: state.value as "asserted",
            createdAt: now,
            createdBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
          })
          .returning();
        if (!created) throw new Error("Person name insert failed");
        await audit.write(database, {
          action: "personName.create",
          resourceKind: "personName",
          resourceId: created.id,
          sensitivity: created.sensitivity,
          changedFields: ["fullName", "kind", "state", "sensitivity"],
          metadata: { personId: person.id, version: created.version },
        });
        await maintainPersonSearch(context, database, person);
        return [created];
      });
      return { resource: row ?? null, issues: [], code: null };
    },

    async updateName(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
      fullName?: string | null;
      kind?: string | null;
      givenName?: string | null;
      middleName?: string | null;
      familyName?: string | null;
      prefix?: string | null;
      suffix?: string | null;
      script?: string | null;
      language?: string | null;
      validFrom?: Date | string | null;
      validUntil?: Date | string | null;
      temporalSemantics?: string | null;
      temporalPrecision?: string | null;
      confidence?: number | null;
      sensitivity?: string | null;
      state?: string | null;
    }): Promise<MutationOutcome<PersonNameRow>> {
      const existing = await repository.getNameById({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        !existing ||
        existing.deletedAt !== null ||
        !(await visibleRecord("personName", existing))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const person = await requireRecordPerson(existing.personId);
      const patch: Partial<typeof personNames.$inferInsert> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const issues: ValidationIssue[] = [];
      if (input.fullName !== undefined) {
        const result = recordText(input.fullName, "fullName", 500, true);
        issues.push(...result.issues);
        patch.fullName = result.value!;
        if (result.value)
          patch.normalizedForm = result.value.toLocaleLowerCase("en-US");
      }
      if (input.kind !== undefined) {
        const result = recordEnum(
          input.kind,
          "kind",
          PERSON_NAME_KINDS,
          existing.kind,
        );
        issues.push(...result.issues);
        patch.kind = result.value as "legal";
      }
      for (const [key, max] of [
        ["givenName", 200],
        ["middleName", 200],
        ["familyName", 200],
        ["prefix", 100],
        ["suffix", 100],
        ["script", 100],
        ["language", 100],
      ] as const) {
        if (input[key] !== undefined) {
          const result = recordText(input[key], key, max);
          issues.push(...result.issues);
          patch[key] = result.value;
        }
      }
      for (const key of ["validFrom", "validUntil"] as const) {
        if (input[key] !== undefined) {
          const result = recordDate(input[key], key);
          issues.push(...result.issues);
          patch[key] = result.value ?? null;
        }
      }
      for (const [key, allowed, fallback] of [
        [
          "temporalSemantics",
          PERSON_TEMPORAL_SEMANTICS,
          existing.temporalSemantics,
        ],
        [
          "temporalPrecision",
          PERSON_TEMPORAL_PRECISIONS,
          existing.temporalPrecision,
        ],
        ["sensitivity", PERSON_SENSITIVITIES, existing.sensitivity],
        ["state", PERSON_RECORD_STATES, existing.state],
      ] as const) {
        if (input[key] !== undefined) {
          const result = recordEnum(input[key], key, allowed, fallback);
          issues.push(...result.issues);
          patch[key] = result.value as never;
        }
      }
      if (input.confidence !== undefined) {
        const result = recordConfidence(input.confidence);
        issues.push(...result.issues);
        patch.confidence = result.value;
      }
      const validFrom = patch.validFrom ?? existing.validFrom;
      const validUntil = patch.validUntil ?? existing.validUntil;
      if (validFrom && validUntil && validUntil < validFrom)
        issues.push({
          path: ["validUntil"],
          code: "INVALID_RANGE",
          message: "The end date must not precede the start date.",
        });
      if (issues.length) return invalid(issues);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person-name updates are not configured.",
          );
        }
        const dateMaterial = (
          value: Date | string | null | undefined,
        ): CanonicalRequestMaterial =>
          fieldMaterial(value instanceof Date ? value.toISOString() : value);
        const textMaterial = (
          value: string | null | undefined,
        ): CanonicalRequestMaterial =>
          fieldMaterial(
            value === undefined
              ? undefined
              : (value?.normalize("NFKC").trim() ?? null),
          );
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_RECORD_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person_name.update.graphql",
          requestMaterial: {
            confidence: fieldMaterial(input.confidence),
            expectedVersion: input.expectedVersion,
            familyName: textMaterial(input.familyName),
            fullName: textMaterial(input.fullName),
            givenName: textMaterial(input.givenName),
            id: input.id,
            kind: fieldMaterial(
              input.kind === undefined
                ? undefined
                : (input.kind?.trim().toLowerCase() ?? null),
            ),
            language: textMaterial(input.language),
            middleName: textMaterial(input.middleName),
            prefix: textMaterial(input.prefix),
            script: textMaterial(input.script),
            sensitivity: fieldMaterial(
              input.sensitivity === undefined
                ? undefined
                : (input.sensitivity?.toLowerCase() ?? null),
            ),
            state: fieldMaterial(
              input.state === undefined
                ? undefined
                : (input.state?.toLowerCase() ?? null),
            ),
            suffix: textMaterial(input.suffix),
            temporalPrecision: fieldMaterial(
              input.temporalPrecision === undefined
                ? undefined
                : (input.temporalPrecision?.toLowerCase() ?? null),
            ),
            temporalSemantics: fieldMaterial(
              input.temporalSemantics === undefined
                ? undefined
                : (input.temporalSemantics?.toLowerCase() ?? null),
            ),
            validFrom: dateMaterial(input.validFrom),
            validUntil: dateMaterial(input.validUntil),
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["person:update"],
          async (scopedContext) => {
            const outcome = await createPeopleService(scopedContext).updateName(
              { ...input, idempotencyKey: null },
            );
            if (!outcome.resource) {
              throw createGraphQLError(
                outcome.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED",
                "The person name could not be updated.",
              );
            }
            return {
              nameId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayPersonName(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const updated = await writeTransaction(context, async (database) => {
        const scoped = createPeopleRepository(database);
        const row = await scoped.updateNameIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!row) return null;
        await audit.write(database, {
          action: "personName.update",
          resourceKind: "personName",
          resourceId: row.id,
          sensitivity: row.sensitivity,
          changedFields: Object.keys(patch).filter(
            (key) => key !== "updatedAt" && key !== "updatedBy",
          ),
          metadata: { personId: row.personId, version: row.version },
        });
        await maintainPersonSearch(context, database, person);
        return row;
      });
      return updated
        ? { resource: updated, issues: [], code: null }
        : {
            resource: null,
            issues: [],
            code: "CONFLICT",
            currentVersion: existing.version,
          };
    },

    async archiveName(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
    }): Promise<MutationOutcome<PersonNameRow>> {
      const existing = await repository.getNameById({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        !existing ||
        existing.deletedAt ||
        !(await visibleRecord("personName", existing))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const person = await requireRecordPerson(existing.personId);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person-name archives are not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_RECORD_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person_name.archive.graphql",
          requestMaterial: {
            expectedVersion: input.expectedVersion,
            id: input.id,
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["person:delete"],
          async (scopedContext) => {
            const outcome = await createPeopleService(
              scopedContext,
            ).archiveName({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                "CONFLICT",
                "The person name could not be archived.",
              );
            }
            return {
              nameId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayPersonName(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const archived = await writeTransaction(context, async (database) => {
        const row = await createPeopleRepository(database).updateNameIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch: {
            deletedAt: new Date(),
            deletedBy: context.actor.principalId,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          },
        });
        if (!row) return null;
        await audit.write(database, {
          action: "personName.archive",
          resourceKind: "personName",
          resourceId: row.id,
          sensitivity: row.sensitivity,
          changedFields: ["deletedAt"],
          metadata: { personId: row.personId, version: row.version },
        });
        await maintainPersonSearch(context, database, person);
        return row;
      });
      return archived
        ? { resource: archived, issues: [], code: null }
        : {
            resource: null,
            issues: [],
            code: "CONFLICT",
            currentVersion: existing.version,
          };
    },

    async createEvent(input: {
      idempotencyKey?: string | null;
      personId: string;
      eventKind: string;
      title: string;
      description?: string | null;
      placeId?: string | null;
      earliestAt?: Date | string | null;
      latestAt?: Date | string | null;
      temporalSemantics?: string | null;
      temporalPrecision?: string | null;
      confidence?: number | null;
      sensitivity?: string | null;
      state?: string | null;
    }): Promise<MutationOutcome<PersonEventRow>> {
      const person = await requireRecordPerson(input.personId);
      const eventKind = recordText(input.eventKind, "eventKind", 100, true);
      const title = recordText(input.title, "title", 500, true);
      const description = recordText(input.description, "description", 4_000);
      const placeId = input.placeId == null ? null : input.placeId;
      const earliestAt = recordDate(input.earliestAt, "earliestAt");
      const latestAt = recordDate(input.latestAt, "latestAt");
      const temporalSemantics = recordEnum(
        input.temporalSemantics,
        "temporalSemantics",
        PERSON_TEMPORAL_SEMANTICS,
        "unknown",
      );
      const temporalPrecision = recordEnum(
        input.temporalPrecision,
        "temporalPrecision",
        PERSON_TEMPORAL_PRECISIONS,
        "unknown",
      );
      const confidence = recordConfidence(input.confidence);
      const sensitivity = recordEnum(
        input.sensitivity,
        "sensitivity",
        PERSON_SENSITIVITIES,
        "internal",
      );
      const state = recordEnum(
        input.state,
        "state",
        PERSON_RECORD_STATES,
        "asserted",
      );
      const issues = [
        ...eventKind.issues,
        ...title.issues,
        ...description.issues,
        ...earliestAt.issues,
        ...latestAt.issues,
        ...temporalSemantics.issues,
        ...temporalPrecision.issues,
        ...confidence.issues,
        ...sensitivity.issues,
        ...state.issues,
      ];
      if (
        earliestAt.value &&
        latestAt.value &&
        latestAt.value < earliestAt.value
      ) {
        issues.push({
          path: ["latestAt"],
          code: "INVALID_RANGE",
          message: "The end date must not precede the start date.",
        });
      }
      if (placeId && !PERSON_REFERENCE_UUID.test(placeId))
        issues.push({
          path: ["placeId"],
          code: "INVALID_VALUE",
          message: "The place ID is invalid.",
        });
      if (issues.length) return invalid(issues);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person-event creation is not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_RECORD_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person_event.create.graphql",
          requestMaterial: {
            confidence: confidence.value,
            description: description.value ?? null,
            earliestAt: earliestAt.value?.toISOString() ?? null,
            eventKind: eventKind.value!,
            latestAt: latestAt.value?.toISOString() ?? null,
            personId: person.id,
            placeId,
            sensitivity: sensitivity.value!,
            state: state.value!,
            temporalPrecision: temporalPrecision.value!,
            temporalSemantics: temporalSemantics.value!,
            title: title.value!,
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["person:update"],
          async (scopedContext) => {
            const outcome = await createPeopleService(
              scopedContext,
            ).createEvent({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                outcome.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED",
                "The person event could not be created.",
              );
            }
            return {
              eventId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayPersonEvent(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const now = new Date();
      const [row] = await writeTransaction(context, async (database) => {
        const [created] = await database
          .insert(personEvents)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            personId: person.id,
            eventKind: eventKind.value!,
            title: title.value!,
            description: description.value ?? undefined,
            placeId: placeId ?? undefined,
            earliestAt: earliestAt.value ?? null,
            latestAt: latestAt.value ?? null,
            temporalSemantics: temporalSemantics.value as "unknown",
            temporalPrecision: temporalPrecision.value as "unknown",
            confidence: confidence.value,
            sensitivity: sensitivity.value as "internal",
            state: state.value as "asserted",
            createdAt: now,
            createdBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
          })
          .returning();
        if (!created) throw new Error("Person event insert failed");
        await audit.write(database, {
          action: "personEvent.create",
          resourceKind: "personEvent",
          resourceId: created.id,
          sensitivity: created.sensitivity,
          changedFields: ["eventKind", "title", "state", "sensitivity"],
          metadata: { personId: person.id, version: created.version },
        });
        await maintainPersonSearch(context, database, person);
        return [created];
      });
      return { resource: row ?? null, issues: [], code: null };
    },

    async updateEvent(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
      eventKind?: string | null;
      title?: string | null;
      description?: string | null;
      placeId?: string | null;
      earliestAt?: Date | string | null;
      latestAt?: Date | string | null;
      temporalSemantics?: string | null;
      temporalPrecision?: string | null;
      confidence?: number | null;
      sensitivity?: string | null;
      state?: string | null;
    }): Promise<MutationOutcome<PersonEventRow>> {
      const existing = await repository.getEventById({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        !existing ||
        existing.deletedAt !== null ||
        !(await visibleRecord("personEvent", existing))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const person = await requireRecordPerson(existing.personId);
      const patch: Partial<typeof personEvents.$inferInsert> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const issues: ValidationIssue[] = [];
      for (const [key, max, required] of [
        ["eventKind", 100, true],
        ["title", 500, true],
        ["description", 4_000, false],
      ] as const) {
        if (input[key] !== undefined) {
          const result = recordText(input[key], key, max, required);
          issues.push(...result.issues);
          patch[key] = result.value ?? undefined;
        }
      }
      if (input.placeId !== undefined) {
        if (input.placeId && !PERSON_REFERENCE_UUID.test(input.placeId))
          issues.push({
            path: ["placeId"],
            code: "INVALID_VALUE",
            message: "The place ID is invalid.",
          });
        patch.placeId = input.placeId ?? undefined;
      }
      for (const key of ["earliestAt", "latestAt"] as const) {
        if (input[key] !== undefined) {
          const result = recordDate(input[key], key);
          issues.push(...result.issues);
          patch[key] = result.value ?? null;
        }
      }
      for (const [key, allowed, fallback] of [
        [
          "temporalSemantics",
          PERSON_TEMPORAL_SEMANTICS,
          existing.temporalSemantics,
        ],
        [
          "temporalPrecision",
          PERSON_TEMPORAL_PRECISIONS,
          existing.temporalPrecision,
        ],
        ["sensitivity", PERSON_SENSITIVITIES, existing.sensitivity],
        ["state", PERSON_RECORD_STATES, existing.state],
      ] as const) {
        if (input[key] !== undefined) {
          const result = recordEnum(input[key], key, allowed, fallback);
          issues.push(...result.issues);
          patch[key] = result.value as never;
        }
      }
      if (input.confidence !== undefined) {
        const result = recordConfidence(input.confidence);
        issues.push(...result.issues);
        patch.confidence = result.value;
      }
      const earliestAt = patch.earliestAt ?? existing.earliestAt;
      const latestAt = patch.latestAt ?? existing.latestAt;
      if (earliestAt && latestAt && latestAt < earliestAt)
        issues.push({
          path: ["latestAt"],
          code: "INVALID_RANGE",
          message: "The end date must not precede the start date.",
        });
      if (issues.length) return invalid(issues);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person-event updates are not configured.",
          );
        }
        const dateMaterial = (
          value: Date | string | null | undefined,
        ): CanonicalRequestMaterial =>
          fieldMaterial(value instanceof Date ? value.toISOString() : value);
        const textMaterial = (
          value: string | null | undefined,
        ): CanonicalRequestMaterial =>
          fieldMaterial(
            value === undefined
              ? undefined
              : (value?.normalize("NFKC").trim() ?? null),
          );
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_RECORD_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person_event.update.graphql",
          requestMaterial: {
            confidence: fieldMaterial(input.confidence),
            description: textMaterial(input.description),
            earliestAt: dateMaterial(input.earliestAt),
            eventKind: textMaterial(input.eventKind),
            expectedVersion: input.expectedVersion,
            id: input.id,
            latestAt: dateMaterial(input.latestAt),
            placeId: fieldMaterial(input.placeId),
            sensitivity: fieldMaterial(
              input.sensitivity === undefined
                ? undefined
                : (input.sensitivity?.toLowerCase() ?? null),
            ),
            state: fieldMaterial(
              input.state === undefined
                ? undefined
                : (input.state?.toLowerCase() ?? null),
            ),
            temporalPrecision: fieldMaterial(
              input.temporalPrecision === undefined
                ? undefined
                : (input.temporalPrecision?.toLowerCase() ?? null),
            ),
            temporalSemantics: fieldMaterial(
              input.temporalSemantics === undefined
                ? undefined
                : (input.temporalSemantics?.toLowerCase() ?? null),
            ),
            title: textMaterial(input.title),
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["person:update"],
          async (scopedContext) => {
            const outcome = await createPeopleService(
              scopedContext,
            ).updateEvent({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                outcome.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED",
                "The person event could not be updated.",
              );
            }
            return {
              eventId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayPersonEvent(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const updated = await writeTransaction(context, async (database) => {
        const row = await createPeopleRepository(database).updateEventIfVersion(
          {
            workspaceId: context.workspaceId,
            id: input.id,
            expectedVersion: input.expectedVersion,
            patch,
          },
        );
        if (!row) return null;
        await audit.write(database, {
          action: "personEvent.update",
          resourceKind: "personEvent",
          resourceId: row.id,
          sensitivity: row.sensitivity,
          changedFields: Object.keys(patch).filter(
            (key) => key !== "updatedAt" && key !== "updatedBy",
          ),
          metadata: { personId: row.personId, version: row.version },
        });
        await maintainPersonSearch(context, database, person);
        return row;
      });
      return updated
        ? { resource: updated, issues: [], code: null }
        : {
            resource: null,
            issues: [],
            code: "CONFLICT",
            currentVersion: existing.version,
          };
    },

    async archiveEvent(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
    }): Promise<MutationOutcome<PersonEventRow>> {
      const existing = await repository.getEventById({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        !existing ||
        existing.deletedAt ||
        !(await visibleRecord("personEvent", existing))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const person = await requireRecordPerson(existing.personId);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person-event archives are not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_RECORD_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person_event.archive.graphql",
          requestMaterial: {
            expectedVersion: input.expectedVersion,
            id: input.id,
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["person:delete"],
          async (scopedContext) => {
            const outcome = await createPeopleService(
              scopedContext,
            ).archiveEvent({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                "CONFLICT",
                "The person event could not be archived.",
              );
            }
            return {
              eventId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayPersonEvent(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const now = new Date();
      const archived = await writeTransaction(context, async (database) => {
        const row = await createPeopleRepository(database).updateEventIfVersion(
          {
            workspaceId: context.workspaceId,
            id: input.id,
            expectedVersion: input.expectedVersion,
            patch: {
              deletedAt: now,
              deletedBy: context.actor.principalId,
              updatedAt: now,
              updatedBy: context.actor.principalId,
            },
          },
        );
        if (!row) return null;
        await audit.write(database, {
          action: "personEvent.archive",
          resourceKind: "personEvent",
          resourceId: row.id,
          sensitivity: row.sensitivity,
          changedFields: ["deletedAt"],
          metadata: { personId: row.personId, version: row.version },
        });
        await maintainPersonSearch(context, database, person);
        return row;
      });
      return archived
        ? { resource: archived, issues: [], code: null }
        : {
            resource: null,
            issues: [],
            code: "CONFLICT",
            currentVersion: existing.version,
          };
    },

    async listFiles(input: {
      personId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<PersonFileRow>> {
      const page = normalizePagination(input);
      const decoded = decodeResearchCursor(
        page.after,
        PERSON_FILES_CURSOR_ORDER,
      );
      const cursor = decoded
        ? { createdAt: new Date(String(decoded.t)), id: String(decoded.i) }
        : null;
      const rows = await repository.listFiles({
        workspaceId: context.workspaceId,
        personId: input.personId,
        cursor,
        limit: page.first + 1,
        visibility: resourceVisibilitySql(context, {
          resourceKind: "file",
          id: files.id,
          sensitivity: files.sensitivity,
        }),
        personVisibility: visibility,
        factVisibility: context.permissions.has("fact:read")
          ? resourceVisibilitySql(context, {
              resourceKind: "fact",
              id: facts.id,
              sensitivity: facts.sensitivity,
            })
          : sql`false`,
        evidenceVisibility: context.permissions.has("evidence:read")
          ? resourceVisibilitySql(context, {
              resourceKind: "evidence",
              id: evidenceItems.id,
              sensitivity: evidenceItems.sensitivity,
            })
          : sql`false`,
        sourceVisibility: context.permissions.has("source:read")
          ? resourceVisibilitySql(context, {
              resourceKind: "source",
              id: sources.id,
              sensitivity: sources.sensitivity,
            })
          : sql`false`,
        relationshipVisibility: context.permissions.has("relationship:read")
          ? resourceVisibilitySql(context, {
              resourceKind: "relationship",
              id: relationships.id,
              sensitivity: relationships.sensitivity,
            })
          : sql`false`,
        contactVisibility: context.permissions.has("contactPoint:read")
          ? sql`true`
          : sql`false`,
        addressVisibility: context.permissions.has("address:read")
          ? sql`true`
          : sql`false`,
        contactResourceVisibility: context.permissions.has("contactPoint:read")
          ? resourceVisibilitySql(context, {
              resourceKind: "contactPoint",
              id: contactPoints.id,
              sensitivity: contactPoints.sensitivity,
            })
          : sql`false`,
        addressResourceVisibility: context.permissions.has("address:read")
          ? resourceVisibilitySql(context, {
              resourceKind: "address",
              id: addresses.id,
              sensitivity: addresses.sensitivity,
            })
          : sql`false`,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encodeDateCursor(PERSON_FILES_CURSOR_ORDER, last)
            : null,
        },
      };
    },

    async listContradictoryFacts(input: {
      personId: string;
      first?: number | null;
      after?: string | null;
    }): Promise<Connection<typeof facts.$inferSelect>> {
      const page = normalizePagination(input);
      const decoded = decodeResearchCursor(
        page.after,
        CONTRADICTORY_FACTS_CURSOR_ORDER,
      );
      const cursor = decoded
        ? { assertedAt: new Date(String(decoded.t)), id: String(decoded.i) }
        : null;
      const factVisibility = resourceVisibilitySql(context, {
        resourceKind: "fact",
        id: facts.id,
        sensitivity: facts.sensitivity,
      });
      const activeState = sql`${facts.state} NOT IN ('disproven', 'superseded')`;
      const valueFingerprint = sql`md5(concat_ws('|',
        ${facts.valueType},
        ${facts.valueText},
        ${facts.valueDecimal},
        ${facts.valueBoolean},
        ${facts.valueDateStart},
        ${facts.valueDateEnd},
        ${facts.valueTimestamp},
        (${facts.valueJson})::text,
        ${facts.referencedPersonId},
        ${facts.placeId},
        ${facts.fileId},
        CASE
          WHEN ${facts.encryptedValue} IS NOT NULL THEN ${facts.blindIndex}
          ELSE NULL
        END
      ))`;
      const contradictoryFields = context.database
        .select({
          namespace: facts.namespace,
          fieldKey: facts.fieldKey,
        })
        .from(facts)
        .where(
          and(
            eq(facts.workspaceId, context.workspaceId),
            eq(facts.personId, input.personId),
            isNull(facts.deletedAt),
            activeState,
            factVisibility,
          ),
        )
        .groupBy(facts.namespace, facts.fieldKey)
        .having(sql`count(distinct ${valueFingerprint}) > 1`)
        .as("contradictory_fact_fields");
      const rows = await context.database
        .select(getTableColumns(facts))
        .from(facts)
        .innerJoin(
          contradictoryFields,
          and(
            eq(facts.namespace, contradictoryFields.namespace),
            eq(facts.fieldKey, contradictoryFields.fieldKey),
          ),
        )
        .where(
          and(
            eq(facts.workspaceId, context.workspaceId),
            eq(facts.personId, input.personId),
            isNull(facts.deletedAt),
            activeState,
            factVisibility,
            cursor
              ? or(
                  lt(facts.assertedAt, cursor.assertedAt),
                  and(
                    eq(facts.assertedAt, cursor.assertedAt),
                    sql`${facts.id} < ${cursor.id}::uuid`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(facts.assertedAt), desc(facts.id))
        .limit(page.first + 1);
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? Buffer.from(
                JSON.stringify({
                  v: 1,
                  o: CONTRADICTORY_FACTS_CURSOR_ORDER,
                  t: last.assertedAt.toISOString(),
                  i: last.id,
                }),
                "utf8",
              ).toString("base64url")
            : null,
        },
      };
    },

    async create(input: {
      idempotencyKey?: string | null;
      displayName: string;
      sortName?: string | null;
      preferredName?: string | null;
      biography?: string | null;
      status?: string | null;
      sensitivity?: string | null;
      confidence?: number | null;
      confidenceExplanation?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      const displayName = normalizeHumanText(input.displayName, {
        path: ["displayName"],
        min: 1,
        max: 300,
      });
      const sortName =
        input.sortName == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.sortName, {
              path: ["sortName"],
              min: 1,
              max: 300,
            });
      const preferredName =
        input.preferredName == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.preferredName, {
              path: ["preferredName"],
              min: 1,
              max: 300,
            });
      const biography =
        input.biography == null
          ? { value: null, issues: [] as ValidationIssue[] }
          : normalizeHumanText(input.biography, {
              path: ["biography"],
              max: 20_000,
              allowLineBreaks: true,
            });
      const confidence = validateUnitDecimal(input.confidence ?? 1, {
        min: 0,
        max: 1,
        path: ["confidence"],
      });
      const issues = [
        ...displayName.issues,
        ...sortName.issues,
        ...preferredName.issues,
        ...biography.issues,
        ...confidence.issues,
      ];
      const statuses = ["active", "deceased", "missing", "unknown", "archived"];
      const sensitivities = [
        "public",
        "internal",
        "confidential",
        "restricted",
      ];
      const status = (input.status ?? "active").toLowerCase();
      const sensitivity = (input.sensitivity ?? "internal").toLowerCase();
      if (!statuses.includes(status))
        issues.push({
          path: ["status"],
          code: "INVALID_ENUM",
          message: "Invalid person status.",
        });
      if (!sensitivities.includes(sensitivity))
        issues.push({
          path: ["sensitivity"],
          code: "INVALID_ENUM",
          message: "Invalid sensitivity.",
        });
      if (issues.length > 0) return invalid(issues);
      const persist = async (
        writeContext: ResearchServiceContext,
        transaction: typeof context.database,
      ) => {
        const now = new Date();
        const id = newId();
        const scopedRepository = createPeopleRepository(transaction);
        const created = await scopedRepository.create({
          workspaceId: writeContext.workspaceId,
          value: {
            id,
            displayName: displayName.value!,
            sortName: sortName.value,
            preferredName: preferredName.value,
            biography: biography.value,
            status: status as PersonRow["status"],
            sensitivity: sensitivity as PersonRow["sensitivity"],
            confidence: confidence.value ?? "1",
            confidenceExplanation: input.confidenceExplanation?.trim() || null,
            createdAt: now,
            createdBy: writeContext.actor.principalId,
            updatedAt: now,
            updatedBy: writeContext.actor.principalId,
          },
        });
        await createAuditService(writeContext).write(transaction, {
          action: "person.create",
          resourceKind: "person",
          resourceId: created.id,
          sensitivity: created.sensitivity,
          changedFields: [
            "displayName",
            "sortName",
            "preferredName",
            "biography",
            "status",
            "sensitivity",
            "confidence",
          ],
          metadata: {
            status: created.status,
            sensitivity: created.sensitivity,
            version: created.version,
          },
        });
        await applySearchIndexMaintenance(writeContext, transaction, [
          {
            action: "upsert",
            sourceId: created.id,
            sourceKind: "person",
            sourceVersion: created.version,
            workspaceId: writeContext.workspaceId,
          },
        ]);
        return created;
      };
      const idempotencyKey = input.idempotencyKey;
      if (idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person creation is not configured.",
          );
        }
        const idempotency = deriveResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_IDEMPOTENCY_TTL_MS),
          idempotencyKey,
          operation: "person.create",
          requestMaterial: {
            biography: biography.value ?? null,
            confidence: confidence.value ?? "1",
            confidenceExplanation: input.confidenceExplanation?.trim() || null,
            displayName: displayName.value ?? "",
            preferredName: preferredName.value ?? null,
            sensitivity,
            sortName: sortName.value ?? null,
            status,
          },
          secret,
        });
        const result = await runIdempotentResearchWrite(
          context,
          idempotency,
          ["person:create"],
          async (scopedContext) => {
            const created = await persist(
              scopedContext,
              scopedContext.database,
            );
            return { personId: created.id };
          },
        );
        const personId = result.responseReference.personId;
        if (
          typeof personId !== "string" ||
          !PERSON_REFERENCE_UUID.test(personId)
        ) {
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The operation response reference is invalid.",
          );
        }
        const replayed = await repository.getById({
          workspaceId: context.workspaceId,
          id: personId,
        });
        if (!replayed || !(await visible(replayed))) {
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        }
        return { resource: replayed, issues: [], code: null };
      }
      const row = await writeTransaction(context, async (transaction) =>
        persist(context, transaction),
      );
      return { resource: row, issues: [], code: null };
    },

    async update(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
      displayName?: string | null;
      sortName?: string | null;
      preferredName?: string | null;
      biography?: string | null;
      status?: string | null;
      sensitivity?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      const issues = validateVersion(input.expectedVersion);
      if (issues.length > 0) return invalid(issues);
      const current = await repository.getById({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        (!current && input.idempotencyKey == null) ||
        (current && !(await visible(current))) ||
        (!current &&
          input.idempotencyKey != null &&
          !(await visibleRetryTarget(input.id)))
      ) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      }
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const changedFields: string[] = [];
      for (const [key, value, max] of [
        ["displayName", input.displayName, 300],
        ["sortName", input.sortName, 300],
        ["preferredName", input.preferredName, 300],
        ["biography", input.biography, 20_000],
      ] as const) {
        if (value === undefined) continue;
        if (value === null && key !== "displayName") patch[key] = null;
        else {
          const normalized = normalizeHumanText(value, {
            path: [key],
            min: 1,
            max,
            allowLineBreaks: key === "biography",
          });
          if (normalized.issues.length > 0) issues.push(...normalized.issues);
          else patch[key] = normalized.value;
        }
        changedFields.push(key);
      }
      if (input.status !== undefined) {
        const status = input.status?.toLowerCase();
        if (
          !status ||
          !["active", "deceased", "missing", "unknown"].includes(status)
        )
          issues.push({
            path: ["status"],
            code: "INVALID_ENUM",
            message: "Invalid person status.",
          });
        else patch.status = status;
        changedFields.push("status");
      }
      if (input.sensitivity !== undefined) {
        const sensitivity = input.sensitivity?.toLowerCase();
        if (
          !sensitivity ||
          !["public", "internal", "confidential", "restricted"].includes(
            sensitivity,
          )
        )
          issues.push({
            path: ["sensitivity"],
            code: "INVALID_ENUM",
            message: "Invalid sensitivity.",
          });
        else patch.sensitivity = sensitivity;
        changedFields.push("sensitivity");
      }
      if (issues.length > 0) return invalid(issues);
      const persist = async (
        writeContext: ResearchServiceContext,
        transaction: typeof context.database,
      ) => {
        const scoped = createPeopleRepository(
          transaction as unknown as typeof context.database,
        );
        const row = await scoped.updateIfVersion({
          workspaceId: writeContext.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!row) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.update",
          resourceKind: "person",
          resourceId: row.id,
          sensitivity: row.sensitivity,
          changedFields,
          metadata: {
            status: row.status,
            sensitivity: row.sensitivity,
            version: row.version,
          },
        });
        await applySearchIndexMaintenance(writeContext, transaction, [
          {
            action: "upsert",
            sourceId: row.id,
            sourceKind: "person",
            sourceVersion: row.version,
            workspaceId: writeContext.workspaceId,
          },
        ]);
        return row;
      };
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person updates are not configured.",
          );
        }
        const idempotency = deriveResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person.update",
          requestMaterial: {
            biography: {
              present: input.biography !== undefined,
              value:
                patch.biography === undefined
                  ? null
                  : (patch.biography as string | null),
            },
            displayName: {
              present: input.displayName !== undefined,
              value:
                patch.displayName === undefined
                  ? null
                  : (patch.displayName as string | null),
            },
            expectedVersion: input.expectedVersion,
            id: input.id,
            preferredName: {
              present: input.preferredName !== undefined,
              value:
                patch.preferredName === undefined
                  ? null
                  : (patch.preferredName as string | null),
            },
            sensitivity: {
              present: input.sensitivity !== undefined,
              value:
                patch.sensitivity === undefined
                  ? null
                  : (patch.sensitivity as string | null),
            },
            sortName: {
              present: input.sortName !== undefined,
              value:
                patch.sortName === undefined
                  ? null
                  : (patch.sortName as string | null),
            },
            status: {
              present: input.status !== undefined,
              value:
                patch.status === undefined
                  ? null
                  : (patch.status as string | null),
            },
          },
          secret,
        });
        const result = await runIdempotentResearchWrite(
          context,
          idempotency,
          ["person:update"],
          async (scopedContext) => {
            const row = await persist(scopedContext, scopedContext.database);
            if (!row) {
              throw createGraphQLError(
                "CONFLICT",
                "The person was changed by another request.",
              );
            }
            return { personId: row.id, version: row.version };
          },
        );
        const replayed = await replayPerson(result.responseReference);
        return { resource: replayed, issues: [], code: null };
      }
      const updated = await writeTransaction(context, async (transaction) =>
        persist(context, transaction),
      );
      if (!updated) {
        const latest = await repository.getById({
          workspaceId: context.workspaceId,
          id: input.id,
        });
        if (!latest || !(await visible(latest)))
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        return {
          resource: null,
          issues: [],
          code: "CONFLICT",
          currentVersion: latest.version,
        };
      }
      return { resource: updated, issues: [], code: null };
    },

    async archive(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      const current = await repository.getById({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      const retryTargetVisible =
        !current && input.idempotencyKey != null
          ? await visibleRetryTarget(input.id)
          : false;
      if (
        (!current && !retryTargetVisible) ||
        (current !== null &&
          current.deletedAt === null &&
          !(await visible(current))) ||
        (current !== null &&
          current.deletedAt !== null &&
          input.idempotencyKey == null) ||
        (current !== null &&
          current.deletedAt !== null &&
          input.idempotencyKey != null &&
          !(await visibleRetryTarget(input.id)))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const persist = async (
        writeContext: ResearchServiceContext,
        transaction: typeof context.database,
      ) => {
        const now = new Date();
        const scoped = createPeopleRepository(
          transaction as unknown as typeof context.database,
        );
        const row = await scoped.updateIfVersion({
          workspaceId: writeContext.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch: {
            status: "archived",
            deletedAt: now,
            deletedBy: writeContext.actor.principalId,
            updatedAt: now,
            updatedBy: writeContext.actor.principalId,
          },
        });
        if (!row) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.archive",
          resourceKind: "person",
          resourceId: row.id,
          sensitivity: row.sensitivity,
          changedFields: ["status", "deletedAt"],
          metadata: { status: "archived", version: row.version },
        });
        await applySearchIndexMaintenance(writeContext, transaction, [
          {
            action: "remove",
            sourceId: row.id,
            sourceKind: "person",
            sourceVersion: row.version,
            workspaceId: writeContext.workspaceId,
          },
        ]);
        return row;
      };
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person archives are not configured.",
          );
        }
        const idempotency = deriveResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person.archive",
          requestMaterial: {
            expectedVersion: input.expectedVersion,
            id: input.id,
          },
          secret,
        });
        const result = await runIdempotentResearchWrite(
          context,
          idempotency,
          ["person:delete"],
          async (scopedContext) => {
            if (
              current?.deletedAt !== null &&
              current?.deletedAt !== undefined
            ) {
              throw createGraphQLError(
                "CONFLICT",
                "The person was already archived.",
              );
            }
            const row = await persist(scopedContext, scopedContext.database);
            if (!row) {
              throw createGraphQLError(
                "CONFLICT",
                "The person was changed by another request.",
              );
            }
            return { personId: row.id, version: row.version };
          },
        );
        const replayed = await replayPerson(result.responseReference);
        return { resource: replayed, issues: [], code: null };
      }
      const archived = await writeTransaction(context, async (transaction) =>
        persist(context, transaction),
      );
      if (!archived)
        return {
          resource: null,
          issues: [],
          code: "CONFLICT",
          currentVersion: current?.version ?? null,
        };
      return { resource: archived, issues: [], code: null };
    },
    async merge(input: {
      winnerPersonId: string;
      loserPersonId: string;
      reason: string;
      idempotencyKey?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      if (!context.permissions.has("person:merge")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "Person merging is not permitted.",
        );
      }
      if (
        input.winnerPersonId === input.loserPersonId ||
        input.reason.trim().length < 1
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "A distinct winner, loser, and reason are required.",
        );
      }
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person merges are not configured.",
          );
        }
        const idempotency = deriveResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person.merge",
          requestMaterial: {
            loserPersonId: input.loserPersonId,
            reason: input.reason.trim(),
            winnerPersonId: input.winnerPersonId,
          },
          secret,
        });
        const result = await runIdempotentResearchWrite(
          context,
          idempotency,
          ["person:merge"],
          async (scopedContext) => {
            const outcome = await createPeopleService(scopedContext).merge({
              loserPersonId: input.loserPersonId,
              reason: input.reason,
              winnerPersonId: input.winnerPersonId,
            });
            if (!outcome.resource) {
              throw createGraphQLError(
                "CONFLICT",
                "The people were changed by another request.",
              );
            }
            return {
              personId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        const replayed = await replayPerson(result.responseReference);
        return { resource: replayed, issues: [], code: null };
      }
      const merged = await writeTransaction(context, async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${context.workspaceId}, 19017))`,
        );
        const rows = await transaction
          .select()
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.winnerPersonId),
              isNull(people.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        const loserRows = await transaction
          .select()
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.loserPersonId),
              isNull(people.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        const winner = rows[0];
        const loser = loserRows[0];
        if (
          !winner ||
          !loser ||
          winner.status === "merged" ||
          loser.status === "merged"
        ) {
          throw createGraphQLError(
            "NOT_FOUND",
            "The people selected for merge were not found.",
          );
        }
        const mergeRowLimit = 10_001;
        const relationshipRows = await transaction
          .select({
            id: relationships.id,
            sourcePersonId: relationships.sourcePersonId,
            targetPersonId: relationships.targetPersonId,
          })
          .from(relationships)
          .where(
            and(
              eq(relationships.workspaceId, context.workspaceId),
              isNull(relationships.deletedAt),
              or(
                eq(relationships.sourcePersonId, loser.id),
                eq(relationships.targetPersonId, loser.id),
              ),
            ),
          )
          .limit(mergeRowLimit);
        const factRows = await transaction
          .select({ id: facts.id })
          .from(facts)
          .where(
            and(
              eq(facts.workspaceId, context.workspaceId),
              eq(facts.personId, loser.id),
              isNull(facts.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const selectedFacts = await transaction
          .select({ factId: personFieldSelections.factId })
          .from(personFieldSelections)
          .where(
            and(
              eq(personFieldSelections.workspaceId, context.workspaceId),
              eq(personFieldSelections.personId, loser.id),
              isNull(personFieldSelections.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const referencedFactRows = await transaction
          .select({ id: facts.id })
          .from(facts)
          .where(
            and(
              eq(facts.workspaceId, context.workspaceId),
              eq(facts.referencedPersonId, loser.id),
              isNull(facts.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const nameRows = await transaction
          .select({ id: personNames.id })
          .from(personNames)
          .where(
            and(
              eq(personNames.workspaceId, context.workspaceId),
              eq(personNames.personId, loser.id),
              isNull(personNames.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const identifierRows = await transaction
          .select({ id: personIdentifiers.id })
          .from(personIdentifiers)
          .where(
            and(
              eq(personIdentifiers.workspaceId, context.workspaceId),
              eq(personIdentifiers.personId, loser.id),
              isNull(personIdentifiers.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const eventRows = await transaction
          .select({ id: personEvents.id })
          .from(personEvents)
          .where(
            and(
              eq(personEvents.workspaceId, context.workspaceId),
              eq(personEvents.personId, loser.id),
              isNull(personEvents.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const externalRows = await transaction
          .select({ id: externalRecords.id })
          .from(externalRecords)
          .where(
            and(
              eq(externalRecords.workspaceId, context.workspaceId),
              eq(externalRecords.personId, loser.id),
              isNull(externalRecords.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const noteRows = await transaction
          .select({ id: notes.id })
          .from(notes)
          .where(
            and(
              eq(notes.workspaceId, context.workspaceId),
              eq(notes.personId, loser.id),
              isNull(notes.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const consentRows = await transaction
          .select({ id: consentRecords.id })
          .from(consentRecords)
          .where(
            and(
              eq(consentRecords.workspaceId, context.workspaceId),
              eq(consentRecords.personId, loser.id),
              isNull(consentRecords.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const contactRows = await transaction
          .select({
            id: personContactPoints.id,
            isPrimary: personContactPoints.isPrimary,
            usageKind: personContactPoints.usageKind,
            validUntil: personContactPoints.validUntil,
          })
          .from(personContactPoints)
          .where(
            and(
              eq(personContactPoints.workspaceId, context.workspaceId),
              eq(personContactPoints.personId, loser.id),
              isNull(personContactPoints.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const addressRows = await transaction
          .select({
            id: personAddresses.id,
            isPrimary: personAddresses.isPrimary,
            addressKind: personAddresses.addressKind,
            validUntil: personAddresses.validUntil,
          })
          .from(personAddresses)
          .where(
            and(
              eq(personAddresses.workspaceId, context.workspaceId),
              eq(personAddresses.personId, loser.id),
              isNull(personAddresses.deletedAt),
            ),
          )
          .limit(mergeRowLimit);
        const loserTagRows = await transaction
          .select({ id: personTags.id, tagId: personTags.tagId })
          .from(personTags)
          .where(
            and(
              eq(personTags.workspaceId, context.workspaceId),
              eq(personTags.personId, loser.id),
            ),
          )
          .limit(mergeRowLimit);
        const winnerTagRows = await transaction
          .select({ tagId: personTags.tagId })
          .from(personTags)
          .where(
            and(
              eq(personTags.workspaceId, context.workspaceId),
              eq(personTags.personId, winner.id),
            ),
          )
          .limit(mergeRowLimit);
        const candidateRows = await transaction
          .select({
            id: identityCandidates.id,
            state: identityCandidates.state,
            reviewedAt: identityCandidates.reviewedAt,
            reviewedBy: identityCandidates.reviewedBy,
            reviewReason: identityCandidates.reviewReason,
          })
          .from(identityCandidates)
          .where(
            and(
              eq(identityCandidates.workspaceId, context.workspaceId),
              isNull(identityCandidates.deletedAt),
              or(
                eq(identityCandidates.firstPersonId, loser.id),
                eq(identityCandidates.secondPersonId, loser.id),
              ),
            ),
          )
          .limit(mergeRowLimit);
        const oversized = [
          relationshipRows,
          factRows,
          referencedFactRows,
          nameRows,
          identifierRows,
          eventRows,
          externalRows,
          noteRows,
          consentRows,
          contactRows,
          addressRows,
          loserTagRows,
          candidateRows,
        ].some((rows) => rows.length >= mergeRowLimit);
        if (oversized) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The selected person has too many dependent records for one reversible merge; archive or merge in smaller steps.",
          );
        }
        const selectedFactIds = new Set(selectedFacts.map((row) => row.factId));
        const movableFactIds = factRows
          .map((row) => row.id)
          .filter((id) => !selectedFactIds.has(id));
        const winnerTagIds = new Set(winnerTagRows.map((row) => row.tagId));
        const movableTagRows = loserTagRows.filter(
          (row) => !winnerTagIds.has(row.tagId),
        );
        const decisionId = newId();
        // The composite person/name foreign key requires clearing the loser
        // presentation pointer before its names are moved.
        if (loser.primaryNameId) {
          await transaction
            .update(people)
            .set({ primaryNameId: null })
            .where(
              and(
                eq(people.workspaceId, context.workspaceId),
                eq(people.id, loser.id),
              ),
            );
        }
        if (relationshipRows.length) {
          await transaction
            .update(relationships)
            .set({
              sourcePersonId: sql`case when ${relationships.sourcePersonId} = ${loser.id} then ${winner.id} else ${relationships.sourcePersonId} end`,
              targetPersonId: sql`case when ${relationships.targetPersonId} = ${loser.id} then ${winner.id} else ${relationships.targetPersonId} end`,
            })
            .where(
              and(
                eq(relationships.workspaceId, context.workspaceId),
                inArray(
                  relationships.id,
                  relationshipRows.map((row) => row.id),
                ),
              ),
            );
        }
        if (movableFactIds.length) {
          await transaction
            .update(facts)
            .set({ personId: winner.id })
            .where(
              and(
                eq(facts.workspaceId, context.workspaceId),
                inArray(facts.id, movableFactIds),
              ),
            );
        }
        if (referencedFactRows.length) {
          await transaction
            .update(facts)
            .set({ referencedPersonId: winner.id })
            .where(
              and(
                eq(facts.workspaceId, context.workspaceId),
                inArray(
                  facts.id,
                  referencedFactRows.map((row) => row.id),
                ),
              ),
            );
        }
        const winnerContactPrimaries = await transaction
          .select({ usageKind: personContactPoints.usageKind })
          .from(personContactPoints)
          .where(
            and(
              eq(personContactPoints.workspaceId, context.workspaceId),
              eq(personContactPoints.personId, winner.id),
              eq(personContactPoints.isPrimary, true),
              isNull(personContactPoints.validUntil),
              isNull(personContactPoints.deletedAt),
            ),
          );
        const winnerContactPrimaryKinds = new Set(
          winnerContactPrimaries.map((row) => row.usageKind),
        );
        const demoteContactIds = contactRows
          .filter(
            (row) =>
              row.isPrimary &&
              row.validUntil === null &&
              winnerContactPrimaryKinds.has(row.usageKind),
          )
          .map((row) => row.id);
        if (demoteContactIds.length) {
          await transaction
            .update(personContactPoints)
            .set({ isPrimary: false })
            .where(
              and(
                eq(personContactPoints.workspaceId, context.workspaceId),
                inArray(personContactPoints.id, demoteContactIds),
              ),
            );
        }
        const winnerAddressPrimaries = await transaction
          .select({ addressKind: personAddresses.addressKind })
          .from(personAddresses)
          .where(
            and(
              eq(personAddresses.workspaceId, context.workspaceId),
              eq(personAddresses.personId, winner.id),
              eq(personAddresses.isPrimary, true),
              isNull(personAddresses.validUntil),
              isNull(personAddresses.deletedAt),
            ),
          );
        const winnerAddressPrimaryKinds = new Set(
          winnerAddressPrimaries.map((row) => row.addressKind),
        );
        const demoteAddressIds = addressRows
          .filter(
            (row) =>
              row.isPrimary &&
              row.validUntil === null &&
              winnerAddressPrimaryKinds.has(row.addressKind),
          )
          .map((row) => row.id);
        if (demoteAddressIds.length) {
          await transaction
            .update(personAddresses)
            .set({ isPrimary: false })
            .where(
              and(
                eq(personAddresses.workspaceId, context.workspaceId),
                inArray(personAddresses.id, demoteAddressIds),
              ),
            );
        }
        if (contactRows.length) {
          await transaction
            .update(personContactPoints)
            .set({ personId: winner.id })
            .where(
              and(
                eq(personContactPoints.workspaceId, context.workspaceId),
                inArray(
                  personContactPoints.id,
                  contactRows.map((row) => row.id),
                ),
              ),
            );
        }
        if (addressRows.length) {
          await transaction
            .update(personAddresses)
            .set({ personId: winner.id })
            .where(
              and(
                eq(personAddresses.workspaceId, context.workspaceId),
                inArray(
                  personAddresses.id,
                  addressRows.map((row) => row.id),
                ),
              ),
            );
        }
        if (movableTagRows.length) {
          await transaction
            .update(personTags)
            .set({ personId: winner.id })
            .where(
              and(
                eq(personTags.workspaceId, context.workspaceId),
                inArray(
                  personTags.id,
                  movableTagRows.map((row) => row.id),
                ),
              ),
            );
        }
        const dependentUpdates = [
          [personNames, nameRows.map((row) => row.id)],
          [personIdentifiers, identifierRows.map((row) => row.id)],
          [personEvents, eventRows.map((row) => row.id)],
          [externalRecords, externalRows.map((row) => row.id)],
          [notes, noteRows.map((row) => row.id)],
          [consentRecords, consentRows.map((row) => row.id)],
        ] as const;
        for (const [table, ids] of dependentUpdates) {
          if (!ids.length) continue;
          await transaction
            .update(table)
            .set({ personId: winner.id })
            .where(
              and(
                eq(table.workspaceId, context.workspaceId),
                inArray(table.id, ids),
              ),
            );
        }
        if (candidateRows.length) {
          await transaction
            .update(identityCandidates)
            .set({
              state: "cancelled",
              reviewedAt: new Date(),
              reviewedBy: context.actor.principalId,
              reviewReason: `merge:${decisionId}`,
              version: sql`${identityCandidates.version} + 1`,
              updatedAt: new Date(),
              updatedBy: context.actor.principalId,
            })
            .where(
              and(
                eq(identityCandidates.workspaceId, context.workspaceId),
                inArray(
                  identityCandidates.id,
                  candidateRows.map((row) => row.id),
                ),
                isNull(identityCandidates.deletedAt),
              ),
            );
        }
        await transaction.insert(mergeDecisions).values({
          id: decisionId,
          workspaceId: context.workspaceId,
          winnerPersonId: winner.id,
          loserPersonId: loser.id,
          reason: input.reason.trim().slice(0, 2048),
          fieldChoices: {
            selectedFactIds: [...selectedFactIds],
            preservedLoserFactIds: factRows
              .map((row) => row.id)
              .filter((id) => selectedFactIds.has(id)),
          },
          reversibleSnapshot: {
            loser: {
              status: loser.status,
              mergedIntoPersonId: loser.mergedIntoPersonId,
              version: loser.version,
              primaryNameId: loser.primaryNameId,
            },
            relationships: relationshipRows,
            facts: movableFactIds,
            referencedFacts: referencedFactRows.map((row) => row.id),
            personNames: nameRows.map((row) => row.id),
            personIdentifiers: identifierRows.map((row) => row.id),
            personEvents: eventRows.map((row) => row.id),
            externalRecords: externalRows.map((row) => row.id),
            notes: noteRows.map((row) => row.id),
            consentRecords: consentRows.map((row) => row.id),
            contactPoints: contactRows.map((row) => ({
              id: row.id,
              isPrimary: row.isPrimary,
            })),
            addresses: addressRows.map((row) => ({
              id: row.id,
              isPrimary: row.isPrimary,
            })),
            personTags: movableTagRows.map((row) => row.id),
            identityCandidates: candidateRows.map((row) => ({
              id: row.id,
              state: row.state,
              reviewedAt: row.reviewedAt,
              reviewedBy: row.reviewedBy,
              reviewReason: row.reviewReason,
            })),
          },
          decidedBy: context.actor.principalId,
          createdBy: context.actor.principalId,
          updatedBy: context.actor.principalId,
        });
        const [updated] = await transaction
          .update(people)
          .set({
            status: "merged",
            mergedIntoPersonId: winner.id,
            version: sql`${people.version} + 1`,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
            primaryNameId: null,
          })
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, loser.id),
              eq(people.version, loser.version),
            ),
          )
          .returning();
        if (!updated) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.merge",
          resourceKind: "person",
          resourceId: winner.id,
          sensitivity: winner.sensitivity,
          changedFields: ["mergedIntoPersonId", "status", "dependentRecords"],
          metadata: { loserPersonId: loser.id, mergeDecisionId: decisionId },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: winner.id,
            sourceKind: "person",
            sourceVersion: winner.version,
            workspaceId: context.workspaceId,
          },
          {
            action: "remove",
            sourceId: loser.id,
            sourceKind: "person",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return winner;
      });
      if (!merged) return { resource: null, issues: [], code: "CONFLICT" };
      return { resource: merged, issues: [], code: null };
    },
    async unmerge(input: {
      loserPersonId: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      if (!context.permissions.has("person:merge")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "Person merging is not permitted.",
        );
      }
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person unmerges are not configured.",
          );
        }
        const versionIssues = validateVersion(input.expectedVersion);
        if (versionIssues.length) return invalid(versionIssues);
        const idempotency = deriveResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person.unmerge",
          requestMaterial: {
            expectedVersion: input.expectedVersion,
            loserPersonId: input.loserPersonId,
          },
          secret,
        });
        const result = await runIdempotentResearchWrite(
          context,
          idempotency,
          ["person:merge"],
          async (scopedContext) => {
            const outcome = await createPeopleService(scopedContext).unmerge({
              expectedVersion: input.expectedVersion,
              loserPersonId: input.loserPersonId,
            });
            if (!outcome.resource) {
              throw createGraphQLError(
                "CONFLICT",
                "The person was changed by another request.",
              );
            }
            return {
              personId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        const replayed = await replayPerson(result.responseReference);
        return { resource: replayed, issues: [], code: null };
      }
      const restored = await writeTransaction(context, async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${context.workspaceId}, 19017))`,
        );
        const [loser] = await transaction
          .select()
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.loserPersonId),
              eq(people.status, "merged"),
              eq(people.version, input.expectedVersion),
            ),
          )
          .limit(1)
          .for("update");
        if (!loser) return null;
        const [decision] = await transaction
          .select()
          .from(mergeDecisions)
          .where(
            and(
              eq(mergeDecisions.workspaceId, context.workspaceId),
              eq(mergeDecisions.loserPersonId, loser.id),
              isNull(mergeDecisions.deletedAt),
            ),
          )
          .orderBy(sql`${mergeDecisions.decidedAt} desc`)
          .limit(1)
          .for("update");
        if (!decision) return null;
        const snapshot = decision.reversibleSnapshot as {
          loser?: {
            status?: string;
            version?: number;
            primaryNameId?: string | null;
          };
          relationships?: readonly {
            id: string;
            sourcePersonId: string;
            targetPersonId: string;
          }[];
          facts?: readonly string[];
          referencedFacts?: readonly string[];
          personNames?: readonly string[];
          personIdentifiers?: readonly string[];
          personEvents?: readonly string[];
          externalRecords?: readonly string[];
          notes?: readonly string[];
          consentRecords?: readonly string[];
          contactPoints?: readonly { id: string; isPrimary: boolean }[];
          addresses?: readonly { id: string; isPrimary: boolean }[];
          personTags?: readonly string[];
          identityCandidates?: readonly {
            id: string;
            state:
              "pending" | "reviewing" | "accepted" | "rejected" | "cancelled";
            reviewedAt: Date | null;
            reviewedBy: string | null;
            reviewReason: string | null;
          }[];
        };
        const status =
          snapshot.loser?.status &&
          ["active", "deceased", "missing", "unknown", "archived"].includes(
            snapshot.loser.status,
          )
            ? snapshot.loser.status
            : "unknown";
        const relationshipsToRestore = snapshot.relationships ?? [];
        for (const relationship of relationshipsToRestore) {
          await transaction
            .update(relationships)
            .set({
              sourcePersonId: relationship.sourcePersonId,
              targetPersonId: relationship.targetPersonId,
            })
            .where(
              and(
                eq(relationships.workspaceId, context.workspaceId),
                eq(relationships.id, relationship.id),
              ),
            );
        }
        if (snapshot.facts?.length) {
          await transaction
            .update(facts)
            .set({ personId: loser.id })
            .where(
              and(
                eq(facts.workspaceId, context.workspaceId),
                inArray(facts.id, [...snapshot.facts]),
              ),
            );
        }
        if (snapshot.referencedFacts?.length) {
          await transaction
            .update(facts)
            .set({ referencedPersonId: loser.id })
            .where(
              and(
                eq(facts.workspaceId, context.workspaceId),
                inArray(facts.id, [...snapshot.referencedFacts]),
              ),
            );
        }
        const dependentRestores = [
          [personNames, snapshot.personNames],
          [personIdentifiers, snapshot.personIdentifiers],
          [personEvents, snapshot.personEvents],
          [externalRecords, snapshot.externalRecords],
          [notes, snapshot.notes],
          [consentRecords, snapshot.consentRecords],
        ] as const;
        for (const [table, ids] of dependentRestores) {
          if (!ids?.length) continue;
          await transaction
            .update(table)
            .set({ personId: loser.id })
            .where(
              and(
                eq(table.workspaceId, context.workspaceId),
                inArray(table.id, [...ids]),
              ),
            );
        }
        if (snapshot.contactPoints?.length) {
          await transaction
            .update(personContactPoints)
            .set({ personId: loser.id })
            .where(
              and(
                eq(personContactPoints.workspaceId, context.workspaceId),
                inArray(
                  personContactPoints.id,
                  snapshot.contactPoints.map((row) => row.id),
                ),
              ),
            );
          for (const row of snapshot.contactPoints) {
            await transaction
              .update(personContactPoints)
              .set({ isPrimary: row.isPrimary })
              .where(
                and(
                  eq(personContactPoints.workspaceId, context.workspaceId),
                  eq(personContactPoints.id, row.id),
                ),
              );
          }
        }
        if (snapshot.addresses?.length) {
          await transaction
            .update(personAddresses)
            .set({ personId: loser.id })
            .where(
              and(
                eq(personAddresses.workspaceId, context.workspaceId),
                inArray(
                  personAddresses.id,
                  snapshot.addresses.map((row) => row.id),
                ),
              ),
            );
          for (const row of snapshot.addresses) {
            await transaction
              .update(personAddresses)
              .set({ isPrimary: row.isPrimary })
              .where(
                and(
                  eq(personAddresses.workspaceId, context.workspaceId),
                  eq(personAddresses.id, row.id),
                ),
              );
          }
        }
        if (snapshot.personTags?.length) {
          await transaction
            .update(personTags)
            .set({ personId: loser.id })
            .where(
              and(
                eq(personTags.workspaceId, context.workspaceId),
                eq(personTags.personId, decision.winnerPersonId),
                inArray(personTags.id, [...snapshot.personTags]),
              ),
            );
        }
        if (snapshot.identityCandidates?.length) {
          for (const candidate of snapshot.identityCandidates) {
            await transaction
              .update(identityCandidates)
              .set({
                state: candidate.state,
                reviewedAt: candidate.reviewedAt,
                reviewedBy: candidate.reviewedBy,
                reviewReason: candidate.reviewReason,
                version: sql`${identityCandidates.version} + 1`,
                updatedAt: new Date(),
                updatedBy: context.actor.principalId,
              })
              .where(
                and(
                  eq(identityCandidates.workspaceId, context.workspaceId),
                  eq(identityCandidates.id, candidate.id),
                  eq(identityCandidates.state, "cancelled"),
                  eq(identityCandidates.reviewReason, `merge:${decision.id}`),
                  isNull(identityCandidates.deletedAt),
                ),
              );
          }
        }
        const [updated] = await transaction
          .update(people)
          .set({
            status: status as PersonRow["status"],
            mergedIntoPersonId: null,
            primaryNameId: snapshot.loser?.primaryNameId ?? null,
            version: sql`${people.version} + 1`,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          })
          .where(
            and(
              eq(people.id, loser.id),
              eq(people.workspaceId, context.workspaceId),
              eq(people.version, loser.version),
            ),
          )
          .returning();
        if (!updated) return null;
        await transaction
          .update(mergeDecisions)
          .set({
            deletedAt: new Date(),
            deletedBy: context.actor.principalId,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
            version: sql`${mergeDecisions.version} + 1`,
          })
          .where(eq(mergeDecisions.id, decision.id));
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.unmerge",
          resourceKind: "person",
          resourceId: loser.id,
          sensitivity: loser.sensitivity,
          changedFields: ["mergedIntoPersonId", "status"],
          metadata: { mergeDecisionId: decision.id },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: loser.id,
            sourceKind: "person",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      if (!restored) return { resource: null, issues: [], code: "CONFLICT" };
      return { resource: restored, issues: [], code: null };
    },
    async selectPresentation(input: {
      personId: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
      primaryNameId?: string | null;
      primaryPhotoFileId?: string | null;
    }): Promise<MutationOutcome<PersonRow>> {
      if (!context.permissions.has("person:update")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "Person presentation updates are not permitted.",
        );
      }
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent person presentation updates are not configured.",
          );
        }
        const idempotency = deriveResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + PERSON_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "person.presentation.select",
          requestMaterial: {
            expectedVersion: input.expectedVersion,
            personId: input.personId,
            primaryNameId: fieldMaterial(input.primaryNameId),
            primaryPhotoFileId: fieldMaterial(input.primaryPhotoFileId),
          },
          secret,
        });
        const result = await runIdempotentResearchWrite(
          context,
          idempotency,
          ["person:update"],
          async (scopedContext) => {
            const outcome = await createPeopleService(
              scopedContext,
            ).selectPresentation({
              ...input,
              idempotencyKey: null,
            });
            if (!outcome.resource) {
              throw createGraphQLError(
                "CONFLICT",
                "The person presentation was changed by another request.",
              );
            }
            return {
              personId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayPerson(result.responseReference),
          issues: [],
          code: null,
        };
      }
      const result = await writeTransaction(context, async (transaction) => {
        const [current] = await transaction
          .select()
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.personId),
              isNull(people.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!current) return null;
        if (input.primaryNameId !== undefined && input.primaryNameId !== null) {
          const [name] = await transaction
            .select({ id: personNames.id })
            .from(personNames)
            .where(
              and(
                eq(personNames.workspaceId, context.workspaceId),
                eq(personNames.personId, input.personId),
                eq(personNames.id, input.primaryNameId),
                isNull(personNames.deletedAt),
              ),
            )
            .limit(1)
            .for("share");
          if (!name)
            throw createGraphQLError(
              "VALIDATION_FAILED",
              "The selected primary name does not belong to this person.",
            );
        }
        if (
          input.primaryPhotoFileId !== undefined &&
          input.primaryPhotoFileId !== null
        ) {
          const [photo] = await transaction
            .select({ id: files.id })
            .from(files)
            .where(
              and(
                eq(files.workspaceId, context.workspaceId),
                eq(files.id, input.primaryPhotoFileId),
                eq(files.quarantineState, "available"),
                isNull(files.deletedAt),
              ),
            )
            .limit(1)
            .for("share");
          if (!photo)
            throw createGraphQLError(
              "VALIDATION_FAILED",
              "The selected primary photo is not available.",
            );
        }
        const [updated] = await transaction
          .update(people)
          .set({
            ...(input.primaryNameId === undefined
              ? {}
              : { primaryNameId: input.primaryNameId }),
            ...(input.primaryPhotoFileId === undefined
              ? {}
              : { primaryPhotoFileId: input.primaryPhotoFileId }),
            version: sql`${people.version} + 1`,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          })
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              eq(people.id, input.personId),
              eq(people.version, input.expectedVersion),
              isNull(people.deletedAt),
            ),
          )
          .returning();
        if (!updated) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "person.presentation.select",
          resourceKind: "person",
          resourceId: updated.id,
          sensitivity: updated.sensitivity,
          changedFields: ["primaryNameId", "primaryPhotoFileId"],
          metadata: { version: updated.version },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "person",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      if (!result) return { resource: null, issues: [], code: "CONFLICT" };
      return { resource: result, issues: [], code: null };
    },
    async listIdentityCandidates(input: { limit?: number | null } = {}) {
      if (!context.permissions.has("person:read")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "Identity candidates are not permitted.",
        );
      }
      return context.database
        .select()
        .from(identityCandidates)
        .where(
          and(
            eq(identityCandidates.workspaceId, context.workspaceId),
            isNull(identityCandidates.deletedAt),
          ),
        )
        .orderBy(
          sql`${identityCandidates.score} desc`,
          sql`${identityCandidates.createdAt} asc`,
        )
        .limit(Math.min(100, Math.max(1, input.limit ?? 25)));
    },
    async reviewIdentityCandidate(input: {
      id: string;
      expectedVersion: number;
      state: "pending" | "reviewing" | "accepted" | "rejected" | "cancelled";
      reason?: string | null;
    }) {
      if (!context.permissions.has("person:merge")) {
        throw createGraphQLError(
          "FORBIDDEN",
          "Identity candidate review is not permitted.",
        );
      }
      const [row] = await writeTransaction(context, async (transaction) =>
        transaction
          .update(identityCandidates)
          .set({
            state: input.state,
            reviewedAt: new Date(),
            reviewedBy: context.actor.principalId,
            reviewReason: input.reason?.trim().slice(0, 2048) ?? null,
            version: sql`${identityCandidates.version} + 1`,
            updatedAt: new Date(),
            updatedBy: context.actor.principalId,
          })
          .where(
            and(
              eq(identityCandidates.workspaceId, context.workspaceId),
              eq(identityCandidates.id, input.id),
              eq(identityCandidates.version, input.expectedVersion),
              isNull(identityCandidates.deletedAt),
            ),
          )
          .returning(),
      );
      if (!row)
        throw createGraphQLError(
          "CONFLICT",
          "The identity candidate changed or no longer exists.",
        );
      return row;
    },
  };
}

export type PeopleService = ReturnType<typeof createPeopleService>;
